package com.wooluo.almanac;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 原生 SSE 流式 HTTP 插件（AI 解卦流式输出，绕过 WebView CORS）
        registerPlugin(StreamHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
