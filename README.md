# Projector Cast

Wireless screen and audio mirroring from a Windows PC to an Android TV projector on the local network.

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
| Windows PC | `ProjectorCast-Setup-<version>.exe` |
| Android TV / projector | `ProjectorCast.apk`, installed once from a USB drive. Later versions are installed from the PC app. |

On first launch, allow Projector Cast through Windows Firewall on private networks.

## Usage

1. Open Projector Cast on the projector and note the code.
2. On the PC, enter the code, choose a source and press **Start casting**.

Projector remote:

| Key | Action |
|---|---|
| OK | Show or hide status |
| ◀ ▶ | Display mode: 1 Native (default), 2 Web, 3 Web (GPU layer), 4 Web (canvas) |
| ▲ ▼ | Native decoder: hardware, hardware (buffered), software |
| Back ×2 | Exit |

## Troubleshooting

| Symptom | Action |
|---|---|
| Projector not found | Put both devices on the same network (guest networks often block this), or enter the projector's IP address under **Advanced**. |
| Picture stalls | The projector switches decoder automatically. If it keeps stalling, choose display mode 4. |
| Picture is choppy | Use **540p, 30 fps**. The PC lowers its frame rate to what the projector decodes; the status line shows *capped at N fps*. |
| Black or flashing frames | Set **Advanced → Screen capture → Compatibility** (affects whole-screen capture only). |
| No sound | Audio capture requires Windows. Check **Send sound** and the projector volume. |

**Advanced → Copy report** copies a log of PC and projector statistics from the last cast.

## Architecture

```
PC (Electron)                                   Projector (Android)
  UDP broadcast  "PCAST?<code>"  ────────────►  CastServer :47801
  HTTP POST /offer  ─────────────────────────►  CastServer :47800  →  NativePlayer or WebView
  WebRTC: H.264 / VP8 video, Opus stereo  ════►  SurfaceView / <video>
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
