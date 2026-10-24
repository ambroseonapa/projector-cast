// Drives the real Electron PC app (UI, discovery, HTTP, capture of the virtual screen) against
// the real CastServer (tests/jvm/RelayServer) whose receiver page runs in Chromium.
const { chromium, _electron } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const http = require('http');
const path = require('path');
const assert = require('assert');

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

  // Stand-in for MainActivity: what it does with evaluateJavascript + the Cast bridge.
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
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
  await win.waitForSelector('.screen');
  const screens = await win.locator('.screen').count();
  console.log(`PASS app window opened, ${screens} screen(s) listed`);
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
  await win.waitForFunction(() => document.getElementById('dot').classList.contains('live'), null, { timeout: 20000 });
  console.log('PASS casting: "' + await win.textContent('#state') + '"');
  await receiver.waitForTimeout(5000);
  const stats = await win.textContent('#stats');
  console.log('     PC stats: ' + stats);
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
  assert(seenIps.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)), 'PC address passed to receiver: ' + seenIps);
  assert.deepStrictEqual(errors, [], 'no errors in the app window');
  console.log('PASS no errors in the PC app');

  await app.close();
  await browser.close();
  console.log('ALL ELECTRON APP TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
