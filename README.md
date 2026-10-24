# Projector Cast

Mirror your PC's screen **and sound** to an Android TV projector over Wi-Fi. Open the app on the projector, type the 6-digit code it shows into the PC app, and press **Start casting**.

- 720p 30 fps by default (smoothest on most projectors), up to 1080p 60 fps and 4K 30 fps
- PC sound is cast in stereo (Windows)
- Finds the projector by its code alone, with no IP addresses or accounts
- Works on the local network only, so nothing goes through the internet
- Cast the whole screen or **just one window** (keep working while the match plays on the projector)
- Reconnects automatically after short Wi-Fi drops
- **Updates the projector app itself**: update only the PC app, and it offers to push the new projector app over Wi-Fi

## Install

| Device | File | How |
|---|---|---|
| Projector / Android TV | `ProjectorCast.apk` | Copy it with a USB stick (or the *Send Files to TV* app), open it in the File Manager and allow *Unknown sources* if asked. |
| Windows PC | `ProjectorCast.exe` | Double-click it. Nothing gets installed. If Windows SmartScreen warns you, choose *More info → Run anyway*. If Windows Firewall asks, tick **Private networks** and press **Allow**. |

`npm run dist:win` also builds a `.zip` that contains the same PC app as a folder, if you prefer that.

### Updating

The PC app carries the latest projector app inside it. When you start casting to an older projector app, the PC app offers **Update the projector app**. The projector then shows Android's install screen: select **Install** with the remote and open Projector Cast again. The first time, Android may ask you to allow installs from Projector Cast. Projector apps older than version 1.2 can't receive updates this way, so install 1.2 by USB once.

## Use

1. On the projector, open **Projector Cast**. It shows a big code. The code stays the same every time.
2. On the PC, open **Projector Cast**, type the code, pick the quality and press **Start casting**.
3. To stop, press **Stop casting** on the PC. On the projector, pressing **Back** twice closes the app.

**What are you showing?** Choose *Videos, sport, games* for smooth motion. Choose *Documents, slides* to keep small text sharp.

**What to cast:** pick *Whole screen*, or one window under *One window*. A window keeps casting even while other windows cover it. It stops if you minimise that window. PC sound is always the whole PC's sound.

**Projector remote while casting:** **OK** shows or hides the stats panel. **◀ ▶** switch between the three display modes (*Standard*, *GPU layer*, *Canvas*), and the projector remembers your choice.

**Delay** (Advanced): *Smooth* adds about 0.15 s of buffer to ride out Wi-Fi hiccups. *Lowest delay* removes it. Casting never uses the internet, so internet speed doesn't matter. What matters is the Wi-Fi link between the PC, the router and the projector.

## If something doesn't work

| Problem | Fix |
|---|---|
| "Projector not found" | Both devices must be on the same Wi-Fi network. Some routers block devices from finding each other ("AP/client isolation", common on guest networks). In that case, type the address shown at the bottom of the projector screen into **Advanced → Projector address**. |
| Black picture on the projector | In **Advanced**, switch the codec to **VP8**. Also update **Android System WebView** on the projector from Google Play. |
| Picture is blurry or stutters | The Wi-Fi is too slow. Pick *1080p · 30 fps* or *720p*. Use 5 GHz Wi-Fi or a network cable on the PC if you can. While casting, the PC app shows live resolution, fps and Mbps and tells you when Wi-Fi is the limit. |
| Picture flickers / blinks | First look at the **preview** in the PC app while casting. **If the preview flickers too**, the flicker starts on the PC (usually a browser playing video in a hardware overlay): set **Advanced → Capture method → Compatibility**. The app restarts. Turning off hardware acceleration in the browser that plays the video also helps. **If only the projector flickers**, press **◀ ▶** on the remote to try display modes 2 and 3. |
| Picture stutters, sound is choppy | Use *720p · 30 fps*. Press **OK** on the projector remote to open the stats panel. If *Dropped* or *freezes* keeps rising while *lost packets* stays near 0, the projector's chip is too slow for the setting, so lower it. If *lost packets* keeps rising, the Wi-Fi is the problem, so move closer to the router or use 5 GHz. |
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

`receiver-android/release.keystore` signs the APK, and it is kept in this (private) repository on purpose. Every build must use the same key, or the update can't install over the installed app. If you ever make the repository public, move the key out first.

PC app:

```bash
cd sender-pc && npm install
npm start                            # run it on this computer
npm run dist:win                     # → dist/pc/ProjectorCast.exe and .zip (bundles dist/ProjectorCast.apk)
```

Build the APK first: the PC app bundles `dist/ProjectorCast.apk` and `dist/ProjectorCast.version`. To ship a projector update, raise `android:versionCode` in `receiver-android/AndroidManifest.xml`.

## Tests

`./run-tests.sh` runs four groups of checks:

1. The projector's server on a desktop JVM: discovery, code checks, lockout, escaping, size limits, update upload.
2. The PC app's network code against that real server.
3. Real WebRTC streaming between the sender code and the projector page in Chromium. This checks every quality preset, stereo sound bitrate, the delay setting, the three display modes, reconnecting and stopping.
4. The real Electron PC app driven on a virtual screen, end to end: discovery, casting the screen and a single window, the preview, pushing a projector update, and the capture-method setting.

These tests can't stand in for the projector's own Android WebView. Test on the device itself.
