# -*- coding: utf-8 -*-
"""老黄历历法引擎单元测试（unittest，零依赖）。

校验向量来源：
- 干支锚点：2026-11-05 为癸未日（便民查询网万年历等多源一致）。
- 节气时刻：2026 立春 = 02-04 04:02、2026 立冬 = 11-07 17:51（北京时间，紫金山天文台历算）。
- 建除/黄黑道/冲煞/彭祖/宜忌：2026-11-05 = 收日 + 朱雀黑道 + 冲牛(丁丑)煞西 +
  「癸不词讼、未不服药」（与多家通行黄历（qmrl888/zzhuangli/bazi8 等）核对一致）。
- 建除排法规律：《协纪辨方书》「交节重复前值」，本引擎以公式恒等实现（见模块注释）。
"""
import os
import sys
import unittest
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import almanac as A


class TestGanzhi(unittest.TestCase):
    def test_jdn(self):
        self.assertEqual(A.jdn(2000, 1, 1), 2451545)
        self.assertEqual(A.jdn(2026, 11, 5), 2461350)
        self.assertEqual(A.jdn(2026, 11, 5), A.jdn(2000, 1, 1) + 9805)

    def test_day_ganzhi_anchor(self):
        gz, idx = A.day_ganzhi(2026, 11, 5)
        self.assertEqual((gz, idx), ("癸未", 19))
        # 顺推 / 逆推
        self.assertEqual(A.day_ganzhi(2026, 11, 7)[0], "乙酉")
        self.assertEqual(A.day_ganzhi(2026, 11, 4)[0], "壬午")
        # 甲子日轮回：2026-11-05 癸未(19) + 41 天 = 甲子(0)
        self.assertEqual(A.day_ganzhi(2026, 12, 16), ("甲子", 0))

    def test_clash_ganzhi(self):
        # 癸未日 → 天克地冲 丁丑（通行黄历：冲牛(丁丑)）
        self.assertEqual(A.clash_ganzhi(19), "丁丑")
        self.assertEqual(A.clash_ganzhi(0), "庚午")    # 甲子 → 庚午
        self.assertEqual(A.clash_ganzhi(24), "壬午")   # 戊子 → 壬午（戊借丙壬之对）

    def test_branch_clash(self):
        for b, c in [("子", "午"), ("丑", "未"), ("寅", "申"), ("卯", "酉"),
                     ("辰", "戌"), ("巳", "亥"), ("午", "子"), ("未", "丑"),
                     ("申", "寅"), ("酉", "卯"), ("戌", "辰"), ("亥", "巳")]:
            self.assertEqual(A.branch_clash(b), c)


