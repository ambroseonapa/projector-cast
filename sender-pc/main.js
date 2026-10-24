'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, powerSaveBlocker, shell, clipboard } = require('electron');
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Updates from GitHub Releases (installed app only).
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { /* running from source */ }

function sendUpdateStatus(status) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
}

const RELEASES_URL = 'https://github.com/ambroseonapa/projector-cast/releases/latest';

function setupUpdates() {
  if (!app.isPackaged || !autoUpdater) return;
  // macOS only installs signed updates; this build is unsigned, so point to the download instead.
  const manual = process.platform === 'darwin';
  let version = '';
  autoUpdater.autoDownload = !manual;
  autoUpdater.autoInstallOnAppQuit = !manual;
  autoUpdater.on('update-available', (info) => {
    version = info.version;
    sendUpdateStatus({ state: manual ? 'available' : 'downloading', version });
  });
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', version, percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', () => { /* offline or no release: retried later */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000);
}

ipcMain.handle('open-releases', () => shell.openExternal(RELEASES_URL));

ipcMain.handle('install-update', () => {
  if (!autoUpdater) return;
  // Close the window first: with it open the installer can't replace the app or start it again.
  setImmediate(() => {
    app.removeAllListeners('window-all-closed');
    BrowserWindow.getAllWindows().forEach((w) => w.destroy());
    autoUpdater.quitAndInstall(true, true);
  });
});

const HTTP_PORT = 47800;
const DISCOVERY_PORT = 47801;

let win = null;
let chosenScreenId = null;
let chosenName = null;
let wantAudio = true;
let muteLocal = true;
let sleepBlocker = null;

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 460,
    minHeight: 600,
    title: 'Projector Cast',
    backgroundColor: '#0b1520',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep encoding at full speed while minimised
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Settings applied at start-up; changing them restarts the app.
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { return {}; }
}
const settings = readSettings();

// Use real LAN addresses in WebRTC instead of .local names.
const disabledFeatures = ['WebRtcHideLocalIpsWithMdns'];
// Compatibility capture: desktop duplication instead of Windows Graphics Capture for whole screens
// (avoids black frames from hardware video overlays). Windows always use Graphics Capture, since the
// older window capturer cannot see GPU-rendered browser video.
if (settings.captureMethod === 'compat') disabledFeatures.push('AllowWgcScreenCapturer', 'AllowWgcDesktopCapturer');
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  // getDisplayMedia() requests: return the chosen source, plus system sound on Windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      // A missing window must not fall back to the whole screen.
      const source = sources.find((s) => s.id === chosenScreenId)
        || (chosenName && sources.find((s) => s.name === chosenName && s.id.split(':')[0] === String(chosenScreenId).split(':')[0]))
        || (!chosenScreenId && sources.find((s) => s.id.startsWith('screen:')));
      if (!source) return callback({});
      const streams = { video: source };
      // loopbackWithMute plays the sound on the projector only.
      if (wantAudio && request.audioRequested && process.platform === 'win32') streams.audio = muteLocal ? 'loopbackWithMute' : 'loopback';
      callback(streams);
    } catch (e) {
      callback({});
    }
  });
  createWindow();
  setupUpdates();
});

app.on('window-all-closed', () => app.quit());

/**
 * Splits a window title into application, page title and extra detail, e.g.
 * "Song - YouTube and 10 more pages - Work - Microsoft Edge" -> Microsoft Edge / "Song - YouTube" / "+10 tabs · Work".
 */
function describeWindow(name) {
  const parts = name.split(/ [-\u2013\u2014] /);
  const appName = parts.length > 1 ? parts.pop() : '';
  let title = parts.join(' - ') || name;
  const details = [];
  const tabs = /^(.*) and (\d+) more (?:pages|tabs)(?: - (.+))?$/.exec(title);
  if (tabs) {
    title = tabs[1];
    details.push(`+${tabs[2]} tabs`);
    if (tabs[3]) details.push(tabs[3]);
  }
  return { app: appName || 'Other', title: appName ? title : name, detail: details.join(' · ') };
}

ipcMain.handle('list-screens', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true,
  });
  const ownTitle = win ? win.getTitle() : 'Projector Cast';
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  return sources
    .filter((s) => !(s.id.startsWith('window:') && (s.name === ownTitle || !s.name)))
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const info = isScreen
        ? { app: '', title: screens.length > 1 ? `Screen ${screens.indexOf(s) + 1}` : 'Entire screen', detail: '' }
        : describeWindow(s.name);
      return {
        id: s.id,
        kind: isScreen ? 'screen' : 'window',
        name: s.name,
        thumb: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 32 }).toDataURL() : null,
        ...info,
      };
    });
});

