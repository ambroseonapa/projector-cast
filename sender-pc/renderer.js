'use strict';

const $ = (id) => document.getElementById(id);
const { QUALITY, CastSession } = window.CastCore;

let selectedScreen = null;
let session = null;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { /* storage unavailable */ }
  return null;
}

function showError(text) { $('error').textContent = text || ''; }

function setLive(on) {
  $('setup').hidden = on;
  $('live').hidden = !on;
}

async function loadScreens() {
  const list = await window.cast.listScreens().catch(() => []);
  const box = $('screens');
  box.textContent = '';
  if (!list.length) {
    box.textContent = 'No screens found.';
    return;
  }
  if (!list.some((s) => s.id === selectedScreen)) selectedScreen = list[0].id;
  list.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'screen' + (s.id === selectedScreen ? ' selected' : '');
    const img = document.createElement('img');
    img.src = s.thumb;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = s.name;
    b.append(img, label);
    b.addEventListener('click', () => {
      selectedScreen = s.id;
      box.querySelectorAll('.screen').forEach((el) => el.classList.remove('selected'));
      b.classList.add('selected');
    });
    box.append(b);
  });
}

async function init() {
  for (const [key, q] of Object.entries(QUALITY)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = q.label;
    $('quality').append(o);
  }
  $('code').value = store('code') || '';
  $('ip').value = store('ip') || '';
  $('quality').value = (QUALITY[store('quality')] && store('quality')) || 'p720_30';
  $('content').value = store('content') || 'motion';
  $('codec').value = store('codec') || 'h264';
  $('audio').checked = store('audio') !== '0';

  const platform = await window.cast.platform();
  if (platform !== 'win32') {
    $('audioNote').hidden = false;
    $('audio').checked = false;
    $('audio').disabled = true;
  }

  $('code').addEventListener('input', () => { $('code').value = $('code').value.replace(/\D/g, '').slice(0, 6); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => session && session.stop('Stopped'));
  window.addEventListener('focus', () => { if (!session) loadScreens(); });
  await loadScreens();
}

async function start() {
  showError('');
  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) return showError('Type the 6-digit code shown on the projector.');
  const manualIp = $('ip').value.trim();
  if (manualIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(manualIp)) return showError('The projector address should look like 192.168.1.25');

  ['code', 'ip', 'quality', 'content', 'codec'].forEach((k) => store(k, $(k).value.trim()));
  store('audio', $('audio').checked ? '1' : '0');

  $('start').disabled = true;
  $('start').textContent = 'Looking for the projector...';
  try {
    let target = null;
    if (manualIp) {
      const info = await window.cast.ping(manualIp).catch(() => null);
      if (!info) throw new Error(`No Projector Cast app answered at ${manualIp}. Is the app open on the projector?`);
      target = { ip: manualIp, name: info.name };
    } else {
      target = await window.cast.findProjector(code);
      if (!target) {
        throw new Error('Projector not found. Check the code, make sure the app is open on the projector and '
          + 'both are on the same Wi-Fi. If it still fails, type the projector address under Advanced.');
      }
    }

    await window.cast.prepareCapture({ screenId: selectedScreen, audio: $('audio').checked });
    const opts = {
      ip: target.ip,
      name: target.name,
      code,
      quality: $('quality').value,
      content: $('content').value,
      codec: $('codec').value,
      audio: $('audio').checked,
    };
    setLive(true);
    $('state').textContent = 'Connecting...';
    $('stats').textContent = '';
    $('dot').className = 'dot';

    session = new CastSession(window.cast, opts, {
      onState: (text, kind) => {
        $('state').textContent = text;
        $('dot').className = 'dot' + (kind === 'live' ? ' live' : '');
      },
      onStats: (text) => { $('stats').textContent = text; },
      onEnded: (reason) => {
        session = null;
        window.cast.keepAwake(false);
        setLive(false);
        if (reason && reason !== 'Stopped') showError(reason);
        loadScreens();
      },
    });
    window.cast.keepAwake(true);
    await session.start();
  } catch (e) {
    if (session) {
      const s = session;
      session = null;
      s.events.onEnded = () => {};
      s.stop();
    }
    window.cast.keepAwake(false);
    setLive(false);
    showError(cleanError(e));
  } finally {
    $('start').disabled = false;
    $('start').textContent = 'Start casting';
  }
}

function cleanError(e) {
  const msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/NotAllowedError|Permission denied/i.test(msg)) return 'Screen capture was blocked. Allow screen recording for Projector Cast and try again.';
  return msg;
}

init();