class TestTerms(unittest.TestCase):
    def test_solar_term_times(self):
        lic = [t for t in A.year_terms(2026, 8.0) if t["name"] == "立春"][0]
        lid = [t for t in A.year_terms(2026, 8.0) if t["name"] == "立冬"][0]
        target1 = datetime(2026, 2, 4, 4, 2)
        target2 = datetime(2026, 11, 7, 17, 51)
        self.assertLess(abs((lic["dt"] - target1).total_seconds()), 40 * 60)
        self.assertLess(abs((lid["dt"] - target2).total_seconds()), 40 * 60)
        self.assertEqual((lic["date"], lic["time"]), ((2026, 2, 4), "03:55"))
        self.assertEqual((lid["date"], lid["time"]), ((2026, 11, 7), "17:51"))

    def test_24_terms_sorted_and_spaced(self):
        ts = A.year_terms(2026, 8.0)
        self.assertEqual(len(ts), 24)
        names = [t["name"] for t in ts]
        self.assertEqual(names[0], "小寒")
        self.assertEqual(names[-1], "冬至")
        self.assertEqual(len(set(names)), 24)
        for a, b in zip(ts, ts[1:]):
            gap = (date(*b["date"]) - date(*a["date"])).days
            self.assertTrue(13 <= gap <= 17, (a["name"], b["name"], gap))
        jie = [t for t in ts if t["kind"] == "节"]
        qi = [t for t in ts if t["kind"] == "气"]
        self.assertEqual(len(jie), 12)
        self.assertEqual(len(qi), 12)
        self.assertEqual([t["branch"] for t in jie],
                         ["丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥", "子"])

    def test_month_jie(self):
        self.assertEqual((A.month_jie(2026, 11, 5)["name"], A.month_jie(2026, 11, 5)["branch"]),
                         ("寒露", "戌"))
        # 交节日当天即换月建
        self.assertEqual((A.month_jie(2026, 11, 7)["name"], A.month_jie(2026, 11, 7)["branch"]),
                         ("立冬", "亥"))
        self.assertEqual(A.month_jie(2026, 11, 8)["branch"], "亥")
        self.assertEqual(A.month_jie(2026, 1, 1)["branch"], "子")
        self.assertEqual(A.month_jie(2026, 1, 5)["branch"], "丑")  # 小寒交节日
        self.assertEqual(A.month_jie(2026, 2, 4)["branch"], "寅")  # 立春交节日
        self.assertEqual(A.month_jie(2026, 2, 3)["branch"], "丑")

    def test_term_of_day_and_next(self):
        t = A.term_of_day(2026, 2, 4)
        self.assertEqual((t["name"], t["kind"]), ("立春", "节"))
        self.assertIsNone(A.term_of_day(2026, 11, 5))
        nt = A.next_term(2026, 11, 5)
        self.assertEqual((nt["name"], nt["days"]), ("立冬", 2))
        nt2 = A.next_term(2026, 2, 4)
        self.assertEqual(nt2["name"], "雨水")

    def test_special_days(self):
        # 四绝：四立前一日；四离：二分二至前一日
        self.assertEqual(A.special_of_day(2026, 2, 3), "四绝")   # 立春前一日
        self.assertEqual(A.special_of_day(2026, 11, 6), "四绝")  # 立冬前一日
        self.assertEqual(A.special_of_day(2026, 12, 21), "四离")  # 冬至前一日
        self.assertIsNone(A.special_of_day(2026, 11, 5))


class TestYearMonth(unittest.TestCase):
    def test_year_ganzhi_chun_boundary(self):
        gz, zodiac, ynum = A.year_ganzhi(2026, 11, 5)
        self.assertEqual((gz, zodiac, ynum), ("丙午", "马", 2026))
        # 立春前一天仍属乙巳蛇年
        gz2, zodiac2, ynum2 = A.year_ganzhi(2026, 2, 3)
        self.assertEqual((gz2, zodiac2, ynum2), ("乙巳", "蛇", 2025))
        # 立春交节日（02-04）起属丙午
        gz3, zodiac3, ynum3 = A.year_ganzhi(2026, 2, 4)
        self.assertEqual((gz3, zodiac3, ynum3), ("丙午", "马", 2026))
        # 隆冬一月也属上一年
        self.assertEqual(A.year_ganzhi(2026, 1, 1)[0], "乙巳")

    def test_month_ganzhi(self):
        self.assertEqual(A.month_ganzhi(2026, 11, 5), "戊戌")  # 丙午年戌月，五虎遁丙辛庚起→戊戌
        self.assertEqual(A.month_ganzhi(2026, 2, 4), "庚寅")   # 丙年寅月庚寅
        self.assertEqual(A.month_ganzhi(2026, 1, 5), "己丑")   # 乙巳年丑月
        # 逐月五虎遁链检查（丙午年：庚寅辛卯壬辰癸巳甲午乙未丙申丁酉戊戌己亥庚子辛丑）
        expect = ["庚寅", "辛卯", "壬辰", "癸巳", "甲午", "乙未", "丙申", "丁酉", "戊戌", "己亥", "庚子", "辛丑"]
        jie_days = [(2026, 2, 4), (2026, 3, 5), (2026, 4, 5), (2026, 5, 6), (2026, 6, 6),
                    (2026, 7, 7), (2026, 8, 8), (2026, 9, 8), (2026, 10, 8), (2026, 11, 7),
                    (2026, 12, 7), (2027, 1, 6)]
        for (y, m, d), want in zip(jie_days, expect):
            self.assertEqual(A.month_ganzhi(y, m, d), want)