ipcMain.handle('get-settings', () => ({ captureMethod: settings.captureMethod || 'auto' }));

ipcMain.handle('set-capture-method', (_e, method) => {
  const next = { ...readSettings(), captureMethod: method === 'compat' ? 'compat' : 'auto' };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(next));
  app.relaunch();
  app.exit(0);
});

// The projector APK ships with this app and is pushed to older projector apps on connect.
function bundledApk() {
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'dist');
  const file = path.join(dir, 'ProjectorCast.apk');
  try {
    const version = parseInt(fs.readFileSync(path.join(dir, 'ProjectorCast.version'), 'utf8'), 10);
    if (fs.existsSync(file) && version > 0) return { file, version };
  } catch (_) { /* no bundled APK */ }
  return null;
}

ipcMain.handle('bundled-apk-version', () => { const b = bundledApk(); return b ? b.version : 0; });

ipcMain.handle('push-update', async (_e, { ip, code }) => {
  const b = bundledApk();
  if (!b) throw new Error('This PC app has no projector update inside it');
  return request(ip, 'POST', '/update', code, fs.readFileSync(b.file), 120000, 'application/vnd.android.package-archive');
});

ipcMain.handle('prepare-capture', (_e, opts) => {
  chosenScreenId = opts.screenId || null;
  chosenName = opts.screenName || null;
  wantAudio = !!opts.audio;
  muteLocal = opts.muteLocal !== false;
  return { audioSupported: process.platform === 'win32' };
});

ipcMain.handle('platform', () => process.platform);

ipcMain.handle('keep-awake', (_e, on) => {
  if (on && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
});

/** Broadcast addresses of every IPv4 network this PC is on, plus the global one. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

ipcMain.handle('find-projector', (_e, code) => new Promise((resolve) => {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = Buffer.from('PCAST?' + code);
  const targets = broadcastAddresses();
  let done = false;
  let timer = null;
  let resend = null;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(resend);
    try { sock.close(); } catch (_) { /* already closed */ }
    resolve(result);
  };
  sock.on('message', (data, rinfo) => {
    const text = data.toString('utf8');
    if (text.startsWith('PCAST!')) finish({ ip: rinfo.address, name: text.slice(6) || 'Projector' });
  });
  sock.on('error', () => finish(null));
  sock.bind(0, () => {
    sock.setBroadcast(true);
    const send = () => targets.forEach((t) => sock.send(msg, DISCOVERY_PORT, t, () => {}));
    send();
    resend = setInterval(send, 500);
    timer = setTimeout(() => finish(null), 4000);
  });
}));

function request(ip, method, urlPath, code, body, timeoutMs, contentType) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = http.request({
      host: ip,
      port: HTTP_PORT,
      method,
      path: urlPath,
      headers: {
        'Content-Type': contentType || 'application/json',
        'X-Cast-Code': code || '',
        'X-Cast-Sender': os.hostname().replace(/[^\w .-]/g, '').slice(0, 40) || 'PC',
        ...(data ? { 'Content-Length': data.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* handled below */ }
        if (res.statusCode === 403) return reject(new Error('Wrong code. Check the code on the projector.'));
        if (res.statusCode !== 200 || !json) return reject(new Error((json && json.error) || `Projector replied ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Projector did not respond in time')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED'
      ? 'Projector found but the app is not open on it'
      : e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT' ? 'Cannot reach the projector on this network' : e.message)));
    if (data) req.write(data);
    req.end();
  });
}

ipcMain.handle('ping', (_e, ip) => request(ip, 'GET', '/ping', '', null, 3000));
ipcMain.handle('projector-stats', (_e, { ip, code }) => request(ip, 'GET', '/stats', code, null, 5000));
ipcMain.handle('copy-text', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('app-info', () => ({ version: app.getVersion(), os: `${os.type()} ${os.release()} ${os.arch()}` }));
ipcMain.handle('send-offer', (_e, { ip, code, offer }) => request(ip, 'POST', '/offer', code, JSON.stringify(offer), 25000));
ipcMain.handle('send-stop', (_e, { ip, code }) => request(ip, 'POST', '/stop', code, '{}', 3000).catch(() => null));
