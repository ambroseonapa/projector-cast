'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, powerSaveBlocker, shell, clipboard } = require('electron');
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Self-update from the public GitHub Releases (only in the installed app).
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (_) { /* running from source */ }

function setupUpdates() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => { if (win) win.webContents.send('update-ready', info.version); });
  autoUpdater.on('error', () => { /* offline or no release yet: try again later */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

ipcMain.handle('install-update', () => { if (autoUpdater) autoUpdater.quitAndInstall(true, true); });

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
      // Keep encoding at full speed when the window is minimised or behind other windows.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Settings that must be applied before the app starts (changing them restarts the app).
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) { return {}; }
}
const settings = readSettings();

// Use real LAN addresses in WebRTC instead of random .local names; both sides are on the same network.
const disabledFeatures = ['WebRtcHideLocalIpsWithMdns'];
// "Compatibility" capture: the whole screen uses the older desktop-duplication path instead of Windows
// Graphics Capture (fixes black/flashing frames from hardware video overlays). Windows always keep
// Graphics Capture: the old window path can't see video a browser draws with the graphics card.
if (settings.captureMethod === 'compat') disabledFeatures.push('AllowWgcScreenCapturer', 'AllowWgcDesktopCapturer');
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  // getDisplayMedia() in the page lands here: hand back the chosen screen, plus system sound on Windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      // Never fall back to the whole screen when a window was picked: that would show everything on the PC.
      const source = sources.find((s) => s.id === chosenScreenId)
        || (chosenName && sources.find((s) => s.name === chosenName && s.id.split(':')[0] === String(chosenScreenId).split(':')[0]))
        || (!chosenScreenId && sources.find((s) => s.id.startsWith('screen:')));
      if (!source) return callback({});
      const streams = { video: source };
      // loopbackWithMute: the sound plays on the projector only, not also on the PC's speakers.
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

ipcMain.handle('list-screens', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 135 } });
  const ownTitle = win ? win.getTitle() : 'Projector Cast';
  return sources
    .filter((s) => !(s.id.startsWith('window:') && (s.name === ownTitle || !s.name)))
    .map((s, i) => ({
      id: s.id,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      name: s.name || `Screen ${i + 1}`,
      thumb: s.thumbnail.toDataURL(),
    }));
});

ipcMain.handle('get-settings', () => ({ captureMethod: settings.captureMethod || 'auto' }));

ipcMain.handle('set-capture-method', (_e, method) => {
  const next = { ...readSettings(), captureMethod: method === 'compat' ? 'compat' : 'auto' };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(next));
  // The portable .exe unpacks itself to a temp folder; restart the .exe itself, not the unpacked copy.
  if (process.env.PORTABLE_EXECUTABLE_FILE) app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE, args: [] });
  else app.relaunch();
  app.exit(0);
});

// The projector app ships inside this PC app, so updating the PC app is enough: it pushes the
// newer projector app over the network when it connects.
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
