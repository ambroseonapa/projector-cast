// Drives the real Electron PC app (UI, discovery, HTTP, capture of the virtual screen) against
// the real CastServer (tests/jvm/RelayServer) whose receiver page runs in Chromium.
const { chromium, _electron } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const http = require('http');
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const APK = path.resolve(__dirname, '../../dist/ProjectorCast.apk');

const APP = path.resolve(__dirname, '../../sender-pc');
const RECEIVER = 'file://' + path.resolve(__dirname, '../../receiver-android/assets/receiver.html');

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const receiver = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pending = {};
  let nextId = 1;
  await receiver.exposeFunction('__answer', (id, ans, err) => { const p = pending[id]; delete pending[id]; if (p) p({ ans, err }); });
  await receiver.addInitScript(() => { window.Cast = { answer: (id, a, e) => window.__answer(id, a, e) }; });
  await receiver.goto(RECEIVER);
  await receiver.evaluate(() => showInfo('482193', '127.0.0.1', 'Relay Projector'));
  const seenIps = [];
  let updateSeen = null;

  // Stand-in for MainActivity: what it does with evaluateJavascript + the Cast bridge.
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        if (req.url === '/stats') {
          const text = await receiver.evaluate(() => document.getElementById('stats').textContent);
          res.end(JSON.stringify({ app: 'test', mode: '2/4 Web standard', stats: text, events: ['12:00:00  offer from TEST'] }));
          return;
        }
        if (req.url === '/update') { updateSeen = JSON.parse(body); res.end('{}'); return; }
        if (req.url === '/stop') { await receiver.evaluate(() => stopCast('The PC stopped casting')); res.end('{}'); return; }
        const { offer, sender, ip } = JSON.parse(body);
        seenIps.push(ip);
        const id = nextId++;
        const done = new Promise((r) => { pending[id] = r; });
        await receiver.evaluate(([i, o, s, a]) => handleOffer(i, o, s, a), [id, offer, sender, ip]);
        const r = await done;
        if (r.err) { res.writeHead(500); res.end(r.err); return; }
        res.end(r.ans);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  }).listen(47900, '127.0.0.1');

  const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
    args: [APP, '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForFunction(() => document.querySelectorAll('#picker .pick-card').length > 0);
  const screens = await win.locator('#picker .pick-card').count();
  const groups = await win.locator('#picker .group').allTextContents();
  assert(!(await win.evaluate(() => document.querySelector('#picker details').open)), 'picker starts folded');
  assert(groups.includes('Whole screen'), 'grouped picker: ' + groups);
  console.log(`PASS app window opened, ${screens} source(s) listed under ${groups.join(' / ')}`);
  await win.screenshot({ path: path.join(__dirname, 'out-app-idle.png') });

  // Wrong code first: should say not found, quickly enough.
  await win.fill('#code', '111111');
  await win.click('#start');
  await win.waitForFunction(() => document.getElementById('error').textContent.length > 0, null, { timeout: 10000 });
  const err = await win.textContent('#error');
  assert(/not found/i.test(err), err);
  console.log('PASS wrong code -> "' + err.slice(0, 60) + '..."');

  // Typing letters is ignored.
  await win.fill('#code', '');
  await win.type('#code', '48ab2193');
  assert.strictEqual(await win.inputValue('#code'), '482193');
  console.log('PASS code box only accepts digits');

  await win.selectOption('#quality', 'p1080_60');
  await win.click('#start');
  // Relay projector reports version 2; this PC app carries version 3, so it offers the update first.
  await win.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  const offerText = await win.textContent('#updateText');
  const bundledVersion = fs.readFileSync(path.resolve(__dirname, '../../dist/ProjectorCast.version'), 'utf8').trim();
  assert(offerText.includes(`2 → ${bundledVersion}`), offerText);
  console.log('PASS out-of-date projector app detected: "' + offerText + '"');
  await win.screenshot({ path: path.join(__dirname, 'out-app-update.png') });
  await win.click('#updateSkip');
  await win.waitForFunction(() => document.getElementById('dot').classList.contains('live'), null, { timeout: 20000 });
  console.log('PASS casting: "' + await win.textContent('#state') + '"');
  await receiver.waitForTimeout(5000);
  const stats = await win.textContent('#stats');
  console.log('     PC stats: ' + stats);
  const preview = await win.evaluate(() => { const v = document.getElementById('preview'); return { w: v.videoWidth, t: v.currentTime }; });
  assert(preview.w > 0 && preview.t > 1, 'PC preview plays: ' + JSON.stringify(preview));
  console.log('PASS PC preview shows what is sent');
  await win.waitForFunction(() => /Web standard/.test(document.getElementById('projStats').textContent), null, { timeout: 10000 });
  await win.waitForTimeout(4500);
  await win.click('#copyReport');
  const report = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(/Projector Cast report/.test(report) && /PC: \d+×\d+/.test(report) && /Projector: .*Picture/.test(report) && /offer from TEST/.test(report),
    'report has PC and projector timelines and events:\n' + report.slice(0, 600));
  console.log(`PASS report copied: ${report.split('\n').length} lines with PC + projector stats every 2 s`);

  // Change quality while casting (1080p60 -> 720p30) without stopping.
  await win.click('#liveSettings summary');
  await win.selectOption('#liveQuality', 'p720_30');
  await win.click('#applyLive');
  await receiver.waitForFunction(() => { const v = document.getElementById('video'); return v.videoWidth === 1280 && v.videoHeight === 720 && !v.paused; }, null, { timeout: 20000 });
  console.log('PASS quality changed while casting: projector now gets 1280x720');

  // Projector closes the connection (as when its display mode is switched): the PC reconnects by itself.
  const t0 = Date.now();
  await receiver.evaluate(() => stopCast('Display mode changed. Reconnecting...'));
  await receiver.waitForFunction(() => getComputedStyle(document.getElementById('idle')).display === 'none' && document.getElementById('video').videoWidth > 0, null, { timeout: 25000 });
  console.log(`PASS PC reconnected by itself ${((Date.now() - t0) / 1000).toFixed(1)} s after the projector dropped the connection`);
  const reconnectSecs = (Date.now() - t0) / 1000;
  assert(reconnectSecs < 6, 'reconnect should take a few seconds, took ' + reconnectSecs);
  await receiver.waitForTimeout(3000);
  await win.screenshot({ path: path.join(__dirname, 'out-app-live.png') });

  const rx = await receiver.evaluate(() => {
    const v = document.getElementById('video');
    return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, idle: getComputedStyle(document.getElementById('idle')).display };
  });
  assert(rx.w > 0 && rx.t > 2 && rx.idle === 'none', 'projector shows the PC screen: ' + JSON.stringify(rx));
  console.log(`PASS projector page is showing the PC screen ${rx.w}x${rx.h}`);
  await receiver.screenshot({ path: path.join(__dirname, 'out-projector-live.png') });

  await win.click('#stop');
  await receiver.waitForFunction(() => getComputedStyle(document.getElementById('idle')).display === 'flex', null, { timeout: 5000 });
  assert(await win.isVisible('#setup'), 'PC app back to setup');
  console.log('PASS stop returns both sides to the start screen');

  await win.click('#start');
  await win.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  await win.click('#updateNow');
  await win.waitForFunction(() => /Update sent/.test(document.getElementById('error').textContent), null, { timeout: 30000 });
  assert(updateSeen && updateSeen.pk && updateSeen.bytes === fs.statSync(APK).size, 'projector received the whole APK: ' + JSON.stringify(updateSeen));
  console.log(`PASS "Update the projector app" delivered the ${updateSeen.bytes}-byte APK`);

  // Cast one window only.
  await app.evaluate(({ BrowserWindow }) => {
    const w = new BrowserWindow({ width: 800, height: 600, x: 900, y: 100, title: 'Match Window', show: true });
    w.loadURL('data:text/html,<title>Match Window</title><body style="margin:0;background:%2300a050"><h1 style="color:white">MATCH</h1>');
  });
  await win.waitForTimeout(1500);
  await win.click('#picker summary');
  await win.click('#picker .refresh');
  await win.waitForTimeout(800);
  const names = await win.locator('#picker .pick-card span').allTextContents();
  const groups2 = await win.locator('#picker .group').allTextContents();
  assert(names.includes('Match Window') && groups2.includes('One window'), 'window listed: ' + names + ' / ' + groups2);
  assert(!names.includes('Projector Cast'), 'own window is not offered');
  await win.click('#picker .pick-card[title="Match Window"]');
  assert(!(await win.evaluate(() => document.querySelector('#picker details').open)), 'picker folds after a pick');
  assert(/Match Window/.test(await win.textContent('#picker summary')), 'folded picker shows the pick');
  await win.click('#start');
  await win.waitForSelector('#update:not([hidden])', { timeout: 10000 });
  await win.click('#updateSkip');
  await win.waitForFunction(() => document.getElementById('dot').classList.contains('live'), null, { timeout: 20000 });
  await receiver.waitForTimeout(3000);
  const one = await receiver.evaluate(() => {
    const v = document.getElementById('video');
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    const px = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height * 0.8), 1, 1).data;
    return { w: v.videoWidth, h: v.videoHeight, px: [px[0], px[1], px[2]] };
  });
  assert(one.w < 1000 && one.h < 800 && one.px[1] > 120 && one.px[0] < 60, 'projector shows only the green window: ' + JSON.stringify(one));
  console.log(`PASS casting one window: projector shows just that window (${one.w}x${one.h})`);
  assert.strictEqual(await win.textContent('#castingWhat'), 'Window: Match Window');

  // Switch to the whole screen while casting, without reconnecting.
  const pcBefore = await receiver.evaluate(() => { window.__pcMark = pc; return true; });
  await win.click('#liveSettings summary');
  await win.click('#livePicker summary');
  await win.locator('#livePicker .pick-card').first().click();
  await receiver.waitForFunction(() => document.getElementById('video').videoWidth > 1000, null, { timeout: 15000 });
  const same = await receiver.evaluate(() => window.__pcMark === pc);
  assert(pcBefore && same, 'switched without a new connection');
  assert(/Entire screen|Screen/.test(await win.textContent('#castingWhat')), await win.textContent('#castingWhat'));
  console.log('PASS switched from the window to the whole screen while casting, same connection');
  // ...and back to the window.
  await win.click('#livePicker summary');
  await win.click('#livePicker .pick-card[title="Match Window"]');
  await receiver.waitForFunction(() => { const v = document.getElementById('video'); return v.videoWidth > 0 && v.videoWidth < 1000; }, null, { timeout: 15000 });
  console.log('PASS switched back to the window');
  // Picked window closes before casting: must refuse, never fall back to the whole screen.
  await win.click('#stop');
  await receiver.waitForFunction(() => getComputedStyle(document.getElementById('idle')).display === 'flex', null, { timeout: 5000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Match Window').close());
  await win.waitForTimeout(500);
  await win.evaluate(() => window.cast.prepareCapture({ screenId: selectedScreen, screenName: 'Match Window', audio: false }));
  const refused = await win.evaluate(() => navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return false; }, () => true));
  assert(refused, 'closed window is not silently replaced by the whole screen');
  console.log('PASS a closed window is refused instead of casting the whole screen');
  await receiver.screenshot({ path: path.join(__dirname, 'out-projector-window.png') });
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  assert.strictEqual(await win.inputValue('#capture'), 'auto');
  assert(seenIps.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)), 'PC address passed to receiver: ' + seenIps);
  assert.deepStrictEqual(errors, [], 'no errors in the app window');
  console.log('PASS no errors in the PC app');

  await app.close();

  // Compatibility capture method is applied at start-up.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ captureMethod: 'compat' }));
  const app2 = await _electron.launch({ executablePath: path.join(APP, 'node_modules/electron/dist/electron'), args: [APP, '--no-sandbox'] });
  const flags = await app2.evaluate(({ app: a }) => a.commandLine.getSwitchValue('disable-features'));
  const win2 = await app2.firstWindow();
  await win2.waitForFunction(() => document.querySelectorAll('#picker .pick-card').length > 0);
  assert(/AllowWgcScreenCapturer/.test(flags) && /WebRtcHideLocalIpsWithMdns/.test(flags), flags);
  assert.strictEqual(await win2.inputValue('#capture'), 'compat');
  console.log('PASS compatibility capture method is applied after restart: ' + flags);
  await app2.close();
  fs.unlinkSync(path.join(userData, 'settings.json'));
  await browser.close();
  console.log('ALL ELECTRON APP TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
