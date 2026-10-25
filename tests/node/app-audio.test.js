// One app's sound: main.js handlers with PowerShell faked.
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { EventEmitter, PassThrough } = { ...require('events'), ...require('stream') };

const handlers = {};
const spawned = [];
let psOut = '';
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} }, getPath: () => require('os').tmpdir(), isPackaged: false },
  BrowserWindow: function () {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  desktopCapturer: {}, session: {}, clipboard: {}, screen: { getAllDisplays: () => [] },
  shell: { openExternal() {} }, powerSaveBlocker: { start: () => 1, stop: () => {} },
};
const fakeChild = {
  execFile: (file, args, opts, cb) => setImmediate(() => cb(null, psOut, '')),
  spawn: (file, args) => {
    const p = new EventEmitter();
    p.exitCode = null;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.stdin = new PassThrough();
    p.input = '';
    p.stdin.on('data', (d) => { p.input += d; });
    p.kill = () => { p.exitCode = 1; p.emit('exit', 1); };
    spawned.push({ file, args, p });
    return p;
  },
};
Object.defineProperty(process, 'platform', { value: 'win32' });
const realOs = require('os');
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === 'child_process') return fakeChild;
  if (req === 'os') return { ...realOs, release: () => '10.0.26300' };
  return realLoad.call(this, req, ...rest);
};
require(path.join(__dirname, '../../sender-pc/main.js'));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  assert.strictEqual(await handlers['app-audio-supported'](), true);
  await assert.rejects(handlers['app-audio-start']({}, { windowId: 'screen:0:0', mute: false }), /not a window/);
  const started = handlers['app-audio-start']({}, { windowId: 'window:4242:0', mute: true });
  await tick();
  const { args, p } = spawned[0];
  assert(args.includes('-Mta'), 'COM callbacks need a multithreaded apartment');
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert(script.startsWith('$TargetWindow = 4242; $Mute = $true\r\n'), script.slice(0, 60));
  assert(/VAD\\\\Process_Loopback/.test(script) && /PidOfWindow/.test(script) && /SetMute/.test(script) && !/^\s*#/m.test(script), 'helper script, compacted');
  assert(args.join(' ').length < 32000, 'fits the command-line limit: ' + args.join(' ').length);
  p.stdout.write(Buffer.from([1, 2, 3, 4, 5, 6])); // first sound: counts as started
  await started;
  console.log('PASS helper starts for the window\'s app, with mute flag and Process_Loopback capture');

  handlers['app-audio-stop']();
  await tick();
  assert.strictEqual(p.input, 'stop\r\n', 'stop is sent so the helper unmutes the app');
  console.log('PASS stop asks the helper to unmute and exit');

  const failing = handlers['app-audio-start']({}, { windowId: 'window:1:0', mute: false });
  await tick();
  const f = spawned[1].p;
  f.stderr.write('Windows could not capture this app (0x80070057)\r\n');
  await tick();
  f.emit('exit', 1);
  await assert.rejects(failing, /could not capture this app \(0x80070057\)/);
  console.log('PASS a helper error is reported');
  console.log('ALL APP SOUND TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
