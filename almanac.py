# -*- coding: utf-8 -*-
"""老黄历·择吉日 历法引擎（纯计算，零第三方依赖）。

历法规则
--------
- 干支纪日：JDN 锚点法。锚点 2026-11-05 = 癸未日（六十甲子序 19，甲子=0）。
- 节气时刻：太阳视黄经天文算法（Meeus 低精度法，±0.01°，时刻误差约 1 分钟量级）。
  24 节气按视黄经每 15° 一气；月建以「节」为界（立春=寅月……小寒=丑月）。
  交节日 = 节气时刻所在的公历日，当日即换月建。
- 干支纪年以立春为界（年柱/生肖随立春切换，八字正例）；月干支以节为界，月干用五虎遁。
- 十二建除：值神 = 建除[(日支序 − 月建支序) mod 12]。交节当日月建前移一位，
  公式自动得出与前一日相同的值神——这正是《协纪辨方书》「交节重复前值」的排法，
  两式恒等的证明：(b_H − (m+1)) ≡ (b_{H−1} − m) (mod 12)，因 b_H = b_{H−1}+1。
  故十二神每一位每月必出现（月段 ≥29 天 > 12），不缺「除」位，无需人工补位。
- 黄道黑道：青龙起始支序 = (月建支序×2+8) mod 12（口诀「子午临申地……」），
  值神 = 十二神[(日支序 − 青龙支序) mod 12]；时辰黄黑道同法，以日支代月建。
- 冲煞：日支六冲（支序+6）定生肖；煞方按日支三合组。「冲×(干支)」取天克地冲干支
  （戊己无天干冲，借丙壬/丁癸之对），通行黄历同此。

文化含义数据（建除宜忌、黄黑道注记、彭祖百忌、事项目录等）一律在 static/rules.json，
本文件只做算法推导。
"""
import json
import math
import os
from datetime import date, datetime, timedelta, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BASE, "static", "rules.json"), "r", encoding="utf-8") as f:
    RULES = json.load(f)

STEMS = RULES["stems"]
BRANCHES = RULES["branches"]
ZODIAC = RULES["zodiac"]
BRANCH_ELEM = RULES["branch_element"]
STEM_CLASH = RULES["stem_clash"]
JIANCHU = RULES["jianchu"]
JIANCHU_RULES = RULES["jianchu_rules"]
HUANGHEI = RULES["huanghei"]
HUANGDAO_GODS = RULES["huangdao_gods"]
HUANGHEI_NOTES = RULES["huanghei_notes"]
HUANG_EXTRA_YI = RULES["huang_extra_yi"]
HEI_EXTRA_JI = RULES["hei_extra_ji"]
LIUHE_EXTRA_YI = RULES["liuhe_extra_yi"]
PENGZU_STEM = RULES["pengzu_stem"]
PENGZU_BRANCH = RULES["pengzu_branch"]
SPECIAL_DAYS = RULES["special_days"]
HOUR_NAMES = RULES["hour_names"]
HOUR_RANGES = RULES["hour_ranges"]
EVENTS = RULES["events"]
WEEKDAYS = "一二三四五六日"

# 六合对（月建↔日支 / 日支↔生肖 用）
_LIUHE_PAIRS = [tuple(p) for p in RULES["liuhe"]]
# 三合组（日支↔生肖 用）
_SANHE_GROUPS = [tuple(g["branches"] if isinstance(g, dict) else g) for g in RULES["sanhe"]]
# 煞方：日支三合组 → 方位
_SHA_BY_BRANCH = {}
for _g in RULES["sha_groups"]:
    for _b in _g["branches"]:
        _SHA_BY_BRANCH[_b] = _g["sha"]


# ---------------------------------------------------------------- 干支纪日

def jdn(y, m, d):
    a = (14 - m) // 12
    yy, mm = y + 4800 - a, m + 12 * a - 3
    return d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045


# 锚点：2026-11-05 为癸未日（六十甲子序号 19，甲子=0）
_ANCHOR_DATE = (2026, 11, 5)
_ANCHOR_IDX = 19


def day_ganzhi_idx(y, m, d):
    return (_ANCHOR_IDX + jdn(y, m, d) - jdn(*_ANCHOR_DATE)) % 60


def day_ganzhi(y, m, d):
    """返回 (干支串, 六十序号)。"""
    i = day_ganzhi_idx(y, m, d)
    return STEMS[i % 10] + BRANCHES[i % 12], i


