'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, session, powerSaveBlocker, shell } = require('electron');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const path = require('path');

const HTTP_PORT = 47800;
const DISCOVERY_PORT = 47801;

let win = null;
let chosenScreenId = null;
let wantAudio = true;
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

// Use real LAN addresses in WebRTC instead of random .local names; both sides are on the same network.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  // getDisplayMedia() in the page lands here: hand back the chosen screen, plus system sound on Windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources.find((s) => s.id === chosenScreenId) || sources[0];
      if (!source) return callback({});
      const streams = { video: source };
      if (wantAudio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (e) {
      callback({});
    }
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('list-screens', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 240, height: 135 } });
  return sources.map((s, i) => ({ id: s.id, name: s.name || `Screen ${i + 1}`, thumb: s.thumbnail.toDataURL() }));
});

ipcMain.handle('prepare-capture', (_e, opts) => {
  chosenScreenId = opts.screenId || null;
  wantAudio = !!opts.audio;
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

function request(ip, method, urlPath, code, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = http.request({
      host: ip,
      port: HTTP_PORT,
      method,
      path: urlPath,
      headers: {
        'Content-Type': 'application/json',
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
ipcMain.handle('send-offer', (_e, { ip, code, offer }) => request(ip, 'POST', '/offer', code, JSON.stringify(offer), 25000));
ipcMain.handle('send-stop', (_e, { ip, code }) => request(ip, 'POST', '/stop', code, '{}', 3000).catch(() => null));
