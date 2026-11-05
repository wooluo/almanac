"use strict";
/* 老黄历·择吉日 · 前端（原生 JS，零依赖）
   服务器模式：数据走本地 Python 服务；离线（APK/直接打开）模式：全部本地引擎计算。 */

// ---------------- 基础工具 ----------------
const app = document.getElementById("app");
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------------- 配置缓存 ----------------
let config = null;
async function loadConfig(force) {
  if (config && !force) return config;
  try { config = await api("/api/config"); } catch (e) { config = null; }
  return config;
}

// ---------------- 服务器探测 / 离线（App）模式 ----------------
let MODE = "server"; // server = 走本地 Python 服务；client = 离线（APK / 直接打开）

function lsGet(k, d) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function defaultConfig() {
  return {
    provider: "glm",
    providers: {
      glm: { label: "GLM 智谱（Coding Plan）", protocol: "openai", base: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3", api_key: "", fast: true }
    }
  };
}

function clientRawConfig() {
  const stored = lsGet("almanac.config", null);
  if (!stored) return defaultConfig();
  const base = defaultConfig();
  Object.keys(base.providers).forEach((pid) => {
    if (!stored.providers[pid]) stored.providers[pid] = base.providers[pid];
  });
  if (!stored.providers[stored.provider]) stored.provider = base.provider;
  return stored;
}

function applyConfigPatch(cfg, body) {
  if (body.provider && cfg.providers[body.provider]) cfg.provider = body.provider;
  Object.entries(body.providers || {}).forEach(([pid, p]) => {
    if (!p || typeof p !== "object" || !cfg.providers[pid]) return;
    const tgt = cfg.providers[pid];
    ["label", "protocol", "base", "model"].forEach((k) => {
      if (typeof p[k] === "string") tgt[k] = p[k].trim();
    });
    if (p.protocol !== "openai" && p.protocol !== "anthropic") tgt.protocol = "openai";
    if (typeof p.api_key === "string" && p.api_key.trim()) tgt.api_key = p.api_key.trim();
    if (typeof p.fast === "boolean") tgt.fast = p.fast;
  });
}

async function detectMode() {
  // 安卓/原生环境：必定离线模式（App 内置历法引擎与直连能力，不依赖本机服务）
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) { MODE = "client"; return; }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch("/api/config", { signal: ctl.signal });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.indexOf("json") >= 0) {
      const data = await res.json().catch(() => null);
      if (data && data.providers) { MODE = "server"; return; }
    }
  } catch (e) { /* 无服务器 */ }
  MODE = "client";
}

async function api(path, opts = {}) {
  if (MODE === "client") return clientApi(path, opts);
  const init = { method: opts.method || "GET", headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null || typeof data !== "object") {
    throw new Error((data && data.error) || "HTTP " + res.status);
  }
  return data;
}

// ---------------- 离线（client）模式：本地引擎接管 ----------------
function localTz() { return Almanac.localTZ(); }

function clientApi(path, opts = {}) {
  const method = opts.method || "GET";
  if (path === "/api/config" && method === "GET") {
    const cfg = JSON.parse(JSON.stringify(clientRawConfig()));
    Object.values(cfg.providers).forEach((p) => { p.has_key = !!p.api_key; p.api_key = ""; });
    return Promise.resolve(cfg);
  }
  if (path === "/api/config" && method === "POST") {
    const cfg = clientRawConfig();
    applyConfigPatch(cfg, opts.body || {});
    lsSet("almanac.config", cfg);
    return Promise.resolve({ ok: true });
  }
  const q = path.split("?")[1] || "";
  const qs = new URLSearchParams(q);
  if (path.startsWith("/api/day")) {
    const [y, m, d] = (qs.get("date") || "").split("-").map(Number);
    if (!y || !m || !d) return Promise.reject(new Error("日期格式应为 YYYY-MM-DD"));
    return Promise.resolve({ day: Almanac.buildDay(y, m, d, localTz()) });
  }
  if (path.startsWith("/api/month")) {
    const y = parseInt(qs.get("year"), 10), m = parseInt(qs.get("month"), 10);
    if (!y || !m) return Promise.reject(new Error("year/month 参数不合法"));
    return Promise.resolve({ days: Almanac.monthGrid(y, m, localTz()) });
  }
  if (path.startsWith("/api/terms")) {
    const y = parseInt(qs.get("year"), 10);
    if (!y) return Promise.reject(new Error("year 参数不合法"));
    return Promise.resolve({ terms: Almanac.termsOfYear(y, localTz()) });
  }
  if (path.startsWith("/api/models")) {
    const pid = qs.get("provider") || "";
    const pcfg = clientRawConfig().providers[pid];
    if (!pcfg) return Promise.reject(new Error("未知 provider"));
    return fetchModelsDirect(pcfg).then((models) => ({ models }));
  }
  return Promise.reject(new Error("离线模式不支持：" + path));
}

// ---------------- 原生 HTTP（Capacitor 内绕过 CORS；浏览器则退回 fetch） ----------------
function nativeHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.CapacitorHttp && (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.CapacitorHttp;
  }
  return null;
}