def clash_ganzhi(idx):
    """冲煞括号内的干支：与日干支天克地冲（支冲+6，干取对冲；戊己借丙壬/丁癸之对）。"""
    stem, branch = STEMS[idx % 10], BRANCHES[idx % 12]
    return STEM_CLASH[stem] + BRANCHES[(BRANCHES.index(branch) + 6) % 12]


def branch_clash(branch):
    """地支六冲：支序 +6。"""
    return BRANCHES[(BRANCHES.index(branch) + 6) % 12]


# ---------------------------------------------------------------- 节气（太阳视黄经，Meeus 低精度）

def _sun_lon(jd):
    t = (jd - 2451545.0) / 36525.0
    l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t
    m = math.radians(357.52911 + 35999.05029 * t - 0.0001537 * t * t)
    c = ((1.914602 - 0.004817 * t - 0.000014 * t * t) * math.sin(m)
         + (0.019993 - 0.000101 * t) * math.sin(2 * m)
         + 0.000289 * math.sin(3 * m))
    lam = l0 + c
    om = math.radians(125.04 - 1934.136 * t)
    lam -= 0.00569 + 0.00478 * math.sin(om)  # 光行差+章动修正
    return lam % 360.0


def _term_jd(year, month_hint, day_hint, target_deg):
    """求太阳视黄经到达 target_deg 的时刻（JD，UTC）。初值取当年常见节气日正午。"""
    jd = float(jdn(year, month_hint, day_hint))  # 当日 12:00 UTC
    for _ in range(8):
        diff = ((_sun_lon(jd) - target_deg + 180.0) % 360.0) - 180.0
        jd -= diff / 0.98565  # 太阳平均每日东移约 0.9856°
    return jd


# 24 节气：(黄经, 名称, 节/气, 月建支(仅节), 常见日期月/日)
_TERM_DEFS = [
    (315, "立春", "节", "寅", 2, 4), (330, "雨水", "气", None, 2, 19),
    (345, "惊蛰", "节", "卯", 3, 6), (0, "春分", "气", None, 3, 21),
    (15, "清明", "节", "辰", 4, 5), (30, "谷雨", "气", None, 4, 20),
    (45, "立夏", "节", "巳", 5, 6), (60, "小满", "气", None, 5, 21),
    (75, "芒种", "节", "午", 6, 6), (90, "夏至", "气", None, 6, 21),
    (105, "小暑", "节", "未", 7, 7), (120, "大暑", "气", None, 7, 23),
    (135, "立秋", "节", "申", 8, 8), (150, "处暑", "气", None, 8, 23),
    (165, "白露", "节", "酉", 9, 8), (180, "秋分", "气", None, 9, 23),
    (195, "寒露", "节", "戌", 10, 8), (210, "霜降", "气", None, 10, 23),
    (225, "立冬", "节", "亥", 11, 7), (240, "小雪", "气", None, 11, 22),
    (255, "大雪", "节", "子", 12, 7), (270, "冬至", "气", None, 12, 22),
    (285, "小寒", "节", "丑", 1, 6), (300, "大寒", "气", None, 1, 20),
]

_TERM_CACHE = {}


def year_terms(year, tz=8.0):
    """某公历年的 24 节气本地时刻表，按时间升序。每项 dict：
    name/kind(节|气)/branch(节的月建支)/dt(local datetime)/date((y,m,d))/time("HH:MM")。"""
    key = (year, tz)
    if key in _TERM_CACHE:
        return _TERM_CACHE[key]
    out = []
    for deg, name, kind, branch, mh, dh in _TERM_DEFS:
        jd = _term_jd(year, mh, dh, deg)
        ts = (jd - 2440587.5) * 86400.0
        dt = datetime.fromtimestamp(ts, tz=timezone(timedelta(hours=tz))).replace(tzinfo=None)
        out.append({"name": name, "kind": kind, "branch": branch, "deg": deg, "dt": dt,
                    "date": (dt.year, dt.month, dt.day),
                    "time": "%02d:%02d" % (dt.hour, dt.minute)})
    out.sort(key=lambda x: x["dt"])
    _TERM_CACHE[key] = out
    return out


def _terms_around(y, m, d, tz=8.0):
    """合并 year-1..year+1 三年的节气表，升序。"""
    out = []
    for yy in (y - 1, y, y + 1):
        out.extend(year_terms(yy, tz))
    out.sort(key=lambda x: x["dt"])
    return out


