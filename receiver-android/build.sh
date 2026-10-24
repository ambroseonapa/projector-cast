#!/bin/bash
# Builds ProjectorCast.apk without Gradle, using Ubuntu's packages:
#   sudo apt install aapt apksigner dalvik-exchange android-sdk-platform-23 zipalign openjdk-17-jdk
set -e
cd "$(dirname "$0")"
SDK=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
rm -rf build && mkdir -p build/gen build/classes
aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$SDK"
javac -Xlint:-options -source 8 -target 8 -bootclasspath "$SDK" -d build/classes $(find src build/gen -name '*.java')
dalvik-exchange --dex --output=build/classes.dex build/classes
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK" -F build/unsigned.apk
(cd build && aapt add unsigned.apk classes.dex >/dev/null)
zipalign -f 4 build/unsigned.apk build/aligned.apk
KS=${KEYSTORE:-release.keystore}
PASS=${KEYSTORE_PASS:-projectorcast}
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" \
  -alias cast -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Projector Cast" >/dev/null 2>&1
mkdir -p ../dist
apksigner sign --ks "$KS" --ks-pass pass:"$PASS" --out ../dist/ProjectorCast.apk build/aligned.apk
apksigner verify ../dist/ProjectorCast.apk && echo "Built ../dist/ProjectorCast.apk"
