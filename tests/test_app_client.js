/* 离线（client）模式自动化测试：在 Node 中加载 app.js（带极简 DOM 桩）。
 * 覆盖：
 * 1) 无服务器 → 自动进入离线模式，今日/月历/择吉/节气/设置五页全部本地渲染；
 * 2) 模拟安卓（Capacitor 原生环境）：/api/config 返回 200 HTML（WebView 资源兜底行为）
 *    也必须判为离线 —— 防 WebView 200-HTML 误判回归；
 * 3) 原生 StreamHttp 插件流式 + fetch 非流式两条 AI 直连链路（stub 全链路）。
 * 运行：node tests/test_app_client.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const root = path.join(__dirname, "..");
const RULES = JSON.parse(fs.readFileSync(path.join(root, "static", "rules.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMagic() {
  const magic = new Proxy(function () {}, {
    get(t, p) {
      if (p === Symbol.iterator) return () => ({ next: () => ({ done: true }) });
      if (p === "then") return undefined;
      return magic;
    },
    set() { return true; },
    apply() { return magic; }
  });
  return magic;
}

const jsonRes = (obj) => ({
  ok: true, status: 200,
  headers: { get: () => "application/json" },
  json: async () => obj
});

function makeSandbox({ capNative, failConfig } = {}) {
  const mem = new Map();
  const magic = makeMagic();
  const appEl = { innerHTML: "" };  // 记录主渲染区
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("rules.json")) return jsonRes(RULES);
    if (u.includes("/api/config")) {
      if (failConfig && !capNative) throw new Error("fetch failed");
      // WebView 资源兜底：任何未知路径都返回 200 HTML（index.html）
      return { ok: true, status: 200, headers: { get: () => "text/html" },
               json: async () => { throw new Error("html"); } };
    }
    if (u.includes("/models")) {
      return jsonRes({ data: [{ id: "stub-model" }, { id: "text-embedding-x" }] });
    }
    if (u.includes("chat/completions")) {
      return jsonRes({ choices: [{ message: { content: "非流式直连讲解内容。" } }] });
    }
    throw new Error("fetch failed: " + u);
  };

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchStub, URLSearchParams, URL, TextDecoder, AbortController,
    navigator: {}, location: { hash: "#/today" },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    },
    document: new Proxy({}, {
      get(t, p) {
        if (p === "getElementById") return (id) => (id === "app" ? appEl : magic);
        if (p === "querySelector") return (sel) => (sel === "#app" ? appEl : magic);
        return magic;
      }
    }),
    confirm: () => true, alert: () => {},
    addEventListener: () => {}, scrollTo: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (capNative) {
    const listeners = {};
    sandbox.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        StreamHttp: {
          addListener: async (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); return { remove: () => {} }; },
          request: async ({ id }) => {
            const push = (payload) => (listeners["stream-http-data"] || []).forEach((cb) => cb({ id, payload }));
            for (const piece of ["## 白话讲解\n", "测试", "内容。"]) {
              push(JSON.stringify({ choices: [{ delta: { content: piece } }] }));
            }
            push("[DONE]");
            (listeners["stream-http-end"] || []).forEach((cb) => cb({ id }));
          },
          cancel: () => {}
        }
      }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "static", "engine.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "static", "app.js"), "utf8"), sandbox);
  const cleanup = () => process.off("unhandledRejection", onUnhandled);
  return { sandbox, appEl, unhandled, cleanup,
           LY: () => sandbox.__almanac, A: () => sandbox.window.Almanac };
}

(async () => {
  // ========== 场景 1：浏览器环境、无服务器 → 离线模式，五页渲染 ==========
  const s1 = makeSandbox({ failConfig: true });
  await sleep(200);  // 等 boot 完成（rules 加载 + detectMode + route）
  const LY1 = s1.LY(), A1 = s1.A();
  assert.strictEqual(LY1.mode, "client", "无服务器应自动进入离线模式");

  const today = A1.nowYmd();
  const todayDay = A1.buildDay(today[0], today[1], today[2], A1.localTZ());
  let html = s1.appEl.innerHTML;
  assert.ok(html.includes("day-hero"), "今日页应渲染黄历大卡");
  assert.ok(html.includes(todayDay.day_ganzhi), "今日页应含当日干支 " + todayDay.day_ganzhi);
  assert.ok(html.includes("宜") && html.includes("忌"), "今日页应有宜/忌两栏");
  assert.ok(html.includes("十二建除"), "今日页应展示建除");
  assert.ok(html.includes("彭祖百忌"), "今日页应展示彭祖百忌");
  assert.ok(html.includes("今日吉时"), "今日页应展示吉时");
  assert.ok(html.includes("冲"), "今日页应展示冲煞");
  console.log("✓ 离线今日页 OK：", todayDay.date, todayDay.day_ganzhi, todayDay.jianchu + "日",
    todayDay.huanghei.name, todayDay.chong.text);

  s1.sandbox.location.hash = "#/month";
  await LY1.route();
  await sleep(30);
  html = s1.appEl.innerHTML;
  assert.ok(html.includes("cal-grid"), "月历页应渲染日历格子");
  assert.ok(html.includes("黄道吉日"), "月历页应有图例");
  const cellCount = (html.match(/data-date=/g) || []).length;
  assert.ok(cellCount >= 28, "月历应渲染整月格子（" + cellCount + "）");
  console.log("✓ 离线月历页 OK（", cellCount, "格 ）");

  s1.sandbox.location.hash = "#/pick";
  await LY1.route();
  await sleep(30);
  html = s1.appEl.innerHTML;
  assert.ok(html.includes("event-grid"), "择吉页应渲染事项目录");
  assert.ok(html.includes("结婚嫁娶"), "择吉页应含「结婚嫁娶」事项");
  assert.ok(html.includes("剖腹产预约"), "择吉页应含「剖腹产预约」事项");
  console.log("✓ 离线择吉页 OK（", (html.match(/data-ev=/g) || []).length, "个事项 ）");

  s1.sandbox.location.hash = "#/terms";
  await LY1.route();
  await sleep(30);
  html = s1.appEl.innerHTML;
  assert.ok(html.includes("24 节气"), "节气页应渲染全年节气表");
  assert.ok(html.includes("交节"), "节气页应有倒计时/交节信息");
  assert.ok((html.match(/term-row/g) || []).length >= 24, "节气页应列 24 行");
  console.log("✓ 离线节气页 OK");

  s1.sandbox.location.hash = "#/settings";
  await LY1.route();
  await sleep(30);
  html = s1.appEl.innerHTML;
  assert.ok(/AI 讲解服务/.test(html), "设置页应渲染「AI 讲解服务」区块");
  assert.ok(/GLM/.test(html), "设置页应渲染 GLM 卡片");
  assert.ok(/离线模式/.test(html), "设置页应显示离线模式标识");
  assert.ok(/历法与免责/.test(html), "设置页应显示历法与免责说明");
  s1.cleanup();
  console.log("✓ 离线设置页 OK（含 GLM 卡片与免责声明）");

  // 离线直连（非流式，stub fetch 全链路）
  const text = await LY1.clientApi("/api/config").then(() =>
    LY1.clientAIExplain(todayDay, "为什么今天忌" + (todayDay.ji[0] || "出行"), "glm"));
  assert.ok(text.includes("非流式直连讲解内容"), "非流式直连应返回 stub 内容");
  console.log("✓ 离线直连 AI（非流式 stub）OK");

  // ========== 场景 2：Capacitor 原生环境 + /api/config 返回 200 HTML ==========
  const s2 = makeSandbox({ capNative: true, failConfig: true });
  await sleep(200);
  const LY2 = s2.LY(), A2 = s2.A();
  assert.strictEqual(LY2.mode, "client", "原生环境必须强制离线模式（回归：200 HTML 不误判为服务器）");
  assert.ok(/day-hero/.test(s2.appEl.innerHTML), "原生环境今日页（默认路由）应正常渲染黄历卡");
  assert.ok(/AI 讲历法/.test(s2.appEl.innerHTML), "原生环境今日页应正常渲染 AI 讲解区块");
  assert.strictEqual(s2.unhandled.length, 0,
    "渲染过程不应有未捕获异常：" + (s2.unhandled[0] && s2.unhandled[0].message));
  console.log("✓ 原生环境强制离线模式 OK（回归：200 HTML 兜底不再误判为服务器）");

  // 原生 StreamHttp 插件流式全链路（stub）
  const day2 = await LY2.clientApi("/api/day?date=2026-11-05").then((o) => o.day);
  const streamed = await LY2.clientAIExplainStream(day2, "为什么今天忌动土", "glm", () => {});
  assert.strictEqual(streamed, "## 白话讲解\n测试内容。");
  console.log("✓ 原生 StreamHttp 流式直连 OK（stub 全链路）");

  // 原生环境下本地引擎逐项（与 vectors 同源的核心向量）
  const d = A2.buildDay(2026, 11, 5, 8.0);
  assert.strictEqual(d.day_ganzhi, "癸未");
  assert.strictEqual(d.jianchu, "收");
  assert.strictEqual(d.huanghei.name, "朱雀");
  assert.strictEqual(d.chong.text, "冲牛（丁丑）煞西");
  const picks = A2.pickDays([2026, 11, 5], 90, "marry", "午", 8.0);
  assert.ok(picks.length > 0);
  s2.cleanup();
  console.log("✓ 原生环境本地引擎核心向量 OK（含择吉", picks.length, "条）");

  console.log("\n全部通过：离线模式 + Capacitor 原生环境回归");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