async function httpJSON(method, url, headers, bodyObj, timeoutMs) {
  const nh = nativeHttp();
  if (nh) {
    const r = await nh.request({ method, url, headers: headers || {}, data: bodyObj });
    if (r.status >= 400) {
      throw new Error("HTTP " + r.status + "：" + JSON.stringify(r.data).slice(0, 200));
    }
    return { status: r.status, json: r.data };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method, headers,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
      signal: ctl.signal
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = j && j.error ? (j.error.message || j.error) : JSON.stringify(j).slice(0, 200);
      throw new Error("HTTP " + res.status + "：" + (msg || ""));
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

async function fetchModelsDirect(pcfg) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  if (!base) return [];
  const url = base + (pcfg.protocol === "anthropic" ? "/v1/models" : "/models");
  const headers = {};
  if (pcfg.api_key) { headers.Authorization = "Bearer " + pcfg.api_key; headers["x-api-key"] = pcfg.api_key; }
  const { json } = await httpJSON("GET", url, headers, undefined, 10000);
  return (json.data || []).map((m) => m && m.id).filter(Boolean);
}

const NON_CHAT_MODEL = /embed|rerank|ocr|whisper|speech|tts|stt|audio|clip/i;

async function resolveClientModel(pcfg) {
  let model = (pcfg.model || "").trim();
  if (!model) {
    try {
      const ms = await fetchModelsDirect(pcfg);
      model = ms.find((x) => !NON_CHAT_MODEL.test(x)) || ms[0] || "";
    } catch (e) { /* 留空报错 */ }
  }
  return model;
}

// 与 app.py 的 SYSTEM_ALMANAC 保持一致
const SYSTEM_ALMANAC = "你是一位精通中国传统历法（干支、节气、建除十二神、黄道黑道、彭祖百忌）的文化科普作者，用通俗易懂、有趣的现代汉语讲解老黄历。\n用户会提供某天的完整黄历数据（干支纪年月日、月建、节气、建除值神、黄黑道值神、冲煞、彭祖百忌、宜忌、吉时等）。这些数据已由程序按天文历法精确计算，你必须直接采信，禁止重新推算、更改或质疑任何数据。\n讲解要求：\n1. 若用户指定了事项（如「为什么今天忌动土」），围绕该事项展开：先引用当日具体的历法依据（建除值神及其含义、黄黑道、彭祖百忌、冲煞等），再用白话解释这些名词背后的古人生活逻辑与民俗心理。\n2. 若未指定事项，则概述当日黄历要点：干支与生肖、节气、宜忌大势、吉时建议。\n3. 讲清「为什么」：把术语翻译成现代生活的类比，突出文化内涵与古人智慧，避免神秘主义渲染，不渲染焦虑。\n4. 语气轻松友好，可适度幽默；用「## 小标题」和要点列表组织内容；不要输出 Markdown 表格。\n5. 明确说明这是民俗文化参考，不是科学预测，不构成任何现实决策依据；涉及医疗、法律、投资等事项应咨询专业人士。\n6. 结尾固定附一句：以上为民俗文化科普，仅供参考。";

function clientRequestBody(pcfg, model, day, question, stream) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  const user = Almanac.almanacText(day, question || "");
  let url, headers, payload;
  if (pcfg.protocol === "anthropic") {
    url = base + "/v1/messages";
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (pcfg.api_key) { headers["x-api-key"] = pcfg.api_key; headers.Authorization = "Bearer " + pcfg.api_key; }
    payload = { model, max_tokens: 4096, temperature: 0.7, stream: !!stream, system: SYSTEM_ALMANAC,
                messages: [{ role: "user", content: user }] };
  } else {
    url = base + "/chat/completions";
    headers = { "Content-Type": "application/json" };
    if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
    payload = { model, temperature: 0.7, stream: !!stream,
                messages: [{ role: "system", content: SYSTEM_ALMANAC }, { role: "user", content: user }] };
  }
  // 快速模式：智谱系端点关闭深度思考，显著缩短等待
  if (pcfg.fast && /bigmodel|z\.ai/i.test(pcfg.base || "")) {
    payload.thinking = { type: "disabled" };
  }
  return { url, headers, payload };
}

// 非流式（浏览器离线模式）
async function clientAIExplain(day, question, pid) {
  const pcfg = clientRawConfig().providers[pid];
  if (!pcfg) throw new Error("未知 provider：" + pid);
  const model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const req = clientRequestBody(pcfg, model, day, question, false);
  const { json } = await httpJSON("POST", req.url, req.headers, req.payload, 300000);
  let text = "";
  if (json && Array.isArray(json.choices) && json.choices[0]) {
    text = (json.choices[0].message || {}).content || "";
  } else if (json && Array.isArray(json.content)) {
    text = json.content.map((b) => (b && b.text) || "").join("");
  }
  if (!text) throw new Error("模型未返回内容：" + JSON.stringify(json).slice(0, 160));
  return text;
}

// 流式（原生 StreamHttp 插件）：SSE 增量逐段回调 onDelta
let nativeStreamCancel = null;

function nativeStreamHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.StreamHttp &&
      (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.StreamHttp;
  }
  return null;
}

