#!/bin/bash
# Runs every automated check. Needs: JDK, Node 18+, Playwright (with Chromium) and xvfb-run.
set -eo pipefail
cd "$(dirname "$0")/tests"
PW=${PLAYWRIGHT_DIR:-$(npm root -g)/playwright}
export PLAYWRIGHT_DIR="$PW"
rm -rf jvm/out && mkdir -p jvm/out
javac -nowarn -d jvm/out ../receiver-android/src/com/projectorcast/receiver/CastServer.java jvm/*.java
echo "== Projector server ==";  java -cp jvm/out ServerTest
java -cp jvm/out RunServer >/dev/null & S1=$!; sleep 1
echo "== PC network code =="; node node/main-network.test.js || { kill $S1; exit 1; }
kill $S1
echo "== WebRTC streaming =="; node webrtc/e2e.test.js | grep -v "sender over\|sender codecs"
java -cp jvm/out RelayServer >/dev/null & S2=$!; sleep 1
echo "== Real PC app ==";  xvfb-run -a -s "-screen 0 1920x1080x24" node webrtc/electron-app.test.js || { kill $S2; exit 1; }
kill $S2
echo "ALL CHECKS PASSED"
