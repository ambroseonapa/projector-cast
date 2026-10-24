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

function showError(text) { $('error').className = 'error'; $('error').textContent = text || ''; }
function showNote(text) { $('error').className = 'error note-ok'; $('error').textContent = text; }

function setLive(on) {
  $('setup').hidden = on;
  $('live').hidden = !on;
}

let sources = [];

function selectedSource() { return sources.find((s) => s.id === selectedScreen) || null; }

/**
 * A foldable "what to cast" panel: folded, it shows the current pick; open, every screen and window as a
 * small card with its name. onPick runs after a card is chosen (the panel folds itself again).
 */
function renderPicker(box, onPick) {
  box.textContent = '';
  const cur = selectedSource();
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const img = document.createElement('img');
  img.alt = '';
  if (cur) img.src = cur.thumb;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = cur ? cur.name : 'Nothing to cast was found';
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = cur ? (cur.kind === 'window' ? 'One window' : 'Whole screen') + ' · click to change' : '';
  name.append(kind);
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▼';
  summary.append(img, name, chev);
  details.append(summary);

  const body = document.createElement('div');
  body.className = 'body';
  let first = true;
  for (const [k, title] of [['screen', 'Whole screen'], ['window', 'One window']]) {
    const items = sources.filter((s) => s.kind === k);
    if (!items.length) continue;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const head = document.createElement('div');
    head.className = 'group';
    head.textContent = title;
    bar.append(head);
    if (first) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'refresh';
      refresh.textContent = '↻ Refresh';
      refresh.addEventListener('click', async (e) => {
        e.preventDefault();
        await loadScreens();
        const again = box.querySelector('details');
        if (again) again.open = true;
      });
      bar.append(refresh);
      first = false;
    }
    const grid = document.createElement('div');
    grid.className = 'pick-grid';
    items.forEach((s) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'pick-card' + (s.id === selectedScreen ? ' selected' : '');
      c.title = s.name;
      c.dataset.id = s.id;
      const t = document.createElement('img');
      t.src = s.thumb;
      t.alt = '';
      const n = document.createElement('span');
      n.textContent = s.name;
      c.append(t, n);
      c.addEventListener('click', () => {
        selectedScreen = s.id;
        store('sourceName', s.name);
        renderAllPickers();
        if (onPick) onPick(s);
      });
      grid.append(c);
    });
    body.append(bar, grid);
  }
  details.append(body);
  box.append(details);
}

function renderAllPickers() {
  renderPicker($('picker'));
  renderPicker($('livePicker'), (s) => { if (session) switchSource(s); });
}

async function loadScreens() {
  sources = await window.cast.listScreens().catch(() => []);
  if (sources.length && !sources.some((s) => s.id === selectedScreen)) {
    const remembered = store('sourceName');
    const byName = sources.find((s) => s.name === remembered);
    selectedScreen = (byName || sources[0]).id;
  }
  renderAllPickers();
}

async function switchSource(s) {
  showError('');
  try {
    await window.cast.prepareCapture({ screenId: s.id, screenName: s.name, audio: false, muteLocal: $('muteLocal').checked });
    await session.switchSource();
    $('castingWhat').textContent = (s.kind === 'window' ? 'Window: ' : '') + s.name;
  } catch (e) {
    showError(cleanError(e));
  }
}

