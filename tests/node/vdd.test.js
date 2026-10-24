// Second-screen (virtual display) handlers in main.js, with PowerShell and winget faked.
const Module = require('module');
const path = require('path');
const assert = require('assert');

const handlers = {};
const calls = [];
let reply = () => ({ err: null, out: '' });
const opened = [];
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} }, getPath: () => require('os').tmpdir(), isPackaged: false },
  BrowserWindow: function () {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  desktopCapturer: {}, session: {}, clipboard: {}, screen: { getAllDisplays: () => [] },
  shell: { openExternal: (u) => opened.push(u) },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
};
const fakeChild = {
  execFile: (file, args, opts, cb) => {
    calls.push({ file, args });
    const r = reply(file, args);
    setImmediate(() => cb(r.err, r.out || '', ''));
  },
};
Object.defineProperty(process, 'platform', { value: 'win32' });
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === 'child_process') return fakeChild;
  return realLoad.call(this, req, ...rest);
};
require(path.join(__dirname, '../../sender-pc/main.js'));

(async () => {
  reply = () => ({ err: null, out: '' });
  assert.deepStrictEqual(await handlers['vdd-status'](), { supported: true, installed: false });
  assert(/Get-PnpDevice -Class Display/.test(calls[0].args.join(' ')) && /Virtual Display Driver/.test(calls[0].args.join(' ')));
  console.log('PASS status: not installed');

  reply = () => ({ err: null, out: 'OK\r\n' });
  assert.deepStrictEqual(await handlers['vdd-status'](), { supported: true, installed: true, on: true });
  reply = () => ({ err: null, out: 'Error' });
  assert.deepStrictEqual(await handlers['vdd-status'](), { supported: true, installed: true, on: false });
  console.log('PASS status: installed on / off');

  calls.length = 0;
  reply = () => ({ err: null });
  assert.deepStrictEqual(await handlers['vdd-install'](), { ok: true });
  assert.strictEqual(calls[0].file, 'winget');
  assert.deepStrictEqual(calls[0].args.slice(0, 4), ['install', '--id', 'VirtualDrivers.Virtual-Display-Driver', '-e']);
  console.log('PASS install runs winget with the package id');

  reply = () => ({ err: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
  assert.deepStrictEqual(await handlers['vdd-install'](), { ok: false, manual: true });
  assert(/Virtual-Display-Driver\/releases/.test(opened.pop()));
  console.log('PASS without winget the installer page opens');

  calls.length = 0;
  reply = () => ({ err: null });
  await handlers['vdd-set']({}, false);
  const cmd = calls[0].args.join(' ');
  assert(/Start-Process powershell.exe -Verb RunAs/.test(cmd), cmd);
  const encoded = /-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(cmd)[1];
  const inner = Buffer.from(encoded, 'base64').toString('utf16le');
  assert(/Disable-PnpDevice -Confirm:\$false/.test(inner) && /Virtual Display Driver/.test(inner), inner);
  console.log('PASS turn off runs Disable-PnpDevice elevated: ' + inner.slice(-60));
  console.log('ALL SECOND-SCREEN TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
