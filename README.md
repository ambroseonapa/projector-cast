# Projector Cast

Mirror your PC's screen **and sound** to an Android TV projector over Wi-Fi. Open the app on the projector, type the 6-digit code it shows into the PC app, and press **Start casting**.

- **Native player** on the projector: hardware video decoding straight to the screen (no web engine, no flicker)
- 720p 60 fps by default, up to 1080p 60 fps and 4K 30 fps
- PC sound is cast in stereo (Windows)
- Finds the projector by its code alone, with no IP addresses or accounts
- Works on the local network only, so nothing goes through the internet
- Cast the whole screen or **just one window** (keep working while the match plays on the projector)
- Sound plays on the projector only; the PC's speakers are muted while casting (can be switched off)
- Change quality, content type and delay **while casting**
- Reconnects automatically after short Wi-Fi drops
- **Updates the projector app itself**: update only the PC app, and it offers to push the new projector app over Wi-Fi

## Download

Open the repository's **Releases** page (right-hand side of the repository's main page, or `/releases` after the repository address) and download the files under **Assets**:

| Device | File | How |
|---|---|---|
| Windows PC | `ProjectorCast-Setup-<version>.exe` | Double-click it. It installs Projector Cast with a Start menu and desktop shortcut. If Windows SmartScreen warns you, choose *More info → Run anyway*. If Windows Firewall asks, tick **Private networks** and press **Allow**. |
| Projector / Android TV | `ProjectorCast.apk` | The first time only: copy it with a USB stick (or the *Send Files to TV* app), open it in the File Manager and allow *Unknown sources* if asked. After that the PC app updates it. |

New releases are built by GitHub itself (`.github/workflows/release.yml`) whenever a version tag such as `v1.3.0` is pushed.

### Updating

The PC app carries the latest projector app inside it. When you start casting to an older projector app, the PC app offers **Update the projector app**. The projector then shows Android's install screen: select **Install** with the remote and open Projector Cast again. The first time, Android may ask you to allow installs from Projector Cast. Projector apps older than version 1.4 can't always install updates this way (some projectors have no app that opens APK files), so install 1.4 by USB once. From 1.4 on, updates go through Android's own installer.

## Use

1. On the projector, open **Projector Cast**. It shows a big code. The code stays the same every time.
2. On the PC, open **Projector Cast**, type the code, pick the quality and press **Start casting**.
3. To stop, press **Stop casting** on the PC. On the projector, pressing **Back** twice closes the app.

**What are you showing?** Choose *Videos, sport, games* for smooth motion. Choose *Documents, slides* to keep small text sharp.

**What to cast:** click the *What to cast* panel to unfold it, then click a card under *Whole screen* or *One window* (↻ Refresh updates the list). The panel folds itself again and shows your pick. While casting, the same panel under **⚙ Settings while casting** switches what is cast straight away, without reconnecting. A window keeps casting even while other windows cover it, so you can keep working. Don't minimise it. If the picked window has closed, the app refuses to start instead of showing your whole screen. PC sound is always the whole PC's sound. With *Play sound only on the projector* ticked, the PC's own speakers are muted while casting.

**Projector remote while casting:** **OK** shows or hides the stats panel. **◀ ▶** switch display modes, and the projector remembers your choice:

1. **Native** (default): the projector's hardware decoder draws straight to the screen. Smoothest, no flicker.
2. **Web standard**, 3. **Web GPU layer**, 4. **Web canvas**: the older web-engine player, kept as a backup.

Switching between Native and the web modes reconnects automatically within a couple of seconds.

**Settings while casting:** open **⚙ Settings while casting** in the PC app to change quality, content type or delay without stopping.

**Delay** (Advanced): *Smooth* adds about 0.15 s of buffer to ride out Wi-Fi hiccups. *Lowest delay* removes it. Casting never uses the internet, so internet speed doesn't matter. What matters is the Wi-Fi link between the PC, the router and the projector.

## If something doesn't work

| Problem | Fix |
|---|---|
| "Projector not found" | Both devices must be on the same Wi-Fi network. Some routers block devices from finding each other ("AP/client isolation", common on guest networks). In that case, type the address shown at the bottom of the projector screen into **Advanced → Projector address**. |
| Black picture on the projector | In **Advanced**, switch the codec to **VP8**. Also update **Android System WebView** on the projector from Google Play. |
| Picture is blurry or stutters | The Wi-Fi is too slow. Pick *1080p · 30 fps* or *720p*. Use 5 GHz Wi-Fi or a network cable on the PC if you can. While casting, the PC app shows live resolution, fps and Mbps and tells you when Wi-Fi is the limit. |
| Picture flickers / blinks | Make sure the projector shows **display mode 1/4 Native** (bottom of its code screen; change with **◀ ▶**). If it still flickers, look at the **preview** in the PC app while casting. **If the preview flickers too**, the flicker starts on the PC (usually a browser playing video in a hardware overlay): set **Advanced → Capture method → Compatibility**. The app restarts. Turning off hardware acceleration in the browser that plays the video also helps. **If only the projector flickers**, press **◀ ▶** on the remote to try display modes 2 and 3. |
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
sudo apt install aapt apksigner android-sdk-platform-23 zipalign default-jdk unzip curl
receiver-android/build.sh            # → dist/ProjectorCast.apk
```

The build downloads the native WebRTC player (`io.getstream:stream-webrtc-android` from Maven Central) and Google's D8 compiler once into `receiver-android/.cache/`, and checks both against fixed SHA-256 sums.

`receiver-android/release.keystore` signs the APK, and it is kept in this (private) repository on purpose. Every build must use the same key, or the update can't install over the installed app. If you ever make the repository public, move the key out first.

PC app:

```bash
cd sender-pc && npm install
npm start                            # run it on this computer
npm run dist:win                     # → dist/pc/ProjectorCast-Setup-<version>.exe (bundles dist/ProjectorCast.apk)
```

Build the APK first: the PC app bundles `dist/ProjectorCast.apk` and `dist/ProjectorCast.version`. To ship a projector update, raise `android:versionCode` in `receiver-android/AndroidManifest.xml`.

## Tests

`./run-tests.sh` runs four groups of checks:

1. The projector's server on a desktop JVM: discovery, code checks, lockout, escaping, size limits, update upload. Also checks that the native player's SDP rules match the web player's on real Chrome SDP.
2. The PC app's network code against that real server.
3. Real WebRTC streaming between the sender code and the projector page in Chromium. This checks every quality preset, stereo sound bitrate, the delay setting, the three display modes, reconnecting and stopping.
4. The real Electron PC app driven on a virtual screen, end to end: discovery, casting the screen and a single window, refusing a closed window, the preview, changing quality while casting, reconnecting after the projector drops the connection, pushing a projector update, and the capture-method setting.

The native Android player can't run here, so test it on the projector itself.