/** Resolves true to update the projector first, false to cast as is. */
function askToUpdate(have, bundled) {
  $('updateText').textContent = `The projector app is out of date (version ${have || 1} → ${bundled}).`;
  $('setup').hidden = true;
  $('update').hidden = false;
  return new Promise((resolve) => {
    const done = (v) => {
      $('update').hidden = true;
      $('setup').hidden = false;
      $('updateNow').onclick = $('updateSkip').onclick = null;
      resolve(v);
    };
    $('updateNow').onclick = () => done(true);
    $('updateSkip').onclick = () => done(false);
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
  $('quality').value = (QUALITY[store('quality')] && store('quality')) || 'p720_60';
  $('content').value = store('content') || 'motion';
  $('codec').value = store('codec') || 'h264';
  $('buffer').value = store('buffer') || '150';
  const settings = await window.cast.getSettings();
  $('capture').value = settings.captureMethod;
  $('capture').addEventListener('change', () => {
    if (session) return;
    showError('Restarting with the new capture method...');
    window.cast.setCaptureMethod($('capture').value);
  });
  $('audio').checked = store('audio') !== '0';
  $('muteLocal').checked = store('muteLocal') !== '0';
  for (const [key, q] of Object.entries(QUALITY)) $('liveQuality').append(new Option(q.label, key));
  $('applyLive').addEventListener('click', applyLive);

  const platform = await window.cast.platform();
  if (platform !== 'win32') {
    $('audioNote').hidden = false;
    $('audio').checked = false;
    $('audio').disabled = true;
    $('muteLocal').checked = false;
    $('muteLocal').disabled = true;
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

  ['code', 'ip', 'quality', 'content', 'codec', 'buffer'].forEach((k) => store(k, $(k).value.trim()));
  store('audio', $('audio').checked ? '1' : '0');
  store('muteLocal', $('muteLocal').checked ? '1' : '0');
  await loadScreens();
  const source = selectedSource();
  if (!source) return showError('Pick a screen or window to cast.');

  $('start').disabled = true;
  $('start').textContent = 'Looking for the projector...';
  try {
    let target = null;
    if (manualIp) {
      const info = await window.cast.ping(manualIp).catch(() => null);
      if (!info) throw new Error(`No Projector Cast app answered at ${manualIp}. Is the app open on the projector?`);
      target = { ip: manualIp, name: info.name, version: info.version };
    } else {
      target = await window.cast.findProjector(code);
      if (!target) {
        throw new Error('Projector not found. Check the code, make sure the app is open on the projector and '
          + 'both are on the same Wi-Fi. If it still fails, type the projector address under Advanced.');
      }
      const info = await window.cast.ping(target.ip).catch(() => null);
      target.version = info ? info.version : 0;
    }

    const bundled = await window.cast.bundledApkVersion();
    if (bundled > (target.version || 1) && await askToUpdate(target.version, bundled)) {
      $('start').textContent = 'Sending the update...';
      try {
        await window.cast.pushUpdate(target.ip, code);
      } catch (e) {
        // Projector apps before version 3 have no update receiver: they need one last manual install.
        if (/not found/i.test(cleanError(e))) {
          throw new Error('This projector app is too old to update itself. Install the new ProjectorCast.apk one last time '
            + 'with a USB stick; after that, updates come from this PC app.');
        }
        throw e;
      }
      showNote('Update sent. On the projector, select Install, then open Projector Cast and press Start casting again.');
      return;
    }

    await window.cast.prepareCapture({
      screenId: source.id, screenName: source.name, audio: $('audio').checked, muteLocal: $('muteLocal').checked,
    });
    const opts = {
      ip: target.ip,
      name: target.name,
      code,
      quality: $('quality').value,
      content: $('content').value,
      codec: $('codec').value,
      audio: $('audio').checked,
      buffer: parseInt($('buffer').value, 10),
    };
    setLive(true);
    $('state').textContent = 'Connecting...';
    $('stats').textContent = '';
    $('dot').className = 'dot';
    $('castingWhat').textContent = (source.kind === 'window' ? 'Window: ' : '') + source.name;
    $('liveQuality').value = opts.quality;
    $('liveContent').value = opts.content;
    $('liveBuffer').value = String(opts.buffer);
    $('liveSettings').open = false;
    renderAllPickers();

    session = new CastSession(window.cast, opts, {
      onState: (text, kind) => {
        $('state').textContent = text;
        $('dot').className = 'dot' + (kind === 'live' ? ' live' : '');
      },
      onStats: (text) => { $('stats').textContent = text; },
      onStream: (stream) => { $('preview').srcObject = new MediaStream(stream.getVideoTracks()); },
      onEnded: (reason) => {
        session = null;
        $('preview').srcObject = null;
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

async function applyLive() {
  if (!session) return;
  const changes = { quality: $('liveQuality').value, content: $('liveContent').value, buffer: parseInt($('liveBuffer').value, 10) };
  store('quality', changes.quality);
  store('content', changes.content);
  store('buffer', String(changes.buffer));
  $('applyLive').disabled = true;
  try {
    await session.update(changes);
  } catch (e) {
    showError(cleanError(e));
  } finally {
    $('applyLive').disabled = false;
  }
}

function cleanError(e) {
  const msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/NotAllowedError|AbortError|NotReadableError|Permission denied|Could not start/i.test(msg)) {
    const s = selectedSource();
    if (s && s.kind === 'window') return `Could not capture the window "${s.name}". Make sure it is open and not minimised, press ↻ and pick it again.`;
    return 'Screen capture was blocked. Allow screen recording for Projector Cast and try again.';
  }
  return msg;
}

init();
