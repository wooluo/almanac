#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""老黄历·择吉日 · 本地服务（Python 标准库，零依赖）

- 提供网页与 JSON API：当日黄历 / 整月日历 / 全年节气（由 almanac.py 精确计算）
- 代理 LLM 白话讲解（流式）：GLM 等 OpenAI/Anthropic 兼容服务，配置存 data/config.json
- 前端内置同源 JS 引擎（engine.js），离线（APK/无服务）时全部功能本地完成

用法：
    python3 app.py                # http://127.0.0.1:8780
    python3 app.py --host 0.0.0.0 # 局域网内手机也可访问
"""
import argparse
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import almanac  # noqa: E402

DATA_DIR = os.environ.get("ALMANAC_DATA_DIR", os.path.join(BASE, "data"))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
_LOCK = threading.RLock()

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}

DEFAULT_CONFIG = {
    "provider": "glm",
    "providers": {
        "glm": {
            "label": "GLM 智谱（Coding Plan）", "protocol": "openai",
            "base": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3", "api_key": "",
        },
    },
}

# ---------------------------------------------------------------- LLM 提示词

SYSTEM_ALMANAC = """你是一位精通中国传统历法（干支、节气、建除十二神、黄道黑道、彭祖百忌）的文化科普作者，用通俗易懂、有趣的现代汉语讲解老黄历。
用户会提供某天的完整黄历数据（干支纪年月日、月建、节气、建除值神、黄黑道值神、冲煞、彭祖百忌、宜忌、吉时等）。这些数据已由程序按天文历法精确计算，你必须直接采信，禁止重新推算、更改或质疑任何数据。
讲解要求：
1. 若用户指定了事项（如「为什么今天忌动土」），围绕该事项展开：先引用当日具体的历法依据（建除值神及其含义、黄黑道、彭祖百忌、冲煞等），再用白话解释这些名词背后的古人生活逻辑与民俗心理。
2. 若未指定事项，则概述当日黄历要点：干支与生肖、节气、宜忌大势、吉时建议。
3. 讲清「为什么」：把术语翻译成现代生活的类比，突出文化内涵与古人智慧，避免神秘主义渲染，不渲染焦虑。
4. 语气轻松友好，可适度幽默；用「## 小标题」和要点列表组织内容；不要输出 Markdown 表格。
5. 明确说明这是民俗文化参考，不是科学预测，不构成任何现实决策依据；涉及医疗、法律、投资等事项应咨询专业人士。
6. 结尾固定附一句：以上为民俗文化科普，仅供参考。"""


# ---------------------------------------------------------------- 存取工具

def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_config():
    cfg = _load_json(CONFIG_PATH, {})
    if not isinstance(cfg, dict):
        cfg = {}
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    out["provider"] = cfg.get("provider", out["provider"])
    for pid, p in (cfg.get("providers") or {}).items():
        if pid in out["providers"] and isinstance(p, dict):
            for k in ("label", "protocol", "base", "model"):
                if isinstance(p.get(k), str):
                    out["providers"][pid][k] = p[k]
            if isinstance(p.get("fast"), bool):
                out["providers"][pid]["fast"] = p["fast"]
            if isinstance(p.get("api_key"), str) and p["api_key"]:
                out["providers"][pid]["api_key"] = p["api_key"]
        elif isinstance(p, dict):  # 用户自定义的 provider
            out["providers"][pid] = {
                "label": p.get("label") or pid, "protocol": p.get("protocol") or "openai",
                "base": p.get("base") or "", "model": p.get("model") or "",
                "api_key": p.get("api_key") or ""}
    if out["provider"] not in out["providers"]:
        out["provider"] = "glm"
    return out


def save_config(cfg):
    with _LOCK:
        _save_json_atomic(CONFIG_PATH, cfg)


# ---------------------------------------------------------------- LLM 上游

def _local_tz_hours():
    try:
        off = datetime.now().astimezone().utcoffset()
        return off.total_seconds() / 3600.0
    except Exception:
        return 8.0


def _is_local_url(url):
    """本地/回环地址判断（这些地址必须绕过系统代理直连）。"""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or host.endswith(".local")


# 本地直连 opener（无视系统代理，否则 Clash 类代理会对 localhost 返回 502）
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def smart_urlopen(req, timeout):
    """本地地址直连，远程地址尊重环境/系统代理。"""
    if _is_local_url(req.full_url):
        return _DIRECT_OPENER.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_models(pcfg, timeout=8):
    base = (pcfg.get("base") or "").rstrip("/")
    if not base:
        return []
    url = base + ("/v1/models" if pcfg.get("protocol") == "anthropic" else "/models")
    headers = {}
    key = pcfg.get("api_key") or ""
    if key:
        headers["Authorization"] = "Bearer " + key
        headers["x-api-key"] = key
    req = urllib.request.Request(url, headers=headers, method="GET")
    with smart_urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    ids = []
    for item in data.get("data", []):
        mid = item.get("id") if isinstance(item, dict) else None
        if mid:
            ids.append(mid)
    return ids


# 自动选模型时排除非对话模型（embedding/OCR/语音等）
_NON_CHAT_MODEL = re.compile(r"embed|rerank|ocr|whisper|speech|tts|stt|audio|clip", re.I)


def resolve_model(pcfg):
    model = (pcfg.get("model") or "").strip()
    if model:
        return model
    try:
        models = fetch_models(pcfg)
    except Exception:
        models = []
    chat = [m for m in models if not _NON_CHAT_MODEL.search(m)]
    pool = chat or models
    return pool[0] if pool else ""


def open_upstream(pcfg, model, system, user):
    base = (pcfg.get("base") or "").rstrip("/")
    key = pcfg.get("api_key") or ""
    if pcfg.get("protocol") == "anthropic":
        url = base + "/v1/messages"
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if key:
            headers["x-api-key"] = key
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "max_tokens": 4096, "temperature": 0.7,
                   "system": system, "stream": True,
                   "messages": [{"role": "user", "content": user}]}
    else:
        url = base + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "temperature": 0.7, "stream": True,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}]}
    # 快速模式：智谱系端点关闭深度思考，显著缩短等待
    if pcfg.get("fast") and re.search(r"(bigmodel|z\.ai)", base):
        payload["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    return smart_urlopen(req, timeout=600)


def _extract_full_text(obj):
    try:
        if "choices" in obj:
            return obj["choices"][0].get("message", {}).get("content") or ""
        if isinstance(obj.get("content"), list):
            return "".join(b.get("text", "") for b in obj["content"] if isinstance(b, dict))
    except Exception:
        pass
    return ""


def iter_deltas(resp):
    """把上游 SSE/JSON 响应解析成文本增量（兼容 OpenAI 与 Anthropic 两种事件格式）。"""
    ct = (resp.headers.get("content-type") or "").lower()
    if "event-stream" not in ct:
        yield _extract_full_text(json.loads(resp.read().decode("utf-8")))
        return
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield text
            continue
        if obj.get("type") == "content_block_delta":
            text = (obj.get("delta") or {}).get("text")
            if text:
                yield text


# ---------------------------------------------------------------- HTTP Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "Almanac/1.0"

    def log_message(self, fmt, *args):  # 静默常规访问日志
        pass

    # ---------- 基础工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1 << 20:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        self._send_file(full)

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            cfg = load_config()
            for p in cfg["providers"].values():
                p["has_key"] = bool(p.get("api_key"))
                p["api_key"] = ""
            self._send_json(cfg)
        elif path == "/api/day":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                y, m, d = (int(x) for x in ((qs.get("date") or [""])[0]).split("-"))
                day = almanac.build_day(y, m, d, tz=_local_tz_hours())
            except (ValueError, TypeError):
                self._send_json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
                return
            self._send_json({"day": day})
        elif path == "/api/month":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                y, m = int((qs.get("year") or [""])[0]), int((qs.get("month") or [""])[0])
                days = almanac.month_grid(y, m, tz=_local_tz_hours())
            except (ValueError, TypeError):
                self._send_json({"error": "year/month 参数不合法"}, 400)
                return
            self._send_json({"days": days})
        elif path == "/api/terms":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                y = int((qs.get("year") or [""])[0])
                terms = almanac.year_terms(y, tz=_local_tz_hours())
            except (ValueError, TypeError):
                self._send_json({"error": "year 参数不合法"}, 400)
                return
            out = [{"name": t["name"], "kind": t["kind"], "branch": t["branch"],
                    "date": "%04d-%02d-%02d" % t["date"], "time": t["time"]}
                   for t in terms]
            self._send_json({"terms": out})
        elif path == "/api/models":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pid = (qs.get("provider") or [""])[0]
            cfg = load_config()
            pcfg = cfg["providers"].get(pid)
            if not pcfg:
                self._send_json({"error": "未知 provider"}, 400)
                return
            try:
                self._send_json({"models": fetch_models(pcfg)})
            except Exception as e:
                self._send_json({"error": "获取模型列表失败：%s" % e}, 502)
        elif path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:  # 静态资源（相对路径或 /static/ 均可，供网页与 APK 复用同一套前端）
            rel = path.lstrip("/")
            if not rel or rel == "index.html":
                self._send_file(os.path.join(STATIC_DIR, "index.html"))
            elif rel == "favicon.ico":
                self.send_response(204)
                self.end_headers()
            else:
                if rel.startswith("static/"):
                    rel = rel[len("static/"):]
                self._serve_static(rel)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            self._handle_config()
        elif path == "/api/aiexplain":
            self._handle_aiexplain()
        else:
            self._send_json({"error": "not found"}, 404)

    # ---------- 业务 ----------
    def _handle_config(self):
        body = self._read_json()
        with _LOCK:
            cfg = load_config()
            if body.get("provider") in cfg["providers"]:
                cfg["provider"] = body["provider"]
            for pid, p in (body.get("providers") or {}).items():
                if not isinstance(p, dict) or pid not in cfg["providers"]:
                    continue
                tgt = cfg["providers"][pid]
                for k in ("label", "protocol", "base", "model"):
                    if isinstance(p.get(k), str):
                        tgt[k] = p[k].strip()
                if p.get("protocol") not in ("openai", "anthropic"):
                    tgt["protocol"] = "openai"
                if isinstance(p.get("fast"), bool):
                    tgt["fast"] = p["fast"]
                key = p.get("api_key")
                if isinstance(key, str) and key.strip():
                    tgt["api_key"] = key.strip()
            save_config(cfg)
        self._send_json({"ok": True})

    def _handle_aiexplain(self):
        body = self._read_json()
        try:
            y, m, d = (int(x) for x in (body.get("date") or "").split("-"))
        except (ValueError, TypeError):
            self._send_json({"error": "日期格式应为 YYYY-MM-DD"}, 400)
            return
        question = (body.get("question") or "").strip()[:120]
        cfg = load_config()
        pid = body.get("provider") or cfg.get("provider")
        pcfg = cfg["providers"].get(pid)
        if not pcfg:
            self._send_json({"error": "未知 provider：%s" % pid}, 400)
            return
        try:
            day = almanac.build_day(y, m, d, tz=_local_tz_hours())
        except Exception:
            self._send_json({"error": "日期不合法"}, 400)
            return

        model = resolve_model(pcfg)
        if not model:
            self._send_json({"error": "未配置模型名，且无法从 %s 获取模型列表。请在设置里填写模型。"
                                      % pcfg.get("label", pid)}, 502)
            return
        system, user = SYSTEM_ALMANAC, almanac.almanac_text(day, question)
        try:
            resp = open_upstream(pcfg, model, system, user)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            self._send_json({"error": "上游返回 HTTP %d：%s" % (e.code, detail)}, 502)
            return
        except Exception as e:
            self._send_json({"error": "无法连接 %s：%s（请检查网络与接口地址）"
                                      % (pcfg.get("label", pid), e)}, 502)
            return

        # 上游 OK：开始向浏览器流式转发（HTTP/1.0 风格：无 Content-Length，关连接即结束）
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            for delta in iter_deltas(resp):
                if not delta:
                    continue
                self.wfile.write(delta.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中断
        except Exception as e:
            try:
                self.wfile.write(("\n\n[上游流中断：%s]" % e).encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="老黄历·择吉日 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8780)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        save_config(json.loads(json.dumps(DEFAULT_CONFIG)))

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("老黄历·择吉日 服务已启动")
    print("  本机访问:  http://127.0.0.1:%d" % args.port)
    if args.host not in ("127.0.0.1", "localhost"):
        print("  局域网访问: http://<本机IP>:%d （手机同 Wi-Fi 可用）" % args.port)
    print("  数据目录:  %s" % DATA_DIR)
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
