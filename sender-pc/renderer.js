'use strict';

const $ = (id) => document.getElementById(id);
const { QUALITY, CastSession } = window.CastCore;

let sources = [];
let selectedId = null;
let session = null;
let filter = '';
let remoteKeyTimer = null;

const REMOTE_KEY_NAMES = {
  playpause: 'Play / pause', next: 'Next', previous: 'Previous', back: 'Back', forward: 'Forward',
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { /* storage unavailable */ }
  return null;
}

function showError(text) { $('error').className = 'error'; $('error').textContent = text || ''; }
function showNote(text) { $('error').className = 'error ok'; $('error').textContent = text; }

function setLive(on) {
  $('setup').hidden = on;
  $('live').hidden = !on;
}

// ---- Report: PC and projector stats every 2 s ----

let reportTimer = null;
let timeline = [];
let lastProjector = null;

function clock() { return new Date().toTimeString().slice(0, 8); }

function startReport(target) {
  stopReport();
  timeline = [];
  lastProjector = null;
  $('projStats').textContent = 'Waiting for the projector…';
  reportTimer = setInterval(async () => {
    if (!session) return;
    const p = await window.cast.projectorStats(target.ip, target.code).catch((e) => ({ error: cleanError(e) }));
    lastProjector = p;
    // Native player: "decoded N"; web player: "Picture WxH  N fps".
    const decoded = /decoded (\d+)/.exec(p.stats || '') || /Picture\s+\S+\s+(\d+) fps/.exec(p.stats || '');
    if (decoded && session) session.adaptToProjector(parseInt(decoded[1], 10)).catch(() => {});
    const text = p.error ? 'No answer: ' + p.error : (p.stats || 'No data yet');
    $('projStats').textContent = p.error ? text : `${p.mode || ''} · decoding: ${p.decoding || '?'}\n${text}`;
    checkStill();
    timeline.push({ t: clock(), pc: $('stats').textContent.replace(/\n/g, ' · '), proj: text.replace(/\n+/g, ' | ') });
    if (timeline.length > 90) timeline.shift();
  }, 2000);
}

function stopReport() {
  clearInterval(reportTimer);
  reportTimer = null;
  stillSince = 0;
  $('liveHint').hidden = true;
}

// Browsers stop drawing video in windows that are covered or in the background, so a cast window
// can show a frozen or black video area while its sound continues.
let stillSince = 0;

function checkStill() {
  const s = selectedSource();
  const fps = session && session.lastSentFps;
  if (!s || s.kind !== 'window' || fps == null || fps >= 3) {
    stillSince = 0;
    $('liveHint').hidden = true;
    return;
  }
  stillSince = stillSince || Date.now();
  if (Date.now() - stillSince < 6000) return;
  $('liveHint').textContent = `The picture from ${s.app === 'Other' ? 'this window' : s.app} is not changing. `
    + 'If a video is playing, keep the window visible: browsers pause video drawing in covered or background windows. '
    + 'Alternatively, turn off "Use graphics acceleration when available" in the browser settings (System section), '
    + 'or cast the entire screen.';
  $('liveHint').hidden = false;
}

async function copyReport() {
  const info = await window.cast.appInfo().catch(() => ({}));
  const s = selectedSource();
  const p = lastProjector || {};
  const lines = [
    `Projector Cast report  ${new Date().toISOString()}`,
    `PC app ${info.version || '?'}  ·  ${info.os || '?'}`,
    `Settings: quality ${$('quality').value} · content ${$('content').value} · codec ${$('codec').value} · buffer ${$('buffer').value} ms`
      + ` · capture ${$('capture').value} · source ${s ? s.kind + ' "' + s.name + '"' : '?'} · sound ${$('audio').checked ? 'on' : 'off'}`,
    `Projector: app ${p.app || '?'} · ${p.device || '?'} · Android ${p.android || '?'} · ${p.webview || '?'}`,
    `Projector mode: ${p.mode || '?'} · decoding: ${p.decoding || '?'} · ${p.casting || '?'}`,
    '',
    '--- Every 2 s (newest last) ---',
    ...timeline.map((x) => `${x.t}  PC: ${x.pc}\n          Projector: ${x.proj}`),
    '',
    '--- Projector events ---',
    ...((p.events || []).length ? p.events : ['(none)']),
  ];
  await window.cast.copyText(lines.join('\n'));
  showNote('Report copied.');
}