def month_jie(y, m, d, tz=8.0):
    """该日所属「月建」：civil-date 规则——交节时刻所在公历日当天即换月建。
    返回 dict(name=节名, branch=月建支, date=(y,m,d)交节日)。"""
    day_key = (y, m, d)
    best = None
    for t in _terms_around(y, m, d, tz):
        if t["kind"] != "节" or t["date"] > day_key:
            continue
        if best is None or t["date"] > best["date"]:
            best = t
    if best is None:
        raise ValueError("无法确定月建: %s" % (day_key,))
    return {"name": best["name"], "branch": best["branch"], "date": best["date"]}


def term_of_day(y, m, d, tz=8.0):
    """若当日恰为节气交节日，返回该节气 dict，否则 None。"""
    day_key = (y, m, d)
    for t in _terms_around(y, m, d, tz):
        if t["date"] == day_key:
            return t
    return None


def next_term(y, m, d, tz=8.0):
    """严格晚于 (y,m,d) 的下一个节气。返回 dict(name, date, time, days, dt)。"""
    day_key = (y, m, d)
    for t in _terms_around(y, m, d, tz):
        if t["date"] > day_key:
            days = (date(*t["date"]) - date(*day_key)).days
            return {"name": t["name"], "date": t["date"], "time": t["time"],
                    "days": days, "dt": t["dt"], "kind": t["kind"]}
    raise ValueError("找不到后续节气: %s" % (day_key,))


def special_of_day(y, m, d, tz=8.0):
    """四离四绝：四立前一日为四绝，二分二至前一日为四离。"""
    names_jue = {"立春", "立夏", "立秋", "立冬"}
    names_li = {"春分", "秋分", "夏至", "冬至"}
    tmr = (date(y, m, d) + timedelta(days=1))
    for t in _terms_around(y, m, d, tz):
        if t["date"] == (tmr.year, tmr.month, tmr.day):
            if t["name"] in names_jue:
                return "四绝"
            if t["name"] in names_li:
                return "四离"
    return None


# ---------------------------------------------------------------- 年月干支

def year_ganzhi(y, m, d, tz=8.0):
    """干支纪年以立春为界：返回 (年干支, 生肖, 公历年号)。"""
    eff = None
    for t in _terms_around(y, m, d, tz):
        if t["name"] == "立春" and t["date"] <= (y, m, d):
            if eff is None or t["date"] > eff["date"]:
                eff = t
    if eff is None:
        raise ValueError("无法确定年柱: %s" % ((y, m, d),))
    n = eff["date"][0]
    gz = STEMS[(n - 4) % 10] + BRANCHES[(n - 4) % 12]
    return gz, ZODIAC[BRANCHES.index(gz[1])], n


def month_ganzhi(y, m, d, tz=8.0):
    """月干支：月支按节，月干五虎遁（甲己年丙寅首、乙庚戊寅、丙辛庚寅、丁壬壬寅、戊癸甲寅）。
    月支距寅月的步数需对 12 取模（子/丑月跨回），再进干序。"""
    yg, _, _ = year_ganzhi(y, m, d, tz)
    mj = month_jie(y, m, d, tz)
    bidx = BRANCHES.index(mj["branch"])
    yidx = STEMS.index(yg[0])
    steps = (bidx - 2) % 12  # 距寅月的月数（寅=0，亥=9，子=10，丑=11）
    sidx = ((yidx % 5) * 2 + 2 + steps) % 10
    return STEMS[sidx] + BRANCHES[bidx]


# ---------------------------------------------------------------- 建除 / 黄黑道 / 冲煞

def jianchu_idx(y, m, d, tz=8.0):
    """十二建除：值神序 = (日支序 − 月建支序) mod 12。交节日自动重复前值（见模块说明）。"""
    _, di = day_ganzhi(y, m, d)
    mbr = month_jie(y, m, d, tz)["branch"]
    return (BRANCHES.index(BRANCHES[di % 12]) - BRANCHES.index(mbr)) % 12


def qinglong_start(branch_idx):
    """青龙起始支序 = (月建支序×2+8) mod 12（「子午临申地，丑未戌上寻……」）。"""
    return (branch_idx * 2 + 8) % 12


def huanghei_idx(day_branch_idx, month_branch_idx):
    """黄黑道十二神序 = (日支序 − 青龙支序) mod 12。"""
    return (day_branch_idx - qinglong_start(month_branch_idx)) % 12


