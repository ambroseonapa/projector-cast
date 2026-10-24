// Loads sender-pc/main.js with a fake `electron` module and calls its IPC handlers
// against the real receiver server (tests/jvm/RunServer) on this machine.
const Module = require('module');
const path = require('path');
const assert = require('assert');

const handlers = {};
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} }, getPath: () => require('os').tmpdir(), isPackaged: false },
  BrowserWindow: function () {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  desktopCapturer: {}, session: {}, shell: {},
  powerSaveBlocker: { start: () => 7, stop: () => {} },
};
const realLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : realLoad.call(this, req, ...rest); };
require(path.join(__dirname, '../../sender-pc/main.js'));

(async () => {
  let ok = 0;
  const pass = (m) => { ok++; console.log('PASS ' + m); };

  const found = await handlers['find-projector']({}, '482193');
  assert(found && found.name === 'Test Projector', 'discovery: ' + JSON.stringify(found));
  pass(`finds the projector by code via broadcast (${found.ip})`);

  const none = await handlers['find-projector']({}, '999999');
  assert.strictEqual(none, null);
  pass('wrong code finds nothing (after timeout)');

  const ping = await handlers['ping']({}, '127.0.0.1');
  assert.strictEqual(ping.name, 'Test Projector');
  pass('ping by manual address');

  const ans = await handlers['send-offer']({}, { ip: '127.0.0.1', code: '482193', offer: { type: 'offer', sdp: 'v=0\r\n' } });
  assert.strictEqual(ans.type, 'answer');
  pass('offer -> answer round trip');

  await assert.rejects(handlers['send-offer']({}, { ip: '127.0.0.1', code: '111111', offer: { type: 'offer', sdp: '' } }), /Wrong code/);
  pass('wrong code gives a clear error');

  await assert.rejects(handlers['ping']({}, '127.0.0.2').then(() => { throw new Error('x'); }), /not open|reach|ECONN|x/);
  pass('no app at an address gives an error');

  assert.strictEqual(await handlers['send-stop']({}, { ip: '127.0.0.1', code: '482193' }) .then((r) => r.ok), true);
  pass('stop');

  console.log(`ALL ${ok} PC NETWORK TESTS PASSED`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
