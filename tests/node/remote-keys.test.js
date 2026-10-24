// Projector remote keys handled by main.js, with PowerShell faked.
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const handlers = {};
const spawned = [];
const fakeElectron = {
  app: { whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} }, getPath: () => require('os').tmpdir(), isPackaged: false },
  BrowserWindow: function () {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  desktopCapturer: {}, session: {}, clipboard: {}, screen: { getAllDisplays: () => [] },
  shell: { openExternal() {} },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
};
const fakeChild = {
  execFile() {},
  spawn: (file, args) => {
    const p = new EventEmitter();
    p.exitCode = null;
    p.lines = [];
    p.stdin = new EventEmitter();
    p.stdin.write = (t) => p.lines.push(...t.split('\r\n').filter(Boolean));
    p.kill = () => {};
    spawned.push({ file, args, p });
    return p;
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
  assert.strictEqual(await handlers['remote-key']({}, 'format-disk'), false);
  assert.strictEqual(spawned.length, 0, 'unknown keys are ignored');
  console.log('PASS unknown keys are ignored');

  await handlers['prepare-capture']({}, { screenId: 'screen:0:0', audio: true });
  assert.strictEqual(await handlers['remote-key']({}, 'playpause'), true);
  assert.strictEqual(spawned.length, 1);
  const script = Buffer.from(spawned[0].args[spawned[0].args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert(/keybd_event/.test(script) && /ReadLine/.test(script), 'helper reads keys from stdin');
  assert.deepStrictEqual(spawned[0].p.lines, ['179 0'], 'media key play/pause, no window');
  console.log('PASS play/pause sends the media key');

  await handlers['prepare-capture']({}, { screenId: 'window:526312:0', audio: true });
  await handlers['remote-key']({}, 'forward');
  await handlers['remote-key']({}, 'back');
  await handlers['remote-key']({}, 'next');
  assert.strictEqual(spawned.length, 1, 'one helper process for the session');
  assert.deepStrictEqual(spawned[0].p.lines.slice(1), ['39 526312', '37 526312', '176 0'], 'arrow keys go to the cast window');
  console.log('PASS skip keys go to the cast window, next/previous are media keys');

  spawned[0].p.exitCode = 1;
  await handlers['remote-key']({}, 'previous');
  assert.strictEqual(spawned.length, 2, 'helper restarted after it exits');
  assert.deepStrictEqual(spawned[1].p.lines, ['177 0']);
  console.log('PASS helper restarts if it exits');
  console.log('ALL REMOTE KEY TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
