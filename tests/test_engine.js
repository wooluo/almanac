/* JS 引擎一致性测试：vectors.json（Python 引擎生成）逐字段比对。
 * 运行：python3 tests/gen_vectors.py && node tests/test_engine.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const rules = JSON.parse(fs.readFileSync(path.join(root, "static", "rules.json"), "utf8"));
const vectors = JSON.parse(fs.readFileSync(path.join(root, "tests", "vectors.json"), "utf8"));

const sandbox = { console, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "static", "engine.js"), "utf8"), sandbox);
const A = sandbox.window.Almanac;
A.init(rules);

// 深比较（对象键序无关，数组有序；JSON null 与 JS undefined 视为同值）
function deepEqual(a, b, where) {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    assert.strictEqual(a, b, where + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b));
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    assert.fail(where + ": 数组/对象类型不一致");
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  assert.deepStrictEqual(ka.slice().sort(), kb.slice().sort(), where + ": 键不一致");
  for (const k of ka) deepEqual(a[k], b[k], where + "." + k);
}

let n = 0;
for (const v of vectors.days) {
  const [y, m, d] = v.ymd;
  const day = A.buildDay(y, m, d, vectors.tz);
  deepEqual(day, v.day, `day ${v.day.date}`);
  const text = A.almanacText(day);
  assert.strictEqual(text, v.text, `text ${v.day.date} 不一致`);
  n++;
}
console.log(`✓ 逐日黄历 ${n} 组向量一致（含 almanacText 文本逐字符一致）`);

for (const [key, cells] of Object.entries(vectors.grids)) {
  const [y, m] = key.split("-").map(Number);
  const grid = A.monthGrid(y, m, vectors.tz);
  assert.strictEqual(grid.length, cells.length, key + " 月天数");
  grid.forEach((day, i) => {
    const [yy, mm, dd] = cells[i].ymd;
    assert.strictEqual(day.date, `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, key);
    assert.strictEqual(A.dayGrade(day), cells[i].grade, key + " " + day.date + " grade");
  });
}
console.log(`✓ 月历网格 ${Object.keys(vectors.grids).length} 组一致（含吉凶配色 grade）`);

let p = 0;
for (const [key, list] of Object.entries(vectors.picks)) {
  const opts = {
    marry_zodiac_wu: [[2026, 11, 5], 90, "marry", "午"],
    travel_zodiac_zi: [[2026, 11, 5], 90, "travel", "子"],
    csection: [[2026, 11, 5], 90, "csection", null]
  }[key];
  const got = A.pickDays(opts[0], opts[1], opts[2], opts[3], vectors.tz);
  deepEqual(got, list, "pick " + key);
  p++;
}
console.log(`✓ 择吉 ${p} 组向量一致（含吉时、评分、等级）`);

// 引擎基础断言（与 Python 单测同源的核心向量）
assert.strictEqual(A.dayGanzhi(2026, 11, 5).gz, "癸未");
assert.strictEqual(A.dayGanzhiIdx(2026, 11, 5), 19);
assert.strictEqual(A.monthGanzhi(2026, 1, 5, 8.0), "己丑");
assert.strictEqual(A.monthGanzhi(2026, 11, 5, 8.0), "戊戌");
const lg = A.yearGanzhi(2026, 2, 3, 8.0);
assert.strictEqual(lg.gz + lg.zodiac, "乙巳蛇");
const jd = A.buildDay(2026, 11, 5, 8.0);
assert.strictEqual(jd.jianchu, "收");
assert.strictEqual(jd.huanghei.name, "朱雀");
assert.strictEqual(jd.chong.text, "冲牛（丁丑）煞西");
assert.strictEqual(jd.next_term.name + " " + jd.next_term.time, "立冬 17:51");
console.log("✓ 干支锚点 / 五虎遁跨子丑 / 建除 / 黄黑道 / 冲煞 / 节气 核心向量一致");
console.log(`\n全部通过：JS 引擎与 Python 引擎输出逐字段一致（${n} 天 + ${p} 组择吉）`);