def hour_gods(day_branch_idx):
    """时辰黄黑道：同法以日支代月建。返回 [(时支, 值神, 黄/黑)]×12。"""
    start = qinglong_start(day_branch_idx)
    out = []
    for h in range(12):
        gi = (h - start) % 12
        out.append((BRANCHES[h], HUANGHEI[gi],
                    HUANGHEI_NOTES[HUANGHEI[gi]]["tao"]))
    return out


def chongsha(y, m, d):
    """冲煞：日支六冲 → 生肖；煞方按日支三合组。"""
    _, di = day_ganzhi(y, m, d)
    br = BRANCHES[di % 12]
    cidx = (di + 6) % 12  # 六冲支
    cbr = BRANCHES[cidx % 12]
    return {
        "branch": cbr,
        "zodiac": ZODIAC[cidx % 12],
        "ganzhi": clash_ganzhi(di),
        "sha": _SHA_BY_BRANCH[br],
        "text": "冲%s（%s）煞%s" % (ZODIAC[cidx % 12], clash_ganzhi(di), _SHA_BY_BRANCH[br]),
    }


def pengzu(y, m, d):
    """彭祖百忌两条（天干 + 地支）。返回 [(短语, 全句)]。"""
    _, di = day_ganzhi(y, m, d)
    s = PENGZU_STEM[di % 10]
    b = PENGZU_BRANCH[di % 12]
    return [(s["clause"], s["full"]), (b["clause"], b["full"])]


def liuhe_with(a_branch, b_branch):
    return tuple(sorted((a_branch, b_branch))) in [tuple(sorted(p)) for p in _LIUHE_PAIRS]


def sanhe_with(a_branch, b_branch):
    return any(a_branch in g and b_branch in g for g in _SANHE_GROUPS)


# ---------------------------------------------------------------- 宜忌推导

def _derive_yiji(y, m, d, tz=8.0):
    """宜忌生成（宁缺勿滥，规则见 rules.json _meta）。"""
    _, di = day_ganzhi(y, m, d)
    stem = STEMS[di % 10]
    br = BRANCHES[di % 12]
    mj = month_jie(y, m, d, tz)
    mb = mj["branch"]
    mbi = BRANCHES.index(mb)
    jc_i = (BRANCHES.index(br) - mbi) % 12
    hh_i = huanghei_idx(BRANCHES.index(br), mbi)
    jc = JIANCHU_RULES[jc_i]
    god = HUANGHEI[hh_i]
    note = HUANGHEI_NOTES[god]

    yi = list(jc["yi"])
    ji = list(jc["ji"])
    all_bad = bool(jc.get("all_bad"))
    jishen, xiongshen = [], []

    # 黄道追加吉事 / 黑道追加忌事
    if note["tao"] == "黄":
        yi += HUANG_EXTRA_YI.get(god, [])
        jishen.append(god + "（黄道）")
    else:
        ji += HEI_EXTRA_JI.get(god, [])
        xiongshen.append(god + "（黑道）")

    # 日支与月建六合 → 「六合」吉神
    liuhe_m = liuhe_with(br, mb)
    if liuhe_m:
        yi += LIUHE_EXTRA_YI
        jishen.append("六合")

    # 彭祖百忌可对应事项 → 忌
    for p in (PENGZU_STEM[di % 10], PENGZU_BRANCH[di % 12]):
        ji += p["ji_tags"]

    # 特殊凶日
    special = special_of_day(y, m, d, tz)
    if special:
        ji += SPECIAL_DAYS["ji_tags"]
        xiongshen.append(special)
    yb = year_ganzhi(y, m, d, tz)[0][1]
    if br == branch_clash(yb):
        all_bad = True
        xiongshen.append("岁破")
    if br == branch_clash(mb):
        all_bad = True
        xiongshen.append("月破")

    if all_bad:  # 破日/岁破：诸事不宜，仅保留拆屋求医
        yi = [t for t in yi if t in ("拆破屋垣", "求医疗病")]
        ji = ["诸事不宜"] + [t for t in ji if t not in ("拆破屋垣", "求医疗病")]

    # 忌优先：同名事项从宜中删除；各自去重保序
    ji_set = list(dict.fromkeys(ji))
    yi = list(dict.fromkeys(t for t in yi if t not in ji_set))

    return {
        "yi": yi, "ji": ji_set, "all_bad": all_bad,
        "jianchu": jc["name"], "jianchu_idx": jc_i, "jianchu_note": jc["note"],
        "hh_name": god, "hh_tao": note["tao"], "hh_note": note["note"],
        "liuhe_month": liuhe_m, "special": special,
        "jishen": jishen, "xiongshen": xiongshen,
    }