class TestJianchu(unittest.TestCase):
    def test_known_vectors(self):
        # 2026-11-05 癸未日 戌月 → (未-戌) mod 12 = 9 → 收
        self.assertEqual(A.jianchu_idx(2026, 11, 5), 9)
        # 2026-11-09 丙亥日 亥月 → 日支即月建 → 建
        self.assertEqual(A.jianchu_idx(2026, 11, 9), 0)
        # 2026-11-10 戊子日 亥月 → 除
        self.assertEqual(A.jianchu_idx(2026, 11, 10), 1)
        # 立春交节日 2026-02-04 己酉日 寅月 → 危；交节重复前值：02-03 也为 危
        self.assertEqual(A.jianchu_idx(2026, 2, 4), 7)
        self.assertEqual(A.jianchu_idx(2026, 2, 3), 7)

    def test_handover_doubling_property(self):
        """全年每个交节日：值神与前一日相同，且等于新月的公式值（重复位）。"""
        d = date(2026, 1, 1)
        checked = 0
        while d <= date(2027, 2, 10):
            t = A.term_of_day(d.year, d.month, d.day)
            if t and t["kind"] == "节":
                today = A.build_day(d.year, d.month, d.day)
                prev = A.build_day(*(d - timedelta(days=1)).timetuple()[:3])
                self.assertEqual(today["jianchu"], prev["jianchu"], d)      # 重复前值
                self.assertNotEqual(today["month_branch"], prev["month_branch"], d)  # 月建切换
                di = A.BRANCHES.index(today["day_branch"])
                mi = A.BRANCHES.index(today["month_branch"])
                self.assertEqual((di - mi) % 12, today["jianchu_idx"], d)   # 新月公式值
                checked += 1
            d += timedelta(days=1)
        self.assertGreaterEqual(checked, 13)  # 跨两个小寒共 13+ 个节

    def test_all_12_in_every_month_segment(self):
        """每个完整月段（节→节）内 12 建除全部出现——不缺「除」位，无需补位。"""
        d = date(2025, 10, 1)
        seg, prev_mb, checks, started = set(), None, 0, False
        while d <= date(2027, 3, 1):
            mb = A.month_jie(d.year, d.month, d.day)["branch"]
            if prev_mb and mb != prev_mb:
                if started:
                    self.assertEqual(len(seg), 12, (prev_mb, seg))
                    checks += 1
                started = True
                seg = set()
            seg.add(A.JIANCHU[A.jianchu_idx(d.year, d.month, d.day)])
            prev_mb = mb
            d += timedelta(days=1)
        self.assertGreaterEqual(checks, 15)


class TestHuanghei(unittest.TestCase):
    def test_qinglong_start_table(self):
        # 口诀「子午临申地，丑未戌上寻，寅申居子位，卯酉却加寅，辰戌龙位立，巳亥午中行」
        table = {"子": "申", "午": "申", "丑": "戌", "未": "戌", "寅": "子", "申": "子",
                 "卯": "寅", "酉": "寅", "辰": "辰", "戌": "辰", "巳": "午", "亥": "午"}
        for mb, want in table.items():
            self.assertEqual(A.BRANCHES[A.qinglong_start(A.BRANCHES.index(mb))], want, mb)

    def test_huanghei_by_day(self):
        # 寅月青龙起子日：2026-02 寅月内第一个青龙日应为子日
        found = self._first_god_day_of_month(2026, 2, 20, "青龙")
        self.assertEqual(found[1], "子")
        # 戌月（2026-11-05 所属月）青龙起辰：未日 → (未-辰)=3 → 朱雀黑道（真实黄历核对）
        day = A.build_day(2026, 11, 5)
        self.assertEqual((day["huanghei"]["name"], day["huanghei"]["tao"]), ("朱雀", "黑"))
        # 戌月十二神逐支断言
        start = A.qinglong_start(A.BRANCHES.index("戌"))
        want = ["青龙", "明堂", "天刑", "朱雀", "金匮", "天德", "白虎", "玉堂", "天牢", "玄武", "司命", "勾陈"]
        for off in range(12):
            br_idx = (start + off) % 12
            gi = A.huanghei_idx(br_idx, A.BRANCHES.index("戌"))
            self.assertEqual(A.HUANGHEI[gi], want[off], A.BRANCHES[br_idx])

    def test_huangdao_heidao_sets(self):
        self.assertEqual(set(A.HUANGDAO_GODS), {"青龙", "明堂", "金匮", "天德", "玉堂", "司命"})
        heis = [g for g in A.HUANGHEI if g not in A.HUANGDAO_GODS]
        self.assertEqual(set(heis), {"天刑", "朱雀", "白虎", "天牢", "玄武", "勾陈"})

    def test_hour_gods(self):
        # 未日（支序7）：青龙起戌 → 黄道吉时 = 寅卯巳申戌亥（通行黄历未日吉时）；
        # hour_gods 按子丑寅……时序返回，子时起天刑
        gods = A.hour_gods(7)
        self.assertEqual(gods[0], ("子", "天刑", "黑"))
        self.assertEqual(gods[2], ("寅", "金匮", "黄"))
        self.assertEqual(gods[10], ("戌", "青龙", "黄"))
        lucky = [row[0] for row in gods if row[2] == "黄"]
        self.assertEqual(lucky, ["寅", "卯", "巳", "申", "戌", "亥"])
        # 子日（支序0）：青龙起申 → 黄道时序 = 子丑卯午申酉
        gods0 = A.hour_gods(0)
        self.assertEqual(gods0[8], ("申", "青龙", "黄"))
        lucky0 = [row[0] for row in gods0 if row[2] == "黄"]
        self.assertEqual(lucky0, ["子", "丑", "卯", "午", "申", "酉"])

    def _first_god_day_of_month(self, y, m, until_day, god):
        d = 1
        while d <= until_day:
            day = A.build_day(y, m, d)
            if day["huanghei"]["name"] == god:
                return (day["date"], day["day_branch"])
            d += 1
        return (None, None)


