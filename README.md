# Projector Cast

Wireless screen and audio mirroring from a PC to an Android TV projector on the local network.

- Pair with a 6-digit code shown on the projector; no accounts and no internet connection required
- Cast the entire screen or a single window, and switch source while casting
- Stereo audio, optionally muted on the PC
- Native hardware playback on the projector, with automatic fallback to other decoder setups
- Frame rate and resolution adapt to what the projector can decode
- The PC app updates itself from GitHub Releases and keeps the projector app up to date

## Installation

Download from [Releases](../../releases/latest):

| Device | File |
|---|---|
| Windows 10/11 | `ProjectorCast-Setup-<version>.exe` |
| macOS (Apple silicon / Intel) | `ProjectorCast-<version>-mac-arm64.dmg` / `-mac-x64.dmg` |
| Linux | `ProjectorCast-<version>-linux-x86_64.AppImage` |
| Android TV, projector, TV box, tablet (Android 5+) | `ProjectorCast.apk`, installed once from a USB drive. Later versions are installed from the PC app. |

- **Windows:** allow Projector Cast through Windows Firewall on private networks on first launch. Updates install from the app.
- **macOS:** the app is not signed. Open it with right-click → **Open** the first time, and allow it under System Settings → Privacy & Security → Screen Recording. Audio casting is not available on macOS; new versions are downloaded from the link the app shows.
- **Linux:** make the AppImage executable. Audio casting is not available on Linux.
- **Android:** the native player needs Android 7 or later; older devices use the web player. ARM and x86 devices are supported.

## Usage

1. Open Projector Cast on the projector and note the code.
2. On the PC, enter the code, choose a source and press **Start casting**.

Projector remote:

| Key | Action |
|---|---|
| OK | Show or hide status |
| ◀ ▶ | Display mode: 1 Native (default), 2 Web, 3 Web (GPU layer), 4 Web (canvas) |
| ▲ ▼ | Native decoder: hardware, hardware (buffered), software |
| Menu, or hold OK | Menu: picture settings and PC controls |
| ⏯ ⏮ ⏭ ⏪ ⏩ | Play/pause, previous, next, back, forward on the PC |
| Back ×2 | Exit |

On touch devices: tap to show or hide status, swipe left or right to change display mode, long-press for the menu.

### Picture settings

The menu adjusts **Brightness**, **Contrast** and **Colour** (−50 to +50) and **Sharpness** (0 to 100). Settings are kept on the projector and apply to every cast. Sharpness works in display mode 1 only. **Reset picture** restores the defaults. On a still picture, a change shows once the next frame arrives.

### Lip sync

Bluetooth speakers and headphones play sound late, from about 150 ms to over 500 ms on some speakers. The projector shows the picture later by the same amount. With Bluetooth this is automatic: when a speaker connects, the projector measures its delay (it plays a second of silence) and uses that. **Menu → Sound → Lip sync** shows the value (*Auto*); ◀ ▶ sets it by hand in 20 ms steps up to 1500 ms (lower it if the mouth moves after the voice, raise it if the voice comes before the mouth), and OK returns to *Auto*. The built-in speaker has its own value, 0 by default.

### Reset all settings

**Menu → Reset all settings** (press OK twice) returns the projector app to how it was when first installed: picture settings to 0, lip sync to *Auto* (the speaker is measured again), display mode 1 and the hardware decoder. The projector code does not change, so PCs that know it keep working.

### Controlling the PC

The PC section of the menu, or the media keys on the remote, control what is playing on the PC:

- **Play / pause**, **Previous**, **Next** are sent as media keys and reach whichever app is playing (browsers, Spotify, VLC and others).
- **Back** and **Forward** press ◀ / ▶ in the cast window, which seeks in most video players (YouTube: 5 s). When casting the entire screen they go to the active window.

Windows is fully supported. On Linux, players that support MPRIS are controlled through `playerctl` (install it if needed). Not available on macOS yet. Volume is set with the projector's own volume keys, since the sound plays there.

### Second screen (Windows)

**Advanced → Second screen** installs the open-source [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) (MIT) through winget. It adds a virtual monitor that extends the desktop; select it under **Source** (listed as *virtual*) and drag windows onto it. **Turn on / Turn off** enable or disable the device, and **Display settings** sets its resolution and position. These actions require administrator rights. If the driver ever causes display problems, uninstall it from Device Manager → Display adapters.

## Troubleshooting

| Symptom | Action |
|---|---|
| Projector not found | Put both devices on the same network (guest networks often block this), or enter the projector's IP address under **Advanced**. |
| Picture stalls | The projector switches decoder automatically. If it keeps stalling, choose display mode 4. |
| Picture is choppy | Use **540p, 30 fps**. The PC lowers its frame rate to what the projector decodes; the status line shows *capped at N fps*. |
| Video area black or frozen when casting a browser window | Browsers stop drawing video in covered or background windows. Keep the window visible, cast the entire screen, or turn off *Use graphics acceleration when available* in the browser's System settings. The PC app shows a notice when this happens. |
| Netflix, Disney+, Prime Video show a black picture (sound plays) | These services block screen capture of their videos as copy protection; no screen-casting app can show them. Use the service's own app on the projector, a streaming stick, or an HDMI cable. |
| Black or flashing frames | Set **Advanced → Screen capture → Compatibility** (affects whole-screen capture only). |
| No sound | Audio capture requires Windows. Check **Send sound** and the projector volume. |

**Advanced → Copy report** copies a log of PC and projector statistics from the last cast.

## Architecture

```
PC (Electron)                                   Projector (Android)
  UDP broadcast  "PCAST?<code>"  ────────────►  CastServer :47801
  HTTP POST /offer  ─────────────────────────►  CastServer :47800  →  NativePlayer or WebView
  WebRTC: H.264 / VP8 video, Opus stereo  ════►  SurfaceView / <video>
  WebRTC data channel "control"  ◄────────────  remote keys {"key": "playpause"}
```

| Path | Contents |
|---|---|
| `sender-pc/` | Electron app: capture, discovery, WebRTC sender (`cast-core.js`), UI |
| `receiver-android/` | Android app: signalling server (`CastServer.java`), native player, WebView player (`assets/receiver.html`) |
| `tests/` | JVM, Node and Playwright tests |

HTTP endpoints (all except `/ping` require the code in `X-Cast-Code`): `GET /ping`, `POST /offer`, `POST /stop`, `POST /update`, `GET /stats`. Ten wrong codes lock the server for 30 seconds.

## Building

Projector app (Debian/Ubuntu):

```bash
sudo apt install aapt apksigner android-sdk-platform-23 zipalign default-jdk unzip curl
receiver-android/build.sh        # dist/ProjectorCast.apk
```

The build downloads `io.getstream:stream-webrtc-android` and Google's D8 compiler into `receiver-android/.cache/` and verifies their SHA-256 checksums. The APK is signed with `receiver-android/release.keystore` locally, or with the `KEYSTORE_BASE64` secret on GitHub. Every release must use the same key.

PC app:

```bash
cd sender-pc && npm ci
npm start                        # run from source
npm run dist:win                 # dist/pc/ProjectorCast-Setup-<version>.exe (bundles the APK)
```

Releases are built by `.github/workflows/release.yml` when the `release` branch is pushed.

## Tests

```bash
./run-tests.sh
```

Runs the signalling server tests on a JVM, the PC network code against that server, WebRTC sessions between the sender and the web receiver in Chromium, and the Electron app end to end under Xvfb. The native Android player is tested on the device.
