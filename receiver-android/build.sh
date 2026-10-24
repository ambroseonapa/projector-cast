#!/bin/bash
# Builds ProjectorCast.apk without Gradle or Android Studio.
#   sudo apt install aapt apksigner android-sdk-platform-23 zipalign default-jdk unzip curl
# The native WebRTC player library and Google's D8 dex compiler are downloaded once into .cache/
# and checked against fixed SHA-256 sums.
set -eo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}
CACHE=.cache
mkdir -p "$CACHE"

fetch() { # url... file sha256
  local file=$1 sum=$2; shift 2
  if [ ! -f "$CACHE/$file" ] || ! echo "$sum  $CACHE/$file" | sha256sum -c --status; then
    for url in "$@"; do
      curl -sSfL --retry 3 -o "$CACHE/$file.part" "$url" && break || true
    done
    echo "$sum  $CACHE/$file.part" | sha256sum -c --status || { echo "Checksum mismatch for $file" >&2; exit 1; }
    mv "$CACHE/$file.part" "$CACHE/$file"
  fi
}

WEBRTC=stream-webrtc-android-1.3.10.aar
fetch $WEBRTC afa3b0feaa2902f6ece10e67ce3b7e6d9def18a86b73f0c6a524209cb938aa96 \
  https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/1.3.10/$WEBRTC \
  https://maven-central.storage-download.googleapis.com/maven2/io/getstream/stream-webrtc-android/1.3.10/$WEBRTC
D8JAR=r8lib-8.5.35.jar
fetch $D8JAR 4733945987ee0a840fafc34080b135259e01678412e07212b23f706334290294 \
  https://storage.googleapis.com/r8-releases/raw/8.5.35/r8lib.jar

rm -rf build && mkdir -p build/gen build/classes build/dex build/webrtc build/apk/lib
unzip -q -o "$CACHE/$WEBRTC" classes.jar 'jni/*' -d build/webrtc
# ARM only: what Android TV boxes and projectors use (skips ~25 MB of x86 code).
for abi in armeabi-v7a arm64-v8a; do cp -r build/webrtc/jni/$abi build/apk/lib/; done

aapt package -f -m -J build/gen -M AndroidManifest.xml -S res -I "$SDK"
javac -Xlint:-options -source 8 -target 8 -bootclasspath "$SDK" -cp build/webrtc/classes.jar \
  -d build/classes $(find src build/gen -name '*.java')
(cd build/classes && jar cf ../app-classes.jar .)
java -cp "$CACHE/$D8JAR" com.android.tools.r8.D8 --release --min-api 21 --lib "$SDK" \
  --output build/dex build/app-classes.jar build/webrtc/classes.jar 2>&1 | grep -v "^Warning\|JAVA_TOOL_OPTIONS" || true
ls build/dex/classes*.dex >/dev/null

aapt package -f -M AndroidManifest.xml -S res -A assets -I "$SDK" -F build/unsigned.apk
cp build/dex/classes*.dex build/apk/
(cd build/apk && aapt add ../unsigned.apk classes*.dex $(find lib -name '*.so') >/dev/null)
zipalign -f -p 4 build/unsigned.apk build/aligned.apk
KS=${KEYSTORE:-release.keystore}
PASS=${KEYSTORE_PASS:-projectorcast}
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" \
  -alias cast -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Projector Cast" >/dev/null 2>&1
mkdir -p ../dist
apksigner sign --ks "$KS" --ks-pass pass:"$PASS" --out ../dist/ProjectorCast.apk build/aligned.apk
apksigner verify ../dist/ProjectorCast.apk
# The PC app bundles the APK and uses this number to decide whether the projector needs updating.
sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' AndroidManifest.xml > ../dist/ProjectorCast.version
echo "Built ../dist/ProjectorCast.apk (version $(cat ../dist/ProjectorCast.version))"