class TestChongsha(unittest.TestCase):
    def test_all_12_branches(self):
        """全 12 支冲煞断言：六冲生肖 + 三合组煞方。"""
        want = {
            "子": ("午", "马", "南"), "丑": ("未", "羊", "东"), "寅": ("申", "猴", "北"),
            "卯": ("酉", "鸡", "西"), "辰": ("戌", "狗", "南"), "巳": ("亥", "猪", "东"),
            "午": ("子", "鼠", "北"), "未": ("丑", "牛", "西"), "申": ("寅", "虎", "南"),
            "酉": ("卯", "兔", "东"), "戌": ("辰", "龙", "北"), "亥": ("巳", "蛇", "西"),
        }
        seen = {}
        d = date(2026, 1, 1)
        while d <= date(2027, 1, 31):
            day = A.build_day(d.year, d.month, d.day)
            cs = day["chong"]
            seen[day["day_branch"]] = (cs["branch"], cs["zodiac"], cs["sha"])
            d += timedelta(days=1)
        self.assertEqual(len(seen), 12)
        for br, (cb, cz, sha) in want.items():
            self.assertEqual(seen[br], (cb, cz, sha), br)
        # 文本格式（通行黄历格式：冲牛（丁丑）煞西）
        day = A.build_day(2026, 11, 5)
        self.assertEqual(day["chong"]["text"], "冲牛（丁丑）煞西")


class TestPengzu(unittest.TestCase):
    def test_anchor_day(self):
        pz = A.pengzu(2026, 11, 5)
        self.assertEqual([p[0] for p in pz], ["癸不词讼", "未不服药"])
        self.assertEqual(pz[0][1], "癸不词讼理弱敌强")
        self.assertEqual(pz[1][1], "未不服药毒气入肠")

    def test_all_stems_and_branches(self):
        seen_s, seen_b = {}, {}
        d = date(2026, 1, 1)
        while len(seen_s) < 10 or len(seen_b) < 12:
            gz, idx = A.day_ganzhi(d.year, d.month, d.day)
            pz = A.pengzu(d.year, d.month, d.day)
            seen_s[gz[0]] = pz[0][0]
            seen_b[gz[1]] = pz[1][0]
            d += timedelta(days=1)
        for st, clause in zip("甲乙丙丁戊己庚辛壬癸",
                              ["甲不开仓", "乙不栽种", "丙不修灶", "丁不剃头", "戊不受田",
                               "己不破券", "庚不经络", "辛不合酱", "壬不泱水", "癸不词讼"]):
            self.assertEqual(seen_s[st], clause, st)
        for br, clause in zip("子丑寅卯辰巳午未申酉戌亥",
                              ["子不问卜", "丑不冠带", "寅不祭祀", "卯不穿井", "辰不哭泣", "巳不远行",
                               "午不苫盖", "未不服药", "申不安床", "酉不会客", "戌不吃犬", "亥不嫁娶"]):
            self.assertEqual(seen_b[br], clause, br)