function clientAIExplainStream(day, question, pid, onDelta) {
  return new Promise((resolve, reject) => {
    (async () => {
      const plugin = nativeStreamHttp();
      const pcfg = clientRawConfig().providers[pid];
      if (!pcfg) { reject(new Error("未知 provider：" + pid)); return; }
      const model = await resolveClientModel(pcfg);
      if (!model) { reject(new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。")); return; }
      const req = clientRequestBody(pcfg, model, day, question, true);
      const id = "s" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      let acc = "", reason = "", finished = false;
      const handles = [];
      const cleanup = () => { handles.forEach((h) => { try { h.remove && h.remove(); } catch (e) {} }); };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        nativeStreamCancel = null;
        if (err) reject(err);
        else if (!acc) reject(new Error("模型未返回内容"));
        else resolve(acc);
      };
      nativeStreamCancel = () => { try { plugin.cancel({ id }); } catch (e) {} };
      try {
        handles.push(await plugin.addListener("stream-http-data", (e) => {
          if (e.id !== id || !e.payload || e.payload === "[DONE]") return;
          let obj;
          try { obj = JSON.parse(e.payload); } catch (err) { return; }
          let t = "", r = "";
          if (obj.choices && obj.choices[0]) {
            const d = (obj.choices[0].delta) || {};
            t = d.content || "";
            r = d.reasoning_content || d.reasoning || "";
          } else if (obj.type === "content_block_delta") {
            t = (obj.delta || {}).text || "";
          }
          if (t || r) {
            if (t) acc += t;
            if (r) reason += r;
            onDelta({ content: acc, reason });
          }
        }));
        handles.push(await plugin.addListener("stream-http-end", (e) => { if (e.id === id) finish(); }));
        handles.push(await plugin.addListener("stream-http-error", (e) => {
          if (e.id === id) finish(new Error(e.message || "上游错误"));
        }));
        await plugin.request({ id, url: req.url, headers: req.headers, body: JSON.stringify(req.payload) });
      } catch (e) { finish(e); }
    })();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("已复制到剪贴板");
  }
}

// ---------------- 极简 Markdown ----------------
function md(src) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flushP(); flushL(); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flushP(); flushL();
      const lv = Math.min(m[1].length + 1, 4);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if ((m = l.match(/^[-•]\s+(.*)$/))) {
      flushP();
      if (list !== "ul") { flushL(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else if ((m = l.match(/^(\d+)[.、)]\s+(.*)$/))) {
      flushP();
      if (list !== "ol") { flushL(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(m[2]) + "</li>");
    } else {
      flushL(); para.push(l);
    }
  }
  flushP(); flushL();
  return out.join("\n");
}

// ---------------- 路由 ----------------
window.addEventListener("hashchange", route);

function route() {
  const h = location.hash || "#/today";
  const m = h.match(/^#\/([a-z]+)(?:\/([\w-]+))?/);
  const page = m ? m[1] : "today";
  $$(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === "pick") return renderPick();
  if (page === "month") return renderMonth();
  if (page === "terms") return renderTerms();
  if (page === "settings") return renderSettings();
  if (page === "day" && m[2]) {
    const [y, mm, dd] = m[2].split("-").map(Number);
    return renderDayPage(y, mm, dd);
  }
  return renderToday();
}

// ---------------- 黄历卡（今日 / 任意日期共用） ----------------
function heroHtml(day, isToday) {
  const t = day.term_today;
  const termHtml = t
    ? `<span class="t-name">${esc(t.name)}</span><br>今日${esc(t.kind)} · ${esc(t.time)}交节`
    : `<span class="t-name">${esc(day.next_term.name)}</span><br>${esc(day.next_term.date)} ${esc(day.next_term.time)} · 剩${day.next_term.days}天`;
  return `
  <div class="day-hero">
    <div class="hero-date-row">
      <div class="hero-date"><b>${day.m}月${day.d}日</b><span class="wd">${esc(day.weekday)}${isToday ? " · 今天" : ""}</span></div>
      <div class="hero-term">${termHtml}</div>
    </div>
    <div class="hero-gz">
      <span class="gz-big">${esc(day.day_ganzhi)}</span>
      <span class="gz-meta"><b>${esc(day.year_ganzhi)}</b>年 · 属${esc(day.zodiac)}<br>
        ${esc(day.month_ganzhi)}月 · ${esc(day.month_branch)}月建（${esc(day.month_term)}后）</span>
    </div>
    <div class="hero-chong"><span class="zodiac-badge">冲</span>${esc(day.chong.text)}</div>
  </div>`;
}

function yijiHtml(day) {
  const yiItems = day.yi.length
    ? day.yi.map((t) => `<span class="yiji-item">${esc(t)}</span>`).join("")
    : '<span class="yiji-empty">今日无特定宜事</span>';
  const jiItems = day.ji.length
    ? day.ji.map((t) => `<span class="yiji-item">${esc(t)}</span>`).join("")
    : '<span class="yiji-empty">今日无特定忌事</span>';
  return `
  <div class="yiji-grid">
    <div class="yiji-col yi">
      <div class="yiji-head"><span class="stamp">宜</span><span class="t">宜</span></div>
      <div class="yiji-list">${yiItems}</div>
    </div>
    <div class="yiji-col ji">
      <div class="yiji-head"><span class="stamp">忌</span><span class="t">忌</span></div>
      <div class="yiji-list">${jiItems}</div>
    </div>
  </div>`;
}

function dayCardHtml(day, isToday) {
  const hh = day.huanghei;
  const badges = [];
  if (day.term_today) badges.push(`<span class="term-badge">${esc(day.term_today.name)}</span>`);
  if (day.special) badges.push(`<span class="tag red">${esc(day.special)}日</span>`);
  if (day.liuhe_month) badges.push(`<span class="tag">月建六合</span>`);
  return `
  ${heroHtml(day, isToday)}
  <div class="chip-row">${badges.join("")}
    ${day.jishen.map((s) => `<span class="tag">吉神 · ${esc(s)}</span>`).join("")}
    ${day.xiongshen.map((s) => `<span class="tag dark">凶神 · ${esc(s)}</span>`).join("")}
  </div>
  ${yijiHtml(day)}
  <div class="info-grid">
    <div class="info-box">
      <div class="k"><span class="sw">建</span>十二建除</div>
      <div class="v"><span class="acc">${esc(day.jianchu)}日</span></div>
      <div class="note">${esc(day.jianchu_note)}</div>
    </div>
    <div class="info-box">
      <div class="k"><span class="sw">神</span>黄道黑道</div>
      <div class="v">${esc(hh.name)}<span class="${hh.tao === "黄" ? "gd" : "acc"}">（${esc(hh.tao)}道）</span></div>
      <div class="note">${esc(hh.note)}</div>
    </div>
    <div class="info-box">
      <div class="k"><span class="sw">彭</span>彭祖百忌</div>
      <div class="pengzu-row" style="margin-top:2px">
        <div class="p-item"><b>${esc(day.pengzu_full[0])}</b></div>
        <div class="p-item"><b>${esc(day.pengzu_full[1])}</b></div>
      </div>
    </div>
    <div class="info-box">
      <div class="k"><span class="sw">时</span>今日吉时</div>
      <div class="jishi-grid" style="margin-top:6px">
        ${day.jishi.map((h) => `<span class="jishi-chip"><span class="h">${esc(h.name)}</span><span class="g">${esc(h.god)}</span><span class="r">${esc(h.range)}</span></span>`).join("")}
      </div>
    </div>
  </div>`;
}

function aiSectionHtml(day, question) {
  return `
  <div class="card">
    <h2>AI 讲历法 <span class="sub">白话解释当日的宜忌逻辑 · 流式输出</span></h2>
    <input type="text" id="ai-q" maxlength="60" placeholder="如：今天为什么忌${esc(day.ji[0] && day.ji[0] !== "诸事不宜" ? day.ji[0] : "出行")}？" value="${esc(question || "")}">
    <div class="btn-row">
      <button class="btn primary" id="ai-go">让 AI 讲讲这天</button>
      <button class="btn ghost" id="ai-stop" style="display:none">停止</button>
      <button class="btn ghost small" id="ai-copy" style="display:none">复制</button>
    </div>
    <div class="stream waiting" id="ai-area" style="margin-top:12px">输入想了解的事项（可不填），点「让 AI 讲讲这天」</div>
    <div class="err-box" id="ai-err" hidden></div>
    <div class="hint">AI 只负责把程序算好的历法数据翻译成白话，所有宜忌数据均为程序计算，不会被 AI 篡改。</div>
  </div>`;
}

let aiCtl = null;
let aiLastText = "";

async function startAI(day, pid) {
  if (aiCtl || nativeStreamCancel) return;
  const area = $("#ai-area"), errBox = $("#ai-err");
  const startBtn = $("#ai-go"), stopBtn = $("#ai-stop"), copyBtn = $("#ai-copy");
  const q = ($("#ai-q").value || "").trim();

  const paintStream = (final, buf) => {
    area.classList.remove("waiting");
    area.innerHTML = md(buf) + (final ? "" : '<span class="cursor">▍</span>');
  };

  if (MODE === "client") {  // 离线直连：原生插件流式；浏览器退回整段返回
    startBtn.disabled = true;
    errBox.hidden = true;
    const stream = nativeStreamHttp();
    stopBtn.style.display = stream ? "" : "none";
    let buf = "";
    try {
      if (stream) {
        const t0 = Date.now();
        const tick = setInterval(() => {
          if (!buf) area.innerHTML = `<div class="think-status">🧠 模型思考中 · ${Math.round((Date.now() - t0) / 1000)}s</div>`;
        }, 1000);
        try {
          buf = await clientAIExplainStream(day, q, pid, (st) => {
            buf = st.content;
            paintStream(false, buf);
          });
        } finally { clearInterval(tick); }
      } else {
        area.textContent = "正在讲解（直连 AI，生成完整体显示）…";
        buf = await clientAIExplain(day, q, pid);
      }
      aiLastText = buf;
      paintStream(true, buf);
      copyBtn.style.display = "";
      toast("讲解完成");
    } catch (e) {
      if (buf) { paintStream(true, buf); copyBtn.style.display = ""; }
      errBox.hidden = false;
      errBox.innerHTML = esc(hintFor(e.message));
      if (!buf) { area.classList.add("waiting"); area.textContent = "讲解未完成"; }
    } finally {
      startBtn.disabled = false;
      stopBtn.style.display = "none";
    }
    return;
  }

  errBox.hidden = true;
  startBtn.disabled = true;
  stopBtn.style.display = "";
  let buf = "";
  paintStream(false, "");
  aiCtl = new AbortController();
  try {
    const res = await fetch("/api/aiexplain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: day.date, question: q, provider: pid }),
      signal: aiCtl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      paintStream(false, buf);
    }
    aiLastText = buf;
    paintStream(true, buf);
    copyBtn.style.display = "";
    toast("讲解完成");
  } catch (e) {
    if (e.name === "AbortError") {
      aiLastText = buf;
      paintStream(true, buf);
      copyBtn.style.display = buf ? "" : "none";
      toast("已停止");
    } else {
      if (buf) { paintStream(true, buf); copyBtn.style.display = ""; }
      errBox.hidden = false;
      errBox.innerHTML = esc(hintFor(e.message));
      if (!buf) { area.classList.add("waiting"); area.textContent = "讲解未完成"; }
    }
  } finally {
    aiCtl = null;
    startBtn.disabled = false;
    stopBtn.style.display = "none";
  }
}

function hintFor(msg) {
  let out = "讲解失败：" + msg;
  if (/401|403|api.?key|unauthorized/i.test(msg)) {
    out += "\n提示：请到「设置」检查 API Key 是否正确保存。";
  } else if (/429|1113|余额|资源包|quota|rate.?limit/i.test(msg)) {
    out += "\n提示：账户额度不足——Coding Plan 需用开通订阅的账号创建「Coding Plan 类型」密钥。";
  } else if (/404|model/i.test(msg)) {
    out += "\n提示：请到「设置」核对模型名称。";
  }
  return out;
}

function wireAI(day) {
  $("#ai-go").addEventListener("click", async () => {
    const cfg = await loadConfig(true);
    startAI(day, (cfg && cfg.provider) || "glm");
  });
  $("#ai-stop").addEventListener("click", () => {
    if (aiCtl) aiCtl.abort();
    if (nativeStreamCancel) nativeStreamCancel();
  });
  const cb = $("#ai-copy");
  if (cb) cb.addEventListener("click", () => copyText(aiLastText));
}

// ---------------- 今日页 / 单日页 ----------------
async function renderToday() {
  const now = Almanac.nowYmd();
  await renderDayPage(now[0], now[1], now[2], true);
}

async function renderDayPage(y, m, d, isToday) {
  let day;
  try {
    day = (await api("/api/day?date=" + `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)).day;
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">${esc(e.message)}<br><a href="#/month">← 去月历选日期</a></div></div>`;
    return;
  }
  app.innerHTML = `
  <section>
    ${dayCardHtml(day, !!isToday)}
    <div class="page-nav-btns">
      <button class="btn ghost small" id="prev-day">← 前一天</button>
      <button class="btn ghost small" id="next-day">后一天 →</button>
    </div>
    ${aiSectionHtml(day)}
  </section>`;
  const go = (delta) => {
    const j = Almanac.jdn(y, m, d) + delta;
    const t = Almanac.jdnToYmd(j);
    location.hash = "#/day/" + `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
  };
  $("#prev-day").addEventListener("click", () => go(-1));
  $("#next-day").addEventListener("click", () => go(1));
  wireAI(day);
}

// ---------------- 择吉页 ----------------
let pickState = { event: null, zodiac: "" };

async function renderPick() {
  const rules = Almanac.rules;
  const events = rules.events;
  const zodiacs = ["", ...rules.zodiac];
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>择吉日 <span class="sub">选事项 → 未来 90 天内的宜之吉日</span></h2>
      <div class="event-grid">
        ${events.map((e) => `
          <div class="event-cell ${pickState.event === e.id ? "active" : ""}" data-ev="${e.id}" title="${esc(e.note || "")}">
            <span class="ic">${esc(e.icon)}</span><span class="nm">${esc(e.name)}</span>
          </div>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2>你的生肖 <span class="sub">可选 · 排除冲煞之日，并优先三合六合</span></h2>
      <div class="sel-row">
        ${zodiacs.map((z) => `<span class="chip ${pickState.zodiac === z ? "active" : ""}" data-z="${z}">${z === "" ? "不填" : z}</span>`).join("")}
      </div>
    </div>
    <div id="pick-result"></div>
  </section>`;

  $$(".event-cell").forEach((c) => c.addEventListener("click", () => {
    pickState.event = c.dataset.ev;
    $$(".event-cell").forEach((x) => x.classList.toggle("active", x.dataset.ev === pickState.event));
    updatePickResult();
  }));
  $$(".sel-row .chip").forEach((c) => c.addEventListener("click", () => {
    pickState.zodiac = c.dataset.z;
    $$(".sel-row .chip").forEach((x) => x.classList.toggle("active", x.dataset.z === pickState.zodiac));
    updatePickResult();
  }));
  updatePickResult();
}

function updatePickResult() {
  const box = $("#pick-result");
  if (!box) return;
  if (!pickState.event) {
    box.innerHTML = `<div class="card empty"><div class="big">📜</div>先在上面选一件事，我再帮你翻 90 天的黄历</div>`;
    return;
  }
  const ev = Almanac.eventById(pickState.event);
  const zb = pickState.zodiac || null;
  const now = Almanac.nowYmd();
  const results = Almanac.pickDays(now, 90, pickState.event, zb, Almanac.localTZ());
  const gradeTag = { "最佳": '<span class="tag red">最佳</span>', "优良": '<span class="tag">优良</span>', "可用": '<span class="tag plain">可用</span>' };
  box.innerHTML = `
  <div class="card">
    <h2>${esc(ev.icon)} ${esc(ev.name)} <span class="sub">未来 90 天 · ${results.length} 个吉日</span></h2>
    ${ev.note ? `<div class="hint">${esc(ev.note)}</div>` : ""}
    ${results.length ? results.map((r) => `
      <div class="ji-day-card" data-date="${r.date}">
        <div class="ji-day-head">
          <span class="dt">${r.date}</span><span class="gz">${esc(r.weekday)} · ${esc(r.day_ganzhi)}日 · ${esc(r.jianchu)}日 · ${esc(r.huanghei.name)}（${esc(r.huanghei.tao)}道）</span>
          <span class="grade">${gradeTag[r.grade] || ""}</span>
        </div>
        <div class="ji-day-sub">宜：${esc(r.matched.join("、"))}　${zb ? "｜不冲" + esc(zb) + "生肖" : ""}</div>
        <div class="ji-day-hours">${r.jishi.map((h) => `<span class="hh">${esc(h.name)} ${esc(h.range)}</span>`).join("")}</div>
      </div>`).join("")
      : '<div class="empty">90 天内没有「宜' + esc(ev.name) + '」的吉日<br>宁缺勿滥，是老黄历的规矩</div>'}
  </div>`;
  $$(".ji-day-card").forEach((c) =>
    c.addEventListener("click", () => { location.hash = "#/day/" + c.dataset.date; }));
}

// ---------------- 月历页 ----------------
let calState = null;

async function renderMonth() {
  const now = Almanac.nowYmd();
  if (!calState) calState = { y: now[0], m: now[1] };
  let days;
  try {
    days = (await api(`/api/month?year=${calState.y}&month=${calState.m}`)).days;
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">${esc(e.message)}</div></div>`;
    return;
  }
  const todayStr = `${now[0]}-${String(now[1]).padStart(2, "0")}-${String(now[2]).padStart(2, "0")}`;
  const firstDow = (new Date(Date.UTC(calState.y, calState.m - 1, 1)).getUTCDay() + 6) % 7; // 周一=0
  const weeks = ["一", "二", "三", "四", "五", "六", "日"];

  let cells = "";
  for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';
  for (const day of days) {
    const g = Almanac.dayGrade(day);
    const cls = ["cal-cell", g === "good" ? "good" : g === "bad" ? "bad" : "", day.date === todayStr ? "today" : ""].join(" ");
    cells += `
    <div class="${cls}" data-date="${day.date}" title="${esc(day.day_ganzhi)} ${esc(day.chong.text)}">
      <span class="num">${day.d}</span>
      <span class="jc">${esc(day.jianchu)}</span>
      ${day.term_today ? `<span class="tm">${esc(day.term_today.name)}</span>` : ""}
    </div>`;
  }

  app.innerHTML = `
  <section>
    <div class="card">
      <div class="cal-nav">
        <button class="btn ghost small" id="cal-prev">‹ 上月</button>
        <span class="title">${calState.y}年${calState.m}月</span>
        <button class="btn ghost small" id="cal-next">下月 ›</button>
      </div>
      <div class="cal-legend">
        <span><span class="dot" style="background:var(--red-soft);border:1px solid var(--red)"></span>黄道吉日</span>
        <span><span class="dot" style="background:#fffdf6;border:1px solid var(--line)"></span>平日</span>
        <span><span class="dot" style="background:var(--dark)"></span>破日/凶日</span>
        <span><span class="dot" style="outline:1.5px solid var(--gold);outline-offset:-1.5px;background:#fffdf6"></span>今天</span>
      </div>
      <div class="cal-week">${weeks.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="cal-grid">${cells}</div>
    </div>
    <div class="hint">红底=黄道吉日（青龙/明堂/金匮/天德/玉堂/司命值日）；暗底=月破、岁破、四离四绝日；格内小字为当日建除值神，节气当日标注节气名。点任意一天看完整黄历。</div>
  </section>`;

  const nav = (delta) => {
    let y = calState.y, m = calState.m + delta;
    if (m < 1) { y--; m = 12; }
    if (m > 12) { y++; m = 1; }
    calState = { y, m };
    renderMonth();
  };
  $("#cal-prev").addEventListener("click", () => nav(-1));
  $("#cal-next").addEventListener("click", () => nav(1));
  $$(".cal-cell[data-date]").forEach((c) =>
    c.addEventListener("click", () => { location.hash = "#/day/" + c.dataset.date; }));
}

// ---------------- 节气页 ----------------
let termYear = null;

async function renderTerms() {
  const now = Almanac.nowYmd();
  if (!termYear) termYear = now[0];
  let terms;
  try {
    terms = (await api(`/api/terms?year=${termYear}`)).terms;
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">${esc(e.message)}</div></div>`;
    return;
  }
  const today = await api("/api/day?date=" + now.join("-"));
  const day = today.day;
  const cd = day.term_today
    ? `<div class="cd-name">${esc(day.term_today.name)}</div>
       <div class="cd-meta">今日${esc(day.term_today.kind)} · ${esc(day.term_today.time)} 交节</div>
       <div class="cd-days">下一个：${esc(day.next_term.name)}（剩${day.next_term.days}天）</div>`
    : `<div class="cd-name">${esc(day.next_term.name)}</div>
       <div class="cd-meta">${day.next_term.date} ${day.next_term.time} 交节 · ${esc(day.month_branch)}月建</div>
       <div class="cd-days">剩 ${day.next_term.days} 天</div>`;

  const seasons = [["春", 6], ["夏", 12], ["秋", 18], ["冬", 24]];
  let listHtml = "";
  seasons.forEach(([name, end], si) => {
    const start = si === 0 ? 0 : seasons[si - 1][1];
    listHtml += `<div class="season-h">· ${name} ·</div>`;
    for (let i = start; i < end; i++) {
      const t = terms[i];
      listHtml += `
      <div class="term-row">
        <span class="nm ${t.kind === "节" ? "jie" : ""}">${esc(t.name)}</span>
        <span class="term-badge ${t.kind === "气" ? "qi" : ""}">${esc(t.kind)}</span>
        <span class="dt">${esc(t.date)} ${esc(t.weekday)}</span>
        <span class="tm">${esc(t.time)}</span>
      </div>`;
    }
  });

  app.innerHTML = `
  <section>
    <div class="term-countdown" id="cd-box">${cd}</div>
    <div class="card">
      <div class="cal-nav">
        <button class="btn ghost small" id="ty-prev">‹ ${termYear - 1}</button>
        <span class="title">${termYear} 年 24 节气</span>
        <button class="btn ghost small" id="ty-next">${termYear + 1} ›</button>
      </div>
      ${listHtml}
      <div class="hint">「节」（红字）定月建：立春起寅月、惊蛰起卯月……「气」（平字）为中气。时刻为北京时间，由太阳视黄经天文算法精确计算。</div>
    </div>
  </section>`;
  $("#ty-prev").addEventListener("click", () => { termYear--; renderTerms(); });
  $("#ty-next").addEventListener("click", () => { termYear++; renderTerms(); });
}

// ---------------- 设置页 ----------------
async function renderSettings() {
  const cfg = await loadConfig(true);
  if (!cfg) { app.innerHTML = '<div class="card"><div class="err-box">无法读取配置</div></div>'; return; }

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>AI 讲解服务 <span class="sub">点标签可切换默认</span></h2>
      ${Object.entries(cfg.providers).map(([pid, p]) => `
        <div class="prov-card ${pid === cfg.provider ? "default" : ""}" data-pid="${pid}">
          <div class="prov-head">
            <span class="name">${esc(p.label)} ${pid === cfg.provider ? '<span class="tag red">默认</span>' : ""}</span>
            <button class="btn small ghost" data-setdefault="${pid}">设为默认</button>
          </div>
          <label class="field">接口地址（Base URL）</label>
          <input type="url" data-f="base" value="${esc(p.base)}" placeholder="https://open.bigmodel.cn/api/paas/v4">
          <div class="grid2">
            <div>
              <label class="field">协议</label>
              <select data-f="protocol">
                <option value="openai" ${p.protocol !== "anthropic" ? "selected" : ""}>OpenAI 兼容（/chat/completions）</option>
                <option value="anthropic" ${p.protocol === "anthropic" ? "selected" : ""}>Anthropic 兼容（/v1/messages）</option>
              </select>
            </div>
            <div>
              <label class="field">API Key</label>
              <input type="password" data-f="api_key" placeholder="${p.has_key ? "已保存（留空则不修改）" : "未设置"}" autocomplete="new-password">
            </div>
          </div>
          <label class="field">模型名 <span style="font-weight:400">（可下拉选择或手动输入）</span></label>
          <select data-f="model_select" hidden></select>
          <input type="text" data-f="model" value="${esc(p.model)}" placeholder="如 glm-5.3" style="margin-top:8px">
          <label class="chk-line"><input type="checkbox" data-f="fast" ${p.fast ? "checked" : ""}> 快速模式（关闭深度思考，GLM 出结果更快）</label>
          <div class="btn-row">
            <button class="btn small ghost" data-fetchmodels="${pid}">获取模型列表</button>
            <button class="btn small ghost" data-test="${pid}">测试连接</button>
          </div>
          <div class="test-line" data-line="${pid}"></div>
        </div>`).join("")}
      <div class="btn-row">
        <button class="btn primary big" id="save-cfg">保存设置</button>
      </div>
    </div>
    <div class="card">
      <h2>历法与免责</h2>
      <div class="hint">
        · 当前运行：<b>${MODE === "server" ? "服务器模式（连本机服务）" : "离线模式（App 内置历法引擎）"}</b><br>
        · 干支纪日以 2026-11-05 癸未日为锚点推算；节气为太阳视黄经天文算法（Meeus）；月建以节为界；建除交节重复前值；黄黑道起例「子午临申地……」；冲煞按日支六冲与三合组。<br>
        · 宜忌由「建除 + 黄黑道 + 彭祖百忌 + 月破岁破 + 四离四绝」按通行规则推导，宁缺勿滥；规则表与出处见项目 <code>static/rules.json</code>。<br>
        · <b>GLM 智谱</b>：到 open.bigmodel.cn 创建 API Key（Coding Plan 类型密钥需开通订阅的账号）；Key 只保存在本机，请求直连对应服务。<br>
        · 本应用为<b>民俗文化工具</b>：黄历宜忌是传统生活经验的民俗总结，不是科学预测，不构成任何现实决策依据；医疗、法律、投资等请咨询专业人士。
      </div>
    </div>
  </section>`;

  $$("[data-setdefault]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST", body: { provider: b.dataset.setdefault } });
        toast("已设为默认讲解服务");
        renderSettings();
      } catch (e) { toast(e.message); }
    }));

  function provField(pid, f) {
    const card = $(`.prov-card[data-pid="${pid}"]`);
    return card && $(`[data-f="${f}"]`, card);
  }

  function cachedModels(pid) {
    try { return JSON.parse(localStorage.getItem("almanac.models." + pid) || "[]"); } catch (e) { return []; }
  }
  function cacheModels(pid, ms) {
    try { localStorage.setItem("almanac.models." + pid, JSON.stringify(ms.slice(0, 80))); } catch (e) { /* 忽略 */ }
  }
  function fillModelSelect(card, models) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    if (!models.length) { sel.hidden = true; sel.innerHTML = ""; return; }
    sel.innerHTML = models.map((m) =>
      `<option value="${esc(m)}" ${m === mi.value.trim() ? "selected" : ""}>${esc(m)}</option>`).join("");
    sel.hidden = false;
  }
  function wireModelSelect(card) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    sel.addEventListener("change", () => { if (sel.value) mi.value = sel.value; });
    mi.addEventListener("input", () => {
      Array.from(sel.options).forEach((o) => { o.selected = o.value === mi.value.trim(); });
    });
  }

  $$(".prov-card").forEach((card) => {
    wireModelSelect(card);
    const ms = cachedModels(card.dataset.pid);
    if (ms.length) fillModelSelect(card, ms);
  });

  async function saveProviderCfg() {
    const providers = {};
    $$(".prov-card").forEach((card) => {
      const pid = card.dataset.pid;
      const get = (f) => {
        const el = $(`[data-f="${f}"]`, card);
        if (!el) return undefined;
        return el.type === "checkbox" ? el.checked : el.value.trim();
      };
      const p = { base: get("base") || "", protocol: get("protocol") || "openai", model: get("model") || "" };
      if (get("fast") !== undefined) p.fast = get("fast");
      const key = get("api_key");
      if (key) p.api_key = key;
      providers[pid] = p;
    });
    const body = { provider: cfg.provider, providers };
    try { await api("/api/config", { method: "POST", body }); } catch (e) { toast(e.message); throw e; }
  }

  $$("[data-fetchmodels]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.fetchmodels;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "获取中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        const card = $(`.prov-card[data-pid="${pid}"]`);
        cacheModels(pid, models);
        fillModelSelect(card, models);
        const mi = provField(pid, "model");
        if (models.length && !mi.value.trim()) mi.value = models[0];
        line.textContent = models.length
          ? `✓ 发现 ${models.length} 个模型，已在上方下拉可选`
          : "✗ 未发现可用模型";
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $$("[data-test]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.test;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "测试中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        line.textContent = `✓ 连接正常，可用模型 ${models.length} 个`;
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $("#save-cfg").addEventListener("click", async () => {
    const btn = $("#save-cfg");
    btn.disabled = true;
    try { await saveProviderCfg(); toast("设置已保存"); } finally { btn.disabled = false; }
  });
}

// ---------------- 启动 ----------------
async function boot() {
  // 规则数据：静态文件（服务模式与 APK 内均可直接相对路径获取）
  let rules;
  try {
    const res = await fetch("rules.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    rules = await res.json();
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">规则数据 rules.json 加载失败：${esc(e.message)}
      <br>请通过 <code>python3 app.py</code> 启动后访问，或使用安卓 App。</div></div>`;
    return;
  }
  Almanac.init(rules);
  await detectMode();
  route();
}

// 测试钩子（自动化验证离线模式，不影响正常功能）
if (typeof window !== "undefined") {
  window.__almanac = {
    get mode() { return MODE; }, set mode(v) { MODE = v; },
    clientApi, clientAIExplain, clientAIExplainStream, detectMode, route
  };
}

boot();
