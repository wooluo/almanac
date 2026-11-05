/* 老黄历·择吉日 引擎 · almanac.py 的 JS 移植（输出与 Python 版逐字段一致，向量测试校验）。
 * 挂载为全局 Almanac，供网页与安卓（Capacitor）复用。
 *
 * 用法：先 Almanac.init(rulesJson) 注入 static/rules.json 数据，再调用 buildDay 等。
 * 历法算法说明见 almanac.py 模块头注释（两引擎共用同一套规则与算法）。 */
(function (global) {
  "use strict";

  var R = null;           // rules.json（Almanac.init 注入）
  var API = null;         // 导出对象（init 时回填 rules 引用）
  var STEMS, BRANCHES, ZODIAC, BRANCH_ELEM, STEM_CLASH;
  var JIANCHU, JIANCHU_RULES, HUANGHEI, HUANGDAO_GODS, HUANGHEI_NOTES;
  var HUANG_EXTRA_YI, HEI_EXTRA_JI, LIUHE_EXTRA_YI;
  var PENGZU_STEM, PENGZU_BRANCH, SPECIAL_DAYS, HOUR_NAMES, HOUR_RANGES, EVENTS;
  var WEEKDAYS = "一二三四五六日";
  var LIUHE_SET = null;   // 排序后的六合对集合
  var SANHE_GROUPS = null;
  var SHA_BY_BRANCH = null;

  function init(rules) {
    R = rules;
    if (API) API.rules = rules;   // 供前端读取事项目录等数据
    STEMS = R.stems; BRANCHES = R.branches; ZODIAC = R.zodiac;
    BRANCH_ELEM = R.branch_element; STEM_CLASH = R.stem_clash;
    JIANCHU = R.jianchu; JIANCHU_RULES = R.jianchu_rules;
    HUANGHEI = R.huanghei; HUANGDAO_GODS = R.huangdao_gods;
    HUANGHEI_NOTES = R.huanghei_notes;
    HUANG_EXTRA_YI = R.huang_extra_yi; HEI_EXTRA_JI = R.hei_extra_ji;
    LIUHE_EXTRA_YI = R.liuhe_extra_yi;
    PENGZU_STEM = R.pengzu_stem; PENGZU_BRANCH = R.pengzu_branch;
    SPECIAL_DAYS = R.special_days; HOUR_NAMES = R.hour_names;
    HOUR_RANGES = R.hour_ranges; EVENTS = R.events;
    LIUHE_SET = {};
    R.liuhe.forEach(function (p) { LIUHE_SET[[p[0], p[1]].sort().join("|")] = true; });
    SANHE_GROUPS = R.sanhe.map(function (g) { return g.branches || g; });
    SHA_BY_BRANCH = {};
    R.sha_groups.forEach(function (g) {
      (g.branches || []).forEach(function (b) { SHA_BY_BRANCH[b] = g.sha; });
    });
  }

  function requireInit() { if (!R) throw new Error("请先调用 Almanac.init(rules)"); }

  // ---------------- 干支纪日（JDN 锚点法，2026-11-05 癸未=19） ----------------
  function jdn(y, m, d) {
    var a = Math.floor((14 - m) / 12);
    var yy = y + 4800 - a, mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
      + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  }

  function jdnToYmd(j) {  // JDN → 公历 (y,m,d)
    var a = j + 32044, b = Math.floor((4 * a + 3) / 146097);
    var c = a - Math.floor(146097 * b / 4), dd = Math.floor((4 * c + 3) / 1461);
    var e = c - Math.floor(1461 * dd / 4), mm = Math.floor((5 * e + 2) / 153);
    return { y: 100 * b + dd - 4800 + Math.floor(mm / 10), m: mm + 3 - 12 * Math.floor(mm / 10), d: e - Math.floor((153 * mm + 2) / 5) + 1 };
  }

  var ANCHOR = { y: 2026, m: 11, d: 5, idx: 19 };

  function dayGanzhiIdx(y, m, d) {
    var diff = (jdn(y, m, d) - jdn(ANCHOR.y, ANCHOR.m, ANCHOR.d) + ANCHOR.idx) % 60;
    return ((diff % 60) + 60) % 60;
  }

  function dayGanzhi(y, m, d) {
    var i = dayGanzhiIdx(y, m, d);
    return { gz: STEMS[i % 10] + BRANCHES[i % 12], idx: i };
  }

  function clashGanzhi(idx) {  // 冲煞括号内干支：天克地冲（戊己借丙壬/丁癸之对）
    var stem = STEMS[idx % 10], branch = BRANCHES[idx % 12];
    return STEM_CLASH[stem] + BRANCHES[(BRANCHES.indexOf(branch) + 6) % 12];
  }

  function branchClash(branch) { return BRANCHES[(BRANCHES.indexOf(branch) + 6) % 12]; }

  // ---------------- 节气（太阳视黄经，Meeus 低精度） ----------------
  function sunLon(jd) {
    var t = (jd - 2451545.0) / 36525.0;
    var l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
    var m = (357.52911 + 35999.05029 * t - 0.0001537 * t * t) * Math.PI / 180;
    var c = (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m)
      + (0.019993 - 0.000101 * t) * Math.sin(2 * m) + 0.000289 * Math.sin(3 * m);
    var lam = l0 + c;
    var om = (125.04 - 1934.136 * t) * Math.PI / 180;
    lam -= 0.00569 + 0.00478 * Math.sin(om);
    return ((lam % 360) + 360) % 360;
  }

  function termJD(year, mh, dh, deg) {
    var jd = jdn(year, mh, dh) + 0.0;
    for (var i = 0; i < 8; i++) {
      var diff = ((sunLon(jd) - deg + 180) % 360 + 360) % 360 - 180;
      jd -= diff / 0.98565;
    }
    return jd;
  }

  var TERM_DEFS = [
    { deg: 315, name: "立春", kind: "节", branch: "寅", mh: 2, dh: 4 },
    { deg: 330, name: "雨水", kind: "气", branch: null, mh: 2, dh: 19 },
    { deg: 345, name: "惊蛰", kind: "节", branch: "卯", mh: 3, dh: 6 },
    { deg: 0, name: "春分", kind: "气", branch: null, mh: 3, dh: 21 },
    { deg: 15, name: "清明", kind: "节", branch: "辰", mh: 4, dh: 5 },
    { deg: 30, name: "谷雨", kind: "气", branch: null, mh: 4, dh: 20 },
    { deg: 45, name: "立夏", kind: "节", branch: "巳", mh: 5, dh: 6 },
    { deg: 60, name: "小满", kind: "气", branch: null, mh: 5, dh: 21 },
    { deg: 75, name: "芒种", kind: "节", branch: "午", mh: 6, dh: 6 },
    { deg: 90, name: "夏至", kind: "气", branch: null, mh: 6, dh: 21 },
    { deg: 105, name: "小暑", kind: "节", branch: "未", mh: 7, dh: 7 },
    { deg: 120, name: "大暑", kind: "气", branch: null, mh: 7, dh: 23 },
    { deg: 135, name: "立秋", kind: "节", branch: "申", mh: 8, dh: 8 },
    { deg: 150, name: "处暑", kind: "气", branch: null, mh: 8, dh: 23 },
    { deg: 165, name: "白露", kind: "节", branch: "酉", mh: 9, dh: 8 },
    { deg: 180, name: "秋分", kind: "气", branch: null, mh: 9, dh: 23 },
    { deg: 195, name: "寒露", kind: "节", branch: "戌", mh: 10, dh: 8 },
    { deg: 210, name: "霜降", kind: "气", branch: null, mh: 10, dh: 23 },
    { deg: 225, name: "立冬", kind: "节", branch: "亥", mh: 11, dh: 7 },
    { deg: 240, name: "小雪", kind: "气", branch: null, mh: 11, dh: 22 },
    { deg: 255, name: "大雪", kind: "节", branch: "子", mh: 12, dh: 7 },
    { deg: 270, name: "冬至", kind: "气", branch: null, mh: 12, dh: 22 },
    { deg: 285, name: "小寒", kind: "节", branch: "丑", mh: 1, dh: 6 },
    { deg: 300, name: "大寒", kind: "气", branch: null, mh: 1, dh: 20 }
  ];

  var TERM_CACHE = {};

  function yearTerms(year, tz) {  // 某公历年 24 节气，升序；dt 为本地 {y,m,d,h,min}
    var key = year + "@" + tz;
    if (TERM_CACHE[key]) return TERM_CACHE[key];
    var out = [];
    TERM_DEFS.forEach(function (t) {
      var ts = (termJD(year, t.mh, t.dh, t.deg) - 2440587.5) * 86400 + tz * 3600;
      var dt = new Date(ts * 1000);
      out.push({
        name: t.name, kind: t.kind, branch: t.branch, deg: t.deg,
        y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
        h: dt.getUTCHours(), min: dt.getUTCMinutes(),
        date: null, time: null
      });
    });
    out.forEach(function (t) {
      t.date = [t.y, t.m, t.d];
      t.time = pad2(t.h) + ":" + pad2(t.min);
    });
    out.sort(function (a, b) { return cmpDate(a.date, b.date) || (a.h - b.h) || (a.min - b.min); });
    TERM_CACHE[key] = out;
    return out;
  }

  function cmpDate(a, b) {  // [y,m,d] 比较
    return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  }

  function termsAround(y, m, d, tz) {
    var out = [];
    [y - 1, y, y + 1].forEach(function (yy) {
      yearTerms(yy, tz).forEach(function (t) { out.push(t); });
    });
    out.sort(function (a, b) { return cmpDate(a.date, b.date) || (a.h - b.h) || (a.min - b.min); });
    return out;
  }

  function monthJie(y, m, d, tz) {  // 月建：交节时刻所在公历日当天即换月建
    var dayKey = [y, m, d], best = null;
    termsAround(y, m, d, tz).forEach(function (t) {
      if (t.kind !== "节" || cmpDate(t.date, dayKey) > 0) return;
      if (!best || cmpDate(t.date, best.date) > 0) best = t;
    });
    if (!best) throw new Error("无法确定月建");
    return { name: best.name, branch: best.branch, date: best.date };
  }

  function termOfDay(y, m, d, tz) {
    var dayKey = [y, m, d], found = null;
    termsAround(y, m, d, tz).forEach(function (t) {
      if (cmpDate(t.date, dayKey) === 0) found = t;
    });
    return found;
  }

  function nextTerm(y, m, d, tz) {
    var dayKey = [y, m, d];
    for (var i = 0; i < termsAround(y, m, d, tz).length; i++) {
      var t = termsAround(y, m, d, tz)[i];
      if (cmpDate(t.date, dayKey) > 0) {
        return { name: t.name, date: t.date, time: t.time,
                 days: jdn(t.date[0], t.date[1], t.date[2]) - jdn(y, m, d),
                 kind: t.kind };
      }
    }
    throw new Error("找不到后续节气");
  }

  function specialOfDay(y, m, d, tz) {  // 四离四绝：四立前一日四绝，二分二至前一日四离
    var jue = { 立春: 1, 立夏: 1, 立秋: 1, 立冬: 1 };
    var li = { 春分: 1, 秋分: 1, 夏至: 1, 冬至: 1 };
    var tmr = jdnToYmd(jdn(y, m, d) + 1);
    var found = null;
    termsAround(y, m, d, tz).forEach(function (t) {
      if (cmpDate(t.date, [tmr.y, tmr.m, tmr.d]) === 0) {
        if (jue[t.name]) found = "四绝";
        else if (li[t.name]) found = "四离";
      }
    });
    return found;
  }

  // ---------------- 年月干支 ----------------
  function yearGanzhi(y, m, d, tz) {  // 以立春为界
    var eff = null;
    termsAround(y, m, d, tz).forEach(function (t) {
      if (t.name === "立春" && cmpDate(t.date, [y, m, d]) <= 0) {
        if (!eff || cmpDate(t.date, eff.date) > 0) eff = t;
      }
    });
    if (!eff) throw new Error("无法确定年柱");
    var n = eff.date[0];
    var gz = STEMS[(n - 4) % 10] + BRANCHES[(n - 4) % 12];
    return { gz: gz, zodiac: ZODIAC[BRANCHES.indexOf(gz[1])], year: n };
  }

  function monthGanzhi(y, m, d, tz) {  // 月支按节，月干五虎遁（子/丑月步数先对 12 取模）
    var yg = yearGanzhi(y, m, d, tz).gz;
    var mj = monthJie(y, m, d, tz);
    var bidx = BRANCHES.indexOf(mj.branch);
    var yidx = STEMS.indexOf(yg[0]);
    var steps = ((bidx - 2) % 12 + 12) % 12;  // 距寅月的月数（寅=0，亥=9，子=10，丑=11）
    var sidx = (((yidx % 5) * 2 + 2 + steps) % 10 + 10) % 10;
    return STEMS[sidx] + BRANCHES[bidx];
  }

  // ---------------- 建除 / 黄黑道 / 冲煞 ----------------
  function jianchuIdx(y, m, d, tz) {
    var di = dayGanzhiIdx(y, m, d);
    var mb = monthJie(y, m, d, tz).branch;
    return ((di % 12) - BRANCHES.indexOf(mb) + 12) % 12;
  }

  function qinglongStart(branchIdx) { return (branchIdx * 2 + 8) % 12; }

  function huangheiIdx(dayBranchIdx, monthBranchIdx) {
    return ((dayBranchIdx - qinglongStart(monthBranchIdx)) % 12 + 12) % 12;
  }

  function hourGods(dayBranchIdx) {
    var start = qinglongStart(dayBranchIdx), out = [];
    for (var h = 0; h < 12; h++) {
      var gi = ((h - start) % 12 + 12) % 12;
      out.push([BRANCHES[h], HUANGHEI[gi], HUANGHEI_NOTES[HUANGHEI[gi]].tao]);
    }
    return out;
  }

  function chongsha(y, m, d) {
    var di = dayGanzhiIdx(y, m, d);
    var br = BRANCHES[di % 12];
    var cidx = (di + 6) % 12;
    var cbr = BRANCHES[cidx % 12];
    return {
      branch: cbr, zodiac: ZODIAC[cidx % 12],
      ganzhi: clashGanzhi(di), sha: SHA_BY_BRANCH[br],
      text: "冲" + ZODIAC[cidx % 12] + "（" + clashGanzhi(di) + "）煞" + SHA_BY_BRANCH[br]
    };
  }

  function pengzu(y, m, d) {
    var di = dayGanzhiIdx(y, m, d);
    return [
      [PENGZU_STEM[di % 10].clause, PENGZU_STEM[di % 10].full],
      [PENGZU_BRANCH[di % 12].clause, PENGZU_BRANCH[di % 12].full]
    ];
  }

  function liuheWith(a, b) { return !!LIUHE_SET[[a, b].sort().join("|")]; }
  function sanheWith(a, b) {
    return SANHE_GROUPS.some(function (g) { return g.indexOf(a) >= 0 && g.indexOf(b) >= 0; });
  }

  // ---------------- 宜忌推导（宁缺勿滥，规则见 rules.json _meta） ----------------
  function deriveYiji(y, m, d, tz) {
    var di = dayGanzhiIdx(y, m, d);
    var stem = STEMS[di % 10], br = BRANCHES[di % 12];
    var mj = monthJie(y, m, d, tz), mb = mj.branch;
    var mbi = BRANCHES.indexOf(mb);
    var jcI = ((di % 12) - mbi + 12) % 12;
    var hhI = huangheiIdx(di % 12, mbi);
    var jc = JIANCHU_RULES[jcI];
    var god = HUANGHEI[hhI], note = HUANGHEI_NOTES[god];

    var yi = jc.yi.slice(), ji = jc.ji.slice();
    var allBad = !!jc.all_bad;
    var jishen = [], xiongshen = [];

    if (note.tao === "黄") {
      (HUANG_EXTRA_YI[god] || []).forEach(function (t) { yi.push(t); });
      jishen.push(god + "（黄道）");
    } else {
      (HEI_EXTRA_JI[god] || []).forEach(function (t) { ji.push(t); });
      xiongshen.push(god + "（黑道）");
    }

    var liuheM = liuheWith(br, mb);
    if (liuheM) {
      LIUHE_EXTRA_YI.forEach(function (t) { yi.push(t); });
      jishen.push("六合");
    }

    [PENGZU_STEM[di % 10], PENGZU_BRANCH[di % 12]].forEach(function (p) {
      p.ji_tags.forEach(function (t) { ji.push(t); });
    });

    var special = specialOfDay(y, m, d, tz);
    if (special) {
      SPECIAL_DAYS.ji_tags.forEach(function (t) { ji.push(t); });
      xiongshen.push(special);
    }
    var yb = yearGanzhi(y, m, d, tz).gz[1];
    if (br === branchClash(yb)) { allBad = true; xiongshen.push("岁破"); }
    if (br === branchClash(mb)) { allBad = true; xiongshen.push("月破"); }

    if (allBad) {  // 破日/岁破：诸事不宜，仅保留拆屋求医
      yi = yi.filter(function (t) { return t === "拆破屋垣" || t === "求医疗病"; });
      ji = ["诸事不宜"].concat(ji.filter(function (t) { return t !== "拆破屋垣" && t !== "求医疗病"; }));
    }

    var jiSet = uniq(ji);
    yi = uniq(yi.filter(function (t) { return jiSet.indexOf(t) < 0; }));

    return {
      yi: yi, ji: jiSet, all_bad: allBad,
      jianchu: jc.name, jianchu_idx: jcI, jianchu_note: jc.note,
      hh_name: god, hh_tao: note.tao, hh_note: note.note,
      liuhe_month: liuheM, special: special,
      jishen: jishen, xiongshen: xiongshen
    };
  }

  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }

  // ---------------- 吉时 ----------------
  function luckyHours(di, zodiacBranch) {
    var out = [];
    hourGods(di).forEach(function (row) {
      var br = row[0], god = row[1], tao = row[2];
      if (tao !== "黄") return;
      if (zodiacBranch && br === branchClash(zodiacBranch)) return;
      out.push({ branch: br, name: br + "时", range: HOUR_RANGES[br], god: god });
    });
    return out;
  }

  // ---------------- 逐日黄历 ----------------
  function weekdayCN(y, m, d) {
    var wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return "星期" + WEEKDAYS[(wd + 6) % 7];
  }

  function buildDay(y, m, d, tz) {
    requireInit();
    tz = (tz === undefined) ? 8.0 : tz;
    var dg = dayGanzhi(y, m, d);
    var yg = yearGanzhi(y, m, d, tz);
    var mgz = monthGanzhi(y, m, d, tz);
    var mj = monthJie(y, m, d, tz);
    var br = BRANCHES[dg.idx % 12];
    var dy = deriveYiji(y, m, d, tz);
    var tt = termOfDay(y, m, d, tz);
    var nt = nextTerm(y, m, d, tz);
    var cs = chongsha(y, m, d);
    var pz = pengzu(y, m, d);
    return {
      date: pad4(y) + "-" + pad2(m) + "-" + pad2(d),
      y: y, m: m, d: d,
      weekday: weekdayCN(y, m, d),
      day_ganzhi: dg.gz, day_idx: dg.idx,
      day_stem: dg.gz[0], day_branch: br,
      day_branch_element: BRANCH_ELEM[br],
      year_ganzhi: yg.gz, zodiac: yg.zodiac, eff_year: yg.year,
      month_ganzhi: mgz,
      month_branch: mj.branch, month_term: mj.name,
      term_today: tt ? { name: tt.name, kind: tt.kind, time: tt.time,
                         text: tt.name + "（" + tt.kind + " " + tt.time + "）" } : null,
      next_term: { name: nt.name,
                   date: pad2(nt.date[1]) + "-" + pad2(nt.date[2]),
                   time: nt.time, days: nt.days },
      jianchu: dy.jianchu, jianchu_idx: dy.jianchu_idx,
      jianchu_note: dy.jianchu_note,
      huanghei: { name: dy.hh_name, tao: dy.hh_tao, note: dy.hh_note },
      chong: cs,
      pengzu: [pz[0][0], pz[1][0]],
      pengzu_full: [pz[0][1], pz[1][1]],
      yi: dy.yi, ji: dy.ji, all_bad: dy.all_bad,
      liuhe_month: dy.liuhe_month,
      special: dy.special,
      jishen: dy.jishen, xiongshen: dy.xiongshen,
      jishi: luckyHours(dg.idx % 12)
    };
  }

  function dayGrade(day) {  // 月历配色：bad / good / normal
    if (day.all_bad || day.special) return "bad";
    if (day.huanghei.tao === "黄") return "good";
    return "normal";
  }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function monthGrid(y, m, tz) {
    var out = [];
    for (var dd = 1; dd <= daysInMonth(y, m); dd++) out.push(buildDay(y, m, dd, tz));
    return out;
  }

  // ---------------- 文本（喂 LLM / 复制导出，与 almanac_text 一致） ----------------
  function almanacText(day, question) {
    var rows = [];
    rows.push("【日期】" + day.y + "年" + day.m + "月" + day.d + "日 " + day.weekday);
    rows.push("【干支】" + day.year_ganzhi + "年（属" + day.zodiac + "） " + day.month_ganzhi + "月 " + day.day_ganzhi + "日");
    rows.push("【月建】" + day.month_branch + "月（" + day.month_term + "后）");
    if (day.term_today) {
      rows.push("【节气】今日" + day.term_today.text);
    } else {
      rows.push("【节气】当前" + day.month_branch + "月，下一个节气" + day.next_term.name +
        " " + day.next_term.date + " " + day.next_term.time + "（" + day.next_term.days + "天后）");
    }
    rows.push("【建除】" + day.jianchu + "日——" + day.jianchu_note);
    rows.push("【值神】" + day.huanghei.name + "（" + day.huanghei.tao + "道）——" + day.huanghei.note);
    rows.push("【冲煞】" + day.chong.text);
    if (day.jishen.length) rows.push("【吉神】" + day.jishen.join("、"));
    if (day.xiongshen.length) rows.push("【凶神】" + day.xiongshen.join("、"));
    if (day.special) rows.push("【凶日】今日为" + day.special + "日");
    rows.push("【彭祖百忌】" + day.pengzu_full[0] + "；" + day.pengzu_full[1]);
    rows.push("【宜】" + (day.yi.length ? day.yi.join("、") : "无"));
    rows.push("【忌】" + (day.ji.length ? day.ji.join("、") : "无"));
    rows.push("【吉时】" + (day.jishi.length
      ? day.jishi.map(function (h) { return h.name + "(" + h.range + ")"; }).join("、") : "无"));
    if (question) rows.push("【用户问题】" + question);
    return rows.join("\n");
  }

  // ---------------- 择吉日 ----------------
  function eventById(id) {
    for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) return EVENTS[i];
    return null;
  }

  function scoreDay(day, zodiacBranch) {
    var s = 0;
    if (day.huanghei.tao === "黄") s += 2;
    if (day.jianchu === "成" || day.jianchu === "定" || day.jianchu === "开" || day.jianchu === "满") s += 1;
    if (day.liuhe_month) s += 1;
    if (zodiacBranch) {
      var br = day.day_branch;
      if (liuheWith(br, zodiacBranch)) s += 2;
      else if (sanheWith(br, zodiacBranch)) s += 1;
    }
    return s;
  }

  function pickDays(start, days, eventId, zodiacBranch, tz) {
    requireInit();
    tz = (tz === undefined) ? 8.0 : tz;
    days = days || 90;
    var ev = eventById(eventId);
    if (!ev) throw new Error("未知事项: " + eventId);
    var out = [];
    var j0 = jdn(start[0], start[1], start[2]);
    for (var off = 1; off <= days; off++) {
      var ymd = jdnToYmd(j0 + off);
      var day = buildDay(ymd.y, ymd.m, ymd.d, tz);
      if (day.all_bad || day.special) continue;
      var matched = day.yi.filter(function (t) { return ev.tags.indexOf(t) >= 0; });
      if (!matched.length) continue;
      if (ev.require_huangdao && day.huanghei.tao !== "黄") continue;
      if (zodiacBranch && day.day_branch === branchClash(zodiacBranch)) continue;
      var score = scoreDay(day, zodiacBranch);
      var grade = score >= 4 ? "最佳" : (score >= 2 ? "优良" : "可用");
      out.push({
        date: day.date, weekday: day.weekday,
        day_ganzhi: day.day_ganzhi, year_zodiac: day.zodiac,
        jianchu: day.jianchu, huanghei: day.huanghei,
        score: score, grade: grade,
        matched: matched,
        jishi: luckyHours(day.day_idx % 12, zodiacBranch),
        note: ev.note
      });
    }
    return out;
  }

  function nowYmd() {
    var t = new Date();
    return [t.getFullYear(), t.getMonth() + 1, t.getDate()];
  }

  function localTZ() { return -new Date().getTimezoneOffset() / 60; }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function pad4(n) { return (n < 1000 ? (n < 100 ? (n < 10 ? "000" : "00") : "0") : "") + n; }

  // 全年 24 节气表（节气页）
  function termsOfYear(year, tz) {
    requireInit();
    tz = (tz === undefined) ? localTZ() : tz;
    return yearTerms(year, tz).map(function (t) {
      return { name: t.name, kind: t.kind, branch: t.branch,
               date: pad4(t.y) + "-" + pad2(t.m) + "-" + pad2(t.d),
               time: t.time, weekday: weekdayCN(t.y, t.m, t.d) };
    });
  }

  global.Almanac = API = {
    init: init,
    jdn: jdn, jdnToYmd: jdnToYmd,
    dayGanzhiIdx: dayGanzhiIdx, dayGanzhi: dayGanzhi,
    clashGanzhi: clashGanzhi, branchClash: branchClash,
    yearTerms: yearTerms, termsOfYear: termsOfYear,
    monthJie: monthJie, termOfDay: termOfDay, nextTerm: nextTerm,
    specialOfDay: specialOfDay,
    yearGanzhi: yearGanzhi, monthGanzhi: monthGanzhi,
    jianchuIdx: jianchuIdx, qinglongStart: qinglongStart, huangheiIdx: huangheiIdx,
    hourGods: hourGods, chongsha: chongsha, pengzu: pengzu,
    luckyHours: luckyHours, buildDay: buildDay, dayGrade: dayGrade,
    monthGrid: monthGrid, almanacText: almanacText, pickDays: pickDays,
    scoreDay: scoreDay, liuheWith: liuheWith, sanheWith: sanheWith,
    eventById: eventById, nowYmd: nowYmd, localTZ: localTZ,
    weekdayCN: weekdayCN, daysInMonth: daysInMonth,
    STEMS: function () { return STEMS; }, BRANCHES: function () { return BRANCHES; }
  };
})(typeof window !== "undefined" ? window : globalThis);