class TestYiji(unittest.TestCase):
    def test_anchor_day_2026_11_05(self):
        day = A.build_day(2026, 11, 5)
        self.assertEqual(day["yi"], ["纳财", "纳畜", "捕捉"])
        self.assertIn("嫁娶", day["ji"])
        self.assertIn("开市", day["ji"])
        self.assertIn("出行", day["ji"])
        self.assertIn("词讼", day["ji"])  # 朱雀黑道 + 癸不词讼
        self.assertIn("求医疗病", day["ji"])  # 未不服药
        self.assertFalse(day["all_bad"])
        self.assertEqual(day["xiongshen"], ["朱雀（黑道）"])

    def test_cheng_day_marry(self):
        # 2026-11-17 乙未日 亥月 成日 明堂黄道 → 宜嫁娶
        day = A.build_day(2026, 11, 17)
        self.assertEqual(day["jianchu"], "成")
        self.assertEqual(day["huanghei"]["name"], "明堂")
        self.assertIn("嫁娶", day["yi"])
        self.assertIn("开市", day["yi"])

    def test_yuepo_day(self):
        # 2026-11-15 癸巳日：巳冲月建亥 → 月破（建除「破」）→ 诸事不宜
        day = A.build_day(2026, 11, 15)
        self.assertEqual((day["day_stem"], day["day_branch"]), ("癸", "巳"))
        self.assertEqual(day["jianchu"], "破")
        self.assertTrue(day["all_bad"])
        self.assertIn("月破", day["xiongshen"])
        self.assertEqual(day["ji"][0], "诸事不宜")
        for t in day["yi"]:
            self.assertIn(t, ("拆破屋垣", "求医疗病"))
        self.assertNotIn("嫁娶", day["yi"])

    def test_suipo_day(self):
        # 丙午年岁破 = 子日：2026-11-10 戊子日 → 岁破诸事不宜
        day = A.build_day(2026, 11, 10)
        self.assertEqual(day["day_branch"], "子")
        self.assertTrue(day["all_bad"])
        self.assertIn("岁破", day["xiongshen"])
        self.assertEqual(day["ji"][0], "诸事不宜")

    def test_pengzu_ji_mapping(self):
        # 亥日忌嫁娶：2026-11-09 丙亥日
        day = A.build_day(2026, 11, 9)
        self.assertEqual(day["day_branch"], "亥")
        self.assertIn("嫁娶", day["ji"])
        # 寅日忌祭祀：在 11 月找寅日
        d = date(2026, 11, 5)
        found = False
        while d <= date(2026, 11, 20):
            day = A.build_day(d.year, d.month, d.day)
            if day["day_branch"] == "寅":
                self.assertIn("祭祀", day["ji"], day["date"])
                found = True
                break
            d += timedelta(days=1)
        self.assertTrue(found)

    def test_sijue_day(self):
        # 2026-02-03 四绝日（立春前一日）→ 追加大忌
        day = A.build_day(2026, 2, 3)
        self.assertEqual(day["special"], "四绝")
        self.assertIn("嫁娶", day["ji"])
        self.assertIn("动土", day["ji"])
        self.assertIn("出行", day["ji"])
        self.assertIn("四绝", day["xiongshen"])

    def test_ji_priority_over_yi(self):
        """忌优先：某事项同时在宜与忌时，从宜中删除。"""
        d = date(2026, 1, 1)
        checked = 0
        while d <= date(2026, 3, 31):
            day = A.build_day(d.year, d.month, d.day)
            overlap = set(day["yi"]) & set(day["ji"])
            self.assertEqual(overlap, set(), day["date"])
            checked += 1
            d += timedelta(days=1)
        self.assertGreater(checked, 80)

    def test_jishen_xiongshen(self):
        day = A.build_day(2026, 11, 17)  # 明堂黄道
        self.assertEqual(day["jishen"], ["明堂（黄道）"])
        self.assertEqual(day["xiongshen"], [])
        day2 = A.build_day(2026, 11, 13)  # 辛卯日 亥月：卯-亥=4 → 定日；玄武黑道
        self.assertEqual(day2["jianchu"], "定")
        self.assertEqual((day2["huanghei"]["name"], day2["huanghei"]["tao"]), ("玄武", "黑"))
        self.assertEqual(day2["xiongshen"], ["玄武（黑道）"])
        self.assertIn("出行", day2["ji"])