// ---- Source picker ----

function selectedSource() { return sources.find((s) => s.id === selectedId) || null; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function icon(src) {
  const i = el('img', 'app-icon');
  i.alt = '';
  if (src) i.src = src;
  else i.hidden = true;
  return i;
}

/** Screens first, then windows grouped by application. */
function groups() {
  const q = filter.trim().toLowerCase();
  const match = (s) => !q || s.name.toLowerCase().includes(q) || (s.app || '').toLowerCase().includes(q);
  const out = [];
  const screens = sources.filter((s) => s.kind === 'screen' && match(s));
  if (screens.length) out.push({ title: 'Screens', items: screens });
  const byApp = new Map();
  for (const s of sources.filter((x) => x.kind === 'window' && match(x))) {
    if (!byApp.has(s.app)) byApp.set(s.app, []);
    byApp.get(s.app).push(s);
  }
  [...byApp.keys()].sort((a, b) => a.localeCompare(b)).forEach((app) => {
    const items = byApp.get(app);
    out.push({ title: `${app} (${items.length})`, icon: items[0].icon, items });
  });
  return out;
}

function renderPicker(box, onPick) {
  const wasOpen = !!(box.querySelector('details') || {}).open;
  box.textContent = '';
  const cur = selectedSource();
  const details = el('details');
  details.open = wasOpen;
  const summary = el('summary');
  const thumb = el('img');
  thumb.alt = '';
  if (cur) thumb.src = cur.thumb;
  const name = el('span', 'name');
  name.append(el('b', null, cur ? cur.title : 'No source found'));
  if (cur) {
    const sub = el('small');
    sub.append(icon(cur.icon), document.createTextNode(cur.kind === 'screen' ? 'Screen' : cur.app === 'Other' ? 'Window' : cur.app));
    name.append(sub);
  }
  summary.append(thumb, name, el('span', 'chev', '▼'));
  details.append(summary);

  const body = el('div', 'body');
  const tools = el('div', 'tools');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search windows';
  search.value = filter;
  search.addEventListener('input', () => {
    filter = search.value;
    renderAllPickers();
    const again = box.querySelector('.tools input');
    if (again) { again.focus(); again.setSelectionRange(filter.length, filter.length); }
  });
  const refresh = el('button', 'refresh', 'Refresh');
  refresh.type = 'button';
  refresh.addEventListener('click', (e) => { e.preventDefault(); loadScreens(); });
  tools.append(search, refresh);
  body.append(tools);

  const list = groups();
  if (!list.length) body.append(el('div', 'empty', 'No matching windows.'));
  for (const g of list) {
    const head = el('div', 'group');
    head.append(icon(g.icon), document.createTextNode(g.title));
    const grid = el('div', 'pick-grid');
    for (const s of g.items) {
      const card = el('button', 'pick-card' + (s.id === selectedId ? ' selected' : ''));
      card.type = 'button';
      card.title = s.name;
      card.dataset.id = s.id;
      const t = el('img');
      t.src = s.thumb;
      t.alt = '';
      card.append(t, el('span', 'title', s.title));
      if (s.detail) card.append(el('span', 'detail', s.detail));
      card.addEventListener('click', () => {
        selectedId = s.id;
        store('sourceName', s.name);
        renderAllPickers();
        box.querySelector('details').open = false;
        if (onPick) onPick(s);
      });
      grid.append(card);
    }
    body.append(head, grid);
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
  if (sources.length && !selectedSource()) {
    const remembered = store('sourceName');
    selectedId = (sources.find((s) => s.name === remembered) || sources[0]).id;
  }
  renderAllPickers();
}

function describe(s) { return s.kind === 'window' && s.app !== 'Other' ? `${s.app}: ${s.title}` : s.title; }

async function switchSource(s) {
  showError('');
  try {
    await window.cast.prepareCapture({ screenId: s.id, screenName: s.name, audio: false, muteLocal: $('muteLocal').checked });
    await session.switchSource();
    $('castingWhat').textContent = describe(s);
  } catch (e) {
    showError(cleanError(e));
  }
}

// ---- Updates ----

/** Resolves true to update the projector first, false to cast as is. */
function askToUpdate(have, bundled) {
  $('updateText').textContent = `A projector update is available (version ${have || 1} → ${bundled}).`;
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

function onUpdateStatus(st) {
  const line = $('pcUpdate');
  if (st.state === 'downloading') {
    $('pcUpdateText').textContent = `Downloading update ${st.version}${st.percent != null ? ` (${Math.round(st.percent)}%)` : ''}…`;
    $('pcUpdateNow').hidden = true;
    line.hidden = false;
  } else if (st.state === 'ready') {
    $('pcUpdateText').textContent = `Update ${st.version} is ready.`;
    $('pcUpdateNow').hidden = false;
    line.hidden = false;
  } else if (st.state === 'available') {
    $('pcUpdateText').textContent = `Version ${st.version} is available.`;
    $('pcDownload').hidden = false;
    line.hidden = false;
  } else if (st.state === 'installing') {
    $('pcUpdateText').textContent = 'Installing update…';
    $('pcUpdateNow').hidden = true;
  }
}

function installUpdate() {
  if (session) session.stop('Stopped');
  onUpdateStatus({ state: 'installing' });
  window.cast.installUpdate();
}

// ---- Second screen (Windows virtual display) ----

async function refreshVdd() {
  const st = await window.cast.vddStatus().catch(() => ({ supported: false }));
  $('vdd').hidden = !st.supported;
  if (!st.supported) return;
  $('vddStatus').textContent = !st.installed
    ? 'Adds a virtual monitor that extends the desktop to the projector. Requires administrator rights.'
    : st.on ? 'Virtual monitor is on. Select it under Source.' : 'Virtual monitor is off.';
  $('vddInstall').hidden = st.installed;
  $('vddOn').hidden = !st.installed || st.on;
  $('vddOff').hidden = !st.installed || !st.on;
  $('vddSettings').hidden = !st.installed || !st.on;
}

async function vddAction(button, work, busyText) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  showError('');
  try {
    const r = await work();
    if (r && r.manual) showNote('Download the installer from the page that opened.');
    else if (r && r.ok === false) showError('Installation did not complete.');
  } catch (e) {
    showError('The change was cancelled or not permitted.');
  } finally {
    button.disabled = false;
    button.textContent = label;
    await refreshVdd();
    await loadScreens();
  }
}

// ---- Casting ----

async function init() {
  for (const [key, q] of Object.entries(QUALITY)) {
    $('quality').append(new Option(q.label, key));
    $('liveQuality').append(new Option(q.label, key));
  }
  $('code').value = store('code') || '';
  $('ip').value = store('ip') || '';
  $('quality').value = (QUALITY[store('quality')] && store('quality')) || 'p720_60';
  $('content').value = store('content') || 'motion';
  $('codec').value = store('codec') || 'h264';
  $('buffer').value = store('buffer') || '150';
  $('audio').checked = store('audio') !== '0';
  $('muteLocal').checked = store('muteLocal') !== '0';

  const settings = await window.cast.getSettings();
  $('capture').value = settings.captureMethod;
  $('capture').addEventListener('change', () => {
    if (session) return;
    showNote('Restarting…');
    window.cast.setCaptureMethod($('capture').value);
  });

  const platform = await window.cast.platform();
  if (platform === 'darwin') $('macNote').hidden = false;
  if (platform !== 'win32') {
    $('audioNote').hidden = false;
    for (const id of ['audio', 'muteLocal']) {
      $(id).checked = false;
      $(id).disabled = true;
    }
  }

  $('applyLive').addEventListener('click', applyLive);
  $('copyReport').addEventListener('click', copyReport);
  $('copyLast').addEventListener('click', copyReport);
  $('pcUpdateNow').addEventListener('click', installUpdate);
  $('pcDownload').addEventListener('click', () => window.cast.openReleases());
  $('vddInstall').addEventListener('click', () => vddAction($('vddInstall'), () => window.cast.vddInstall(), 'Installing…'));
  $('vddOn').addEventListener('click', () => vddAction($('vddOn'), () => window.cast.vddSet(true), 'Turning on…'));
  $('vddOff').addEventListener('click', () => vddAction($('vddOff'), () => window.cast.vddSet(false), 'Turning off…'));
  $('vddSettings').addEventListener('click', () => window.cast.openDisplaySettings());
  refreshVdd();
  window.cast.onUpdateStatus(onUpdateStatus);

  $('code').addEventListener('input', () => { $('code').value = $('code').value.replace(/\D/g, '').slice(0, 6); });
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => session && session.stop('Stopped'));
  window.addEventListener('focus', () => { if (!session) loadScreens(); });
  await loadScreens();
}

async function findTarget(code, manualIp) {
  if (manualIp) {
    const info = await window.cast.ping(manualIp).catch(() => null);
    if (!info) throw new Error(`No projector answered at ${manualIp}.`);
    return { ip: manualIp, name: info.name, version: info.version };
  }
  const target = await window.cast.findProjector(code);
  if (!target) throw new Error('Projector not found. Check the code and that both devices are on the same network.');
  const info = await window.cast.ping(target.ip).catch(() => null);
  target.version = info ? info.version : 0;
  return target;
}

async function start() {
  showError('');
  const code = $('code').value.trim();
  if (!/^\d{6}$/.test(code)) return showError('Enter the 6-digit code shown on the projector.');
  const manualIp = $('ip').value.trim();
  if (manualIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(manualIp)) return showError('Enter an IP address such as 192.168.1.25.');

  ['code', 'ip', 'quality', 'content', 'codec', 'buffer'].forEach((k) => store(k, $(k).value.trim()));
  store('audio', $('audio').checked ? '1' : '0');
  store('muteLocal', $('muteLocal').checked ? '1' : '0');
  await loadScreens();
  const source = selectedSource();
  if (!source) return showError('Select a source.');

  $('start').disabled = true;
  $('start').textContent = 'Connecting…';
  try {
    const target = await findTarget(code, manualIp);

    const bundled = await window.cast.bundledApkVersion();
    if (bundled > (target.version || 1) && await askToUpdate(target.version, bundled)) {
      $('start').textContent = 'Sending update…';
      try {
        await window.cast.pushUpdate(target.ip, code);
      } catch (e) {
        // Projector apps before version 3 cannot receive updates.
        if (/not found/i.test(cleanError(e))) throw new Error('This projector app is too old to update itself. Install ProjectorCast.apk manually once.');
        throw e;
      }
      showNote('Update sent. Confirm the installation on the projector.');
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
    $('state').textContent = 'Connecting…';
    $('stats').textContent = '';
    $('dot').className = 'dot';
    $('castingWhat').textContent = describe(source);
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
      onQuality: (key) => {
        $('liveQuality').value = key;
        $('quality').value = key;
        store('quality', key);
      },
      onRemoteKey: async (key) => {
        const done = await window.cast.remoteKey(key).catch(() => false);
        const name = REMOTE_KEY_NAMES[key] || key;
        $('remoteKey').textContent = done ? `Projector remote: ${name}` : `Projector remote: ${name} (not available here)`;
        clearTimeout(remoteKeyTimer);
        remoteKeyTimer = setTimeout(() => { $('remoteKey').textContent = ''; }, 3000);
      },
      onEnded: (reason) => {
        session = null;
        stopReport();
        $('copyLast').hidden = timeline.length === 0;
        $('preview').srcObject = null;
        window.cast.keepAwake(false);
        setLive(false);
        if (reason && reason !== 'Stopped') showError(reason);
        loadScreens();
      },
    });
    window.cast.keepAwake(true);
    startReport({ ip: target.ip, code });
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
    if (s && s.kind === 'window') return `Cannot capture "${s.title}". Make sure the window is open and not minimised.`;
    return 'Screen capture is not allowed. Check the Windows privacy settings.';
  }
  return msg;
}

init();
