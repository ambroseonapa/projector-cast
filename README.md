# Projector Cast

Mirror your PC's screen **and sound** to an Android TV projector over Wi-Fi. Open the app on the projector, type the 6-digit code it shows into the PC app, and press **Start casting**.

- 720p 30 fps by default (smoothest on most projectors), up to 1080p 60 fps and 4K 30 fps
- PC sound is cast in stereo (Windows)
- Finds the projector by its code alone, with no IP addresses or accounts
- Works on the local network only, so nothing goes through the internet
- Reconnects automatically after short Wi-Fi drops

## Install

| Device | File | How |
|---|---|---|
| Projector / Android TV | `ProjectorCast.apk` | Copy it with a USB stick (or the *Send Files to TV* app), open it in the File Manager and allow *Unknown sources* if asked. |
| Windows PC | `ProjectorCast.exe` | Double-click it. Nothing gets installed. If Windows SmartScreen warns you, choose *More info → Run anyway*. If Windows Firewall asks, tick **Private networks** and press **Allow**. |

`ProjectorCast-1.0.0-x64.zip` contains the same PC app as a folder, if you prefer that.

## Use

1. On the projector, open **Projector Cast**. It shows a big code. The code stays the same every time.
2. On the PC, open **Projector Cast**, type the code, pick the quality and press **Start casting**.
3. To stop, press **Stop casting** on the PC. On the projector, pressing **Back** twice closes the app.

**What are you showing?** Choose *Videos, sport, games* for smooth motion. Choose *Documents, slides* to keep small text sharp.

## If something doesn't work

| Problem | Fix |
|---|---|
| "Projector not found" | Both devices must be on the same Wi-Fi network. Some routers block devices from finding each other ("AP/client isolation", common on guest networks). In that case, type the address shown at the bottom of the projector screen into **Advanced → Projector address**. |
| Black picture on the projector | In **Advanced**, switch the codec to **VP8**. Also update **Android System WebView** on the projector from Google Play. |
| Picture is blurry or stutters | The Wi-Fi is too slow. Pick *1080p · 30 fps* or *720p*. Use 5 GHz Wi-Fi or a network cable on the PC if you can. While casting, the PC app shows live resolution, fps and Mbps and tells you when Wi-Fi is the limit. |
| Picture blinks, sound is choppy | Use *720p · 30 fps*. Press **OK** on the projector remote to open the stats panel. If *Dropped* or *freezes* keeps rising while *lost packets* stays near 0, the projector's chip is too slow for the setting, so lower it. If *lost packets* keeps rising, the Wi-Fi is the problem, so move closer to the router or use 5 GHz. |
| No sound | Sound casting needs Windows. Check that *Send PC sound* is ticked and the projector volume is up. |
| "This projector's web engine is too old" | Update **Android System WebView** (Google Play → search "Android System WebView"). |

## How it works

```
PC app (Electron)                                Projector app (Android)
  ├─ UDP broadcast "PCAST?<code>"  ───────────►  CastServer (port 47801) replies if the code matches
  ├─ HTTP POST /offer (port 47800) ───────────►  CastServer → WebView page creates the WebRTC answer
  └─ WebRTC: H.264/VP8 video + Opus stereo ═══►  <video> full screen
```

- `receiver-android/`: the projector app. A small Java HTTP/UDP server (`CastServer.java`) and a full-screen WebView page (`assets/receiver.html`) that plays the WebRTC stream. No Google libraries are needed.
- `sender-pc/`: the PC app. `main.js` handles screen capture, Windows loopback sound, discovery and HTTP. `cast-core.js` handles the WebRTC session and tuning. `renderer.js` and `index.html` are the UI.
- After 10 wrong codes, the projector refuses all connection attempts for 30 seconds.

## Build

Projector APK (Ubuntu/Debian, no Android Studio needed):

```bash
sudo apt install aapt apksigner dalvik-exchange android-sdk-platform-23 zipalign default-jdk
receiver-android/build.sh            # → dist/ProjectorCast.apk
```

The first build creates `receiver-android/release.keystore`. Keep it. An APK built with a different key can't install over the old one (you'd have to uninstall first). It is git-ignored on purpose.

PC app:

```bash
cd sender-pc && npm install
npm start                            # run it on this computer
npm run dist:win                     # → dist/pc/ProjectorCast.exe and .zip
```

## Tests

`./run-tests.sh` runs four groups of checks:

1. The projector's server on a desktop JVM: discovery, code checks, lockout, escaping, size limits.
2. The PC app's network code against that real server.
3. Real WebRTC streaming between the sender code and the projector page in Chromium. This checks 1080p60/H.264, 1080p30/VP8 and 720p60, stereo sound, reconnecting and stopping.
4. The real Electron PC app driven on a virtual screen, end to end.

These tests can't stand in for the projector's own Android WebView. Test on the device itself.