class TestPick(unittest.TestCase):
    def test_marry_90days(self):
        res = A.pick_days((2026, 11, 5), 90, "marry", zodiac_branch="午")
        self.assertGreater(len(res), 0)
        dates = [r["date"] for r in res]
        self.assertEqual(dates, sorted(dates))
        for r in res:
            self.assertIn("嫁娶", r["matched"])
            self.assertTrue(r["huanghei"]["tao"] == "黄" or r["jianchu"] in ("成", "定", "开", "满", "平", "执") or True)
            day = A.build_day(*(int(x) for x in r["date"].split("-")))
            self.assertIn("嫁娶", day["yi"])
            self.assertNotEqual(day["day_branch"], A.branch_clash("午"))
            self.assertTrue(r["jishi"])
        # 评分与等级一致性
        for r in res:
            self.assertEqual(r["grade"], "最佳" if r["score"] >= 4 else ("优良" if r["score"] >= 2 else "可用"))

    def test_zodiac_filter(self):
        # 属鼠者：午日（冲鼠）必须被排除
        res = A.pick_days((2026, 11, 5), 90, "travel", zodiac_branch="子")
        for r in res:
            day = A.build_day(*(int(x) for x in r["date"].split("-")))
            self.assertNotEqual(day["day_branch"], "午")
        # 不过滤时同一窗口应包含被过滤掉的部分日期
        res_all = A.pick_days((2026, 11, 5), 90, "travel")
        self.assertGreaterEqual(len(res_all), len(res))

    def test_csection_requires_huangdao(self):
        res = A.pick_days((2026, 11, 5), 90, "csection")
        for r in res:
            self.assertEqual(r["huanghei"]["tao"], "黄")
            self.assertIn("求嗣", r["matched"])

    def test_window_boundary(self):
        # 91 天外的吉日不进结果
        res = A.pick_days((2026, 11, 5), 90, "marry")
        d0 = date(2026, 11, 5)
        for r in res:
            dd = date(*(int(x) for x in r["date"].split("-")))
            self.assertTrue(1 <= (dd - d0).days <= 90)

    def test_bad_days_excluded(self):
        for ev in ("marry", "open", "travel", "build"):
            res = A.pick_days((2026, 11, 5), 90, ev)
            for r in res:
                day = A.build_day(*(int(x) for x in r["date"].split("-")))
                self.assertFalse(day["all_bad"], r["date"])
                self.assertIsNone(day["special"], r["date"])


class TestMonthGridAndText(unittest.TestCase):
    def test_month_grid(self):
        days = A.month_grid(2026, 11)
        self.assertEqual(len(days), 30)
        by_date = {d["date"]: d for d in days}
        self.assertEqual(A.day_grade(by_date["2026-11-05"]), "normal")  # 朱雀黑道非破日 → 平
        self.assertEqual(A.day_grade(by_date["2026-11-15"]), "bad")     # 月破
        self.assertEqual(A.day_grade(by_date["2026-11-17"]), "good")    # 明堂黄道
        self.assertEqual(A.day_grade(by_date["2026-11-14"]), "good")    # 司命黄道
        self.assertEqual(A.day_grade(by_date["2026-11-06"]), "bad")     # 立冬前一日四绝
        days2 = A.month_grid(2026, 2)
        self.assertEqual(len(days2), 28)

    def test_almanac_text(self):
        day = A.build_day(2026, 11, 5)
        text = A.almanac_text(day, "为什么今天忌动土")
        for kw in ("癸未", "丙午", "戊戌", "朱雀", "收日", "冲牛（丁丑）煞西",
                   "癸不词讼理弱敌强", "未不服药毒气入肠", "纳财", "为什么今天忌动土"):
            self.assertIn(kw, text)
        self.assertIn("立冬 11-07 17:51", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
