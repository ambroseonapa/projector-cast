#!/bin/bash
# Runs every automated check. Needs: JDK, Node 18+, Playwright (with Chromium) and xvfb-run.
set -eo pipefail
cd "$(dirname "$0")/tests"
PW=${PLAYWRIGHT_DIR:-$(npm root -g)/playwright}
export PLAYWRIGHT_DIR="$PW"
rm -rf jvm/out && mkdir -p jvm/out
javac -nowarn -d jvm/out ../receiver-android/src/com/projectorcast/receiver/CastServer.java \
  ../receiver-android/src/com/projectorcast/receiver/SdpTools.java jvm/*.java
echo "== Projector server ==";  java -cp jvm/out ServerTest
echo "== Native player SDP rules ==";  node node/sdp-parity.test.js
java -cp jvm/out RunServer >/dev/null & S1=$!; sleep 1
echo "== PC network code =="; node node/main-network.test.js || { kill $S1; exit 1; }
node node/vdd.test.js
node node/remote-keys.test.js
kill $S1
echo "== Projector picture shader =="; node webrtc/picture-shader.test.js
echo "== WebRTC streaming =="; node webrtc/e2e.test.js | grep -v "sender over\|sender codecs"
java -Dversion=2 -cp jvm/out RelayServer >/dev/null & S2=$!; sleep 1
echo "== Real PC app ==";  xvfb-run -a -s "-screen 0 1920x1080x24" webrtc/with-wm.sh node webrtc/electron-app.test.js || { kill $S2; exit 1; }
kill $S2
echo "ALL CHECKS PASSED"
