#!/bin/bash
# 老黄历·择吉日 · 一键重建安卓 APK（同步前端 + Gradle 构建）
# 工具链：优先本目录 tools/，其次 ../tools，再次与六爻项目共用 ../liuyao/tools
set -e
cd "$(dirname "$0")"

# 1) 定位工具链（JDK 21 + Android SDK）：本目录 tools/ → 上级 tools/ → 六爻项目 tools/
for TOOLS in "$PWD/tools" "$PWD/../tools" "$PWD/../../liuyao/tools"; do
  if [ -x "$TOOLS/amazon-corretto-21.jdk/Contents/Home/bin/java" ] && [ -d "$TOOLS/android-sdk" ]; then
    break
  fi
done
export JAVA_HOME="$TOOLS/amazon-corretto-21.jdk/Contents/Home"
export ANDROID_HOME="$TOOLS/android-sdk"

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "✗ 缺少 JDK 21（$JAVA_HOME），请安装到 tools/（可复用 liuyao/tools）" && exit 1
fi
JAVA_MAJOR=$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')
if [ "${JAVA_MAJOR:-0}" -lt 21 ]; then
  echo "✗ JDK 版本过低（$JAVA_MAJOR < 21），请使用 JDK 21" && exit 1
fi
if [ ! -d "$ANDROID_HOME" ]; then echo "✗ 缺少 Android SDK（$ANDROID_HOME）" && exit 1; fi
echo "▸ JDK:  $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
echo "▸ SDK:  $ANDROID_HOME"

# 2) local.properties（Gradle 找 SDK 用；已存在则不动）
if [ ! -f android/local.properties ]; then
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
fi

# 3) 同步前端到 www 并交给 Capacitor
mkdir -p www && cp -R ../static/* www/
npm install --no-audit --no-fund
npx cap sync android

# 4) 清理可能携带旧 JDK 的 Gradle daemon，强制本次构建 JVM 与 JAVA_HOME 一致
(cd android && ./gradlew --stop > /dev/null 2>&1 || true)
(cd android && ./gradlew -Dorg.gradle.java.home="$JAVA_HOME" assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk ./老黄历择吉日-debug.apk

# 5) 正式签名版（keystore.properties 存在时）
if [ -f keystore.properties ]; then
  (cd android && ./gradlew -Dorg.gradle.java.home="$JAVA_HOME" assembleRelease)
  cp android/app/build/outputs/apk/release/app-release.apk ./老黄历择吉日.apk
  echo "✓ 正式版：$(pwd)/老黄历择吉日.apk"
fi
echo "✓ 调试版：$(pwd)/老黄历择吉日-debug.apk"