# ---------------------------------------------------------------- 吉时

def lucky_hours(di, zodiac_branch=None):
    """吉时：时辰黄黑道之黄道时；可选排除冲用户生肖之时辰。di=日支序。"""
    out = []
    for br, god, tao in hour_gods(di):
        if tao != "黄":
            continue
        if zodiac_branch is not None and br == branch_clash(zodiac_branch):
            continue
        out.append({"branch": br, "name": br + "时",
                    "range": HOUR_RANGES[br], "god": god})
    return out


# ---------------------------------------------------------------- 逐日黄历

def build_day(y, m, d, tz=8.0):
    """单日完整黄历 dict（Python/JS 引擎输出逐字段一致，向量测试校验）。"""
    gz, di = day_ganzhi(y, m, d)
    ygz, zodiac, ynum = year_ganzhi(y, m, d, tz)
    mgz = month_ganzhi(y, m, d, tz)
    mj = month_jie(y, m, d, tz)
    br = BRANCHES[di % 12]
    dy = _derive_yiji(y, m, d, tz)
    tt = term_of_day(y, m, d, tz)
    nt = next_term(y, m, d, tz)
    cs = chongsha(y, m, d)
    pz = pengzu(y, m, d)
    return {
        "date": "%04d-%02d-%02d" % (y, m, d),
        "y": y, "m": m, "d": d,
        "weekday": "星期" + WEEKDAYS[date(y, m, d).weekday()],
        "day_ganzhi": gz, "day_idx": di,
        "day_stem": gz[0], "day_branch": br,
        "day_branch_element": BRANCH_ELEM[br],
        "year_ganzhi": ygz, "zodiac": zodiac, "eff_year": ynum,
        "month_ganzhi": mgz,
        "month_branch": mj["branch"], "month_term": mj["name"],
        "term_today": ({"name": tt["name"], "kind": tt["kind"], "time": tt["time"],
                        "text": "%s（%s %s）" % (tt["name"], tt["kind"], tt["time"])}
                       if tt else None),
        "next_term": {"name": nt["name"], "date": "%02d-%02d" % (nt["date"][1], nt["date"][2]),
                      "time": nt["time"], "days": nt["days"]},
        "jianchu": dy["jianchu"], "jianchu_idx": dy["jianchu_idx"],
        "jianchu_note": dy["jianchu_note"],
        "huanghei": {"name": dy["hh_name"], "tao": dy["hh_tao"], "note": dy["hh_note"]},
        "chong": cs,
        "pengzu": [pz[0][0], pz[1][0]],
        "pengzu_full": [pz[0][1], pz[1][1]],
        "yi": dy["yi"], "ji": dy["ji"], "all_bad": dy["all_bad"],
        "liuhe_month": dy["liuhe_month"],
        "special": dy["special"],
        "jishen": dy["jishen"], "xiongshen": dy["xiongshen"],
        "jishi": lucky_hours(di % 12),
    }


# 日级吉凶分类（月历配色）：bad=破日/岁破/四离四绝；good=黄道且非 bad；其余 normal
def day_grade(day):
    if day["all_bad"] or day["special"]:
        return "bad"
    if day["huanghei"]["tao"] == "黄":
        return "good"
    return "normal"


def month_grid(y, m, tz=8.0):
    """整月日历数据（含前后补位信息由前端处理）。"""
    ndays = (date(y + 1, 1, 1) - date(y, m, 1)).days if m == 12 else \
            (date(y, m + 1, 1) - date(y, m, 1)).days
    return [build_day(y, m, dd, tz) for dd in range(1, ndays + 1)]


# ---------------------------------------------------------------- 文本（喂 LLM / 复制导出）

