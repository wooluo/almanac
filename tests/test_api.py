# -*- coding: utf-8 -*-
"""API 集成测试：静态页 / 黄历 API / 配置 / LLM 流式代理。

内置一个 stub LLM（OpenAI 兼容 SSE），验证：
- /api/day、/api/month、/api/terms 由 almanac.py 计算且与引擎直调一致
- /api/aiexplain 流式转发（含提示词内容断言）
- /api/config 读写、Key 脱敏；/api/models；静态资源（rules.json/engine.js）
- 本地代理直连回归（系统代理存在时 localhost 必须绕过）
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["ALMANAC_DATA_DIR"] = tempfile.mkdtemp(prefix="almanac-test-")
sys.path.insert(0, BASE_DIR)

import app as appmod       # noqa: E402
import almanac             # noqa: E402


class StubLLM(BaseHTTPRequestHandler):
    last_request = None

    def log_message(self, *a):
        pass

    def do_POST(self):  # chat/completions (SSE)
        length = int(self.headers.get("Content-Length") or 0)
        StubLLM.last_request = json.loads(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for piece in ["## 今日概览\n", "测试", "讲解", "文本。"]:
            chunk = {"choices": [{"delta": {"content": piece}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):  # /models
        body = json.dumps({"data": [{"id": "stub-model"},
                                     {"id": "text-embedding-x"},
                                     {"id": "stub-mini"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubLLM)
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        stub_port = cls.stub.server_address[1]

        cfg = json.loads(json.dumps(appmod.DEFAULT_CONFIG))
        cfg["provider"] = "glm"
        cfg["providers"]["glm"]["base"] = "http://127.0.0.1:%d/v1" % stub_port
        cfg["providers"]["glm"]["model"] = ""  # 留空 → 从 /models 自动取第一个非 embedding 模型
        appmod.save_config(cfg)

        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.stub.shutdown()

    def request(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, data=data, timeout=15) as resp:
            return resp.read().decode()

    # ---------- 静态资源 ----------
    def test_01_static(self):
        html = self.request("GET", "/")
        self.assertIn("老黄历", html)
        self.assertIn("engine.js", html)
        js = self.request("GET", "/static/engine.js")
        self.assertIn("buildDay", js)
        appjs = self.request("GET", "/app.js")
        self.assertIn("startAI", appjs)
        rules = self.request("GET", "/rules.json")
        self.assertIn("jianchu_rules", rules)
        rules2 = self.request("GET", "/static/rules.json")  # /static/ 前缀同样可达
        self.assertIn("彭祖百忌", rules2)

    # ---------- 黄历 API 与引擎一致 ----------
    def test_02_day(self):
        out = json.loads(self.request("GET", "/api/day?date=2026-11-05"))
        day = out["day"]
        want = almanac.build_day(2026, 11, 5, tz=appmod._local_tz_hours())
        self.assertEqual(json.dumps(day, sort_keys=True, ensure_ascii=False),
                         json.dumps(want, sort_keys=True, ensure_ascii=False))
        self.assertEqual(day["day_ganzhi"], "癸未")
        self.assertEqual(day["jianchu"], "收")
        self.assertEqual(day["huanghei"]["name"], "朱雀")
        self.assertEqual(day["chong"]["text"], "冲牛（丁丑）煞西")

    def test_02b_day_bad_400(self):
        try:
            self.request("GET", "/api/day?date=bad")
            self.fail("bad date 应 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_03_month(self):
        out = json.loads(self.request("GET", "/api/month?year=2026&month=11"))
        self.assertEqual(len(out["days"]), 30)
        self.assertEqual(out["days"][0]["date"], "2026-11-01")
        want = almanac.month_grid(2026, 11, tz=appmod._local_tz_hours())
        self.assertEqual(json.dumps(out["days"], sort_keys=True, ensure_ascii=False),
                         json.dumps(want, sort_keys=True, ensure_ascii=False))

    def test_04_terms(self):
        out = json.loads(self.request("GET", "/api/terms?year=2026"))
        ts = out["terms"]
        self.assertEqual(len(ts), 24)
        lid = [t for t in ts if t["name"] == "立冬"][0]
        self.assertEqual((lid["date"], lid["time"]), ("2026-11-07", "17:51"))

    # ---------- 配置 ----------
    def test_05_config_roundtrip(self):
        # 先写 Key，再读：读取脱敏（has_key=true 但 api_key 为空）
        self.request("POST", "/api/config", {
            "provider": "glm",
            "providers": {"glm": {"model": "glm-5.3", "api_key": "TESTKEY123"}}})
        out = json.loads(self.request("GET", "/api/config"))
        self.assertIn("glm", out["providers"])
        self.assertTrue(out["providers"]["glm"]["has_key"])
        self.assertEqual(out["providers"]["glm"]["api_key"], "")
        self.assertEqual(appmod.load_config()["providers"]["glm"]["api_key"], "TESTKEY123")
        # 空 Key 不覆盖已存 Key
        self.request("POST", "/api/config", {"providers": {"glm": {"api_key": "  "}}})
        self.assertEqual(appmod.load_config()["providers"]["glm"]["api_key"], "TESTKEY123")
        # 未知 provider 忽略
        self.request("POST", "/api/config", {"provider": "nope"})
        self.assertEqual(appmod.load_config()["provider"], "glm")

    def test_06_models(self):
        out = json.loads(self.request("GET", "/api/models?provider=glm"))
        self.assertEqual(out["models"][0], "stub-model")
        try:
            self.request("GET", "/api/models?provider=nope")
            self.fail("未知 provider 应 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    # ---------- AI 讲解全链路（stub LLM） ----------
    def test_07_aiexplain_stream(self):
        # 重置模型名为空 → 走「/models 自动取第一个非 embedding 模型」路径
        self.request("POST", "/api/config", {"providers": {"glm": {"model": ""}}})
        raw = self.request("POST", "/api/aiexplain",
                           {"date": "2026-11-05", "question": "为什么今天忌动土", "provider": "glm"})
        self.assertEqual(raw, "## 今日概览\n测试讲解文本。")
        body = StubLLM.last_request
        self.assertEqual(body["model"], "stub-model")
        sysmsg = body["messages"][0]["content"]
        user = body["messages"][-1]["content"]
        self.assertIn("文化科普", sysmsg)
        for kw in ("癸未", "收日", "朱雀", "冲牛（丁丑）煞西", "癸不词讼理弱敌强",
                   "为什么今天忌动土", "纳财"):
            self.assertIn(kw, user)
        self.assertNotIn("词讼理弱敌强", sysmsg)  # 黄历数据在 user 消息里，不在 system

    def test_07b_aiexplain_bad(self):
        try:
            self.request("POST", "/api/aiexplain", {"date": "xx"})
            self.fail("bad date 应 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
        try:
            self.request("POST", "/api/aiexplain", {"date": "2026-11-05", "provider": "nope"})
            self.fail("未知 provider 应 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    # ---------- 回归：本地地址绕过系统代理 ----------
    def test_08_proxy_bypass_local(self):
        bogus = "http://127.0.0.1:9"  # 无人监听的代理端口
        saved = {k: os.environ.get(k) for k in
                 ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")}
        try:
            for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
                os.environ[k] = bogus
            models = appmod.fetch_models(
                {"base": "http://127.0.0.1:%d/v1" % self.stub.server_address[1],
                 "protocol": "openai"})
            self.assertEqual(models[0], "stub-model")
            self.assertTrue(appmod._is_local_url("http://localhost:1234/v1"))
            self.assertFalse(appmod._is_local_url("https://open.bigmodel.cn/api/paas/v4"))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_09_resolve_model_skips_embedding(self):
        orig = appmod.fetch_models
        appmod.fetch_models = lambda p, timeout=8: [
            "text-embedding-nomic-embed-text-v1.5", "glm-5.3"]
        try:
            self.assertEqual(
                appmod.resolve_model({"model": "", "base": "x", "protocol": "openai"}),
                "glm-5.3")
            self.assertEqual(appmod.resolve_model({"model": "手选模型"}), "手选模型")
        finally:
            appmod.fetch_models = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