def almanac_text(day, question=None):
    """把当日黄历渲染为文本（喂给 LLM、复制导出）。"""
    rows = []
    rows.append("【日期】%d年%d月%d日 %s" % (day["y"], day["m"], day["d"], day["weekday"]))
    rows.append("【干支】%s年（属%s） %s月 %s日" % (day["year_ganzhi"], day["zodiac"],
                                                  day["month_ganzhi"], day["day_ganzhi"]))
    rows.append("【月建】%s月（%s后）" % (day["month_branch"], day["month_term"]))
    if day["term_today"]:
        rows.append("【节气】今日%s" % day["term_today"]["text"])
    else:
        rows.append("【节气】当前%s月，下一个节气%s %s %s（%d天后）"
                    % (day["month_branch"], day["next_term"]["name"],
                       day["next_term"]["date"], day["next_term"]["time"], day["next_term"]["days"]))
    rows.append("【建除】%s日——%s" % (day["jianchu"], day["jianchu_note"]))
    rows.append("【值神】%s（%s道）——%s" % (day["huanghei"]["name"], day["huanghei"]["tao"],
                                          day["huanghei"]["note"]))
    rows.append("【冲煞】%s" % day["chong"]["text"])
    if day["jishen"]:
        rows.append("【吉神】%s" % "、".join(day["jishen"]))
    if day["xiongshen"]:
        rows.append("【凶神】%s" % "、".join(day["xiongshen"]))
    if day["special"]:
        rows.append("【凶日】今日为%s日" % day["special"])
    rows.append("【彭祖百忌】%s；%s" % (day["pengzu_full"][0], day["pengzu_full"][1]))
    rows.append("【宜】%s" % ("、".join(day["yi"]) if day["yi"] else "无"))
    rows.append("【忌】%s" % ("、".join(day["ji"]) if day["ji"] else "无"))
    rows.append("【吉时】%s" % ("、".join("%s(%s)" % (h["name"], h["range"]) for h in day["jishi"])
                              if day["jishi"] else "无"))
    if question:
        rows.append("【用户问题】%s" % question)
    return "\n".join(rows)


# ---------------------------------------------------------------- 择吉日

_EVENT_BY_ID = {e["id"]: e for e in EVENTS}


def _score_day(day, zodiac_branch=None):
    """吉日评分：黄道+2；建除吉神(成定开满)+1；月建六合+1；与用户生肖六合+2、三合+1。"""
    s = 0
    if day["huanghei"]["tao"] == "黄":
        s += 2
    if day["jianchu"] in ("成", "定", "开", "满"):
        s += 1
    if day["liuhe_month"]:
        s += 1
    if zodiac_branch is not None:
        br = day["day_branch"]
        if liuhe_with(br, zodiac_branch):
            s += 2
        elif sanhe_with(br, zodiac_branch):
            s += 1
    return s


def pick_days(start, days=90, event_id=None, zodiac_branch=None, tz=8.0):
    """择吉：start=(y,m,d) 起未来 days 天内，宜该事项且不冲用户生肖的吉日列表。

    事件可要求黄道日（require_huangdao，如剖腹产预约）。返回按日期升序，
    每项含 score/grade（≥4 最佳、2-3 优良、其余可用）与吉时。
    """
    ev = _EVENT_BY_ID.get(event_id)
    if ev is None:
        raise ValueError("未知事项: %s" % event_id)
    out = []
    d0 = date(*start)
    for off in range(1, days + 1):
        cur = d0 + timedelta(days=off)
        day = build_day(cur.year, cur.month, cur.day, tz)
        if day["all_bad"] or day["special"]:
            continue
        if not set(ev["tags"]) & set(day["yi"]):
            continue
        if ev.get("require_huangdao") and day["huanghei"]["tao"] != "黄":
            continue
        if zodiac_branch is not None and day["day_branch"] == branch_clash(zodiac_branch):
            continue
        score = _score_day(day, zodiac_branch)
        grade = "最佳" if score >= 4 else ("优良" if score >= 2 else "可用")
        out.append({
            "date": day["date"], "weekday": day["weekday"],
            "day_ganzhi": day["day_ganzhi"], "year_zodiac": day["zodiac"],
            "jianchu": day["jianchu"], "huanghei": day["huanghei"],
            "score": score, "grade": grade,
            "matched": [t for t in day["yi"] if t in ev["tags"]],
            "jishi": lucky_hours(day["day_idx"] % 12, zodiac_branch),
            "note": ev.get("note"),
        })
    return out


# ---------------------------------------------------------------- CLI（调试用）

def _cli(argv):
    if argv and len(argv) >= 3:
        y, m, d = (int(x) for x in argv[:3])
    else:
        t = datetime.now()
        y, m, d = t.year, t.month, t.day
    day = build_day(y, m, d)
    print(almanac_text(day))
    print("\n【时辰黄黑道】")
    for h, god, tao in hour_gods(day["day_idx"] % 12):
        mark = "★" if tao == "黄" else " "
        print("  %s %s时 %-4s %s(%s)" % (mark, h, god, HOUR_RANGES[h], tao))


if __name__ == "__main__":
    import sys
    _cli(sys.argv[1:])
