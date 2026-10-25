// Second-screen (virtual display) handlers in main.js, with PowerShell and winget faked.
const Module = require('module');
const path = require('path');
const assert = require('assert');

const handlers = {};
const calls = [];
let reply = () => ({ err: null, out: '' });
const opened = [];
const fetched = [];
let body = (url) => url; // what the fake server sends for a URL
const { EventEmitter, PassThrough } = { ...require('events'), ...require('stream') };
const fakeHttps = {
  get: (url, opts, cb) => {
    const req = new EventEmitter();
    fetched.push(url);
    setImmediate(() => {
      if (/redirect-me/.test(url)) {
        const res = new PassThrough();
        Object.assign(res, { statusCode: 302, headers: { location: url.replace('redirect-me', 'real') } });
        cb(res);
        res.end();
        return;
      }
      const res = new PassThrough();
      Object.assign(res, { statusCode: 200, headers: {} });
      cb(res);
      res.end(body(url));
    });
    return req;
  },
};
// Lets the fake files match their pinned checksums: the "hash" of a file is its content.
const realCrypto = require('crypto');
const fakeCrypto = { ...realCrypto, createHash: () => { let t = ''; return { update: (c) => { t += c; }, digest: () => t }; } };
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
  if (req === 'https') return fakeHttps;
  if (req === 'crypto') return fakeCrypto;
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

  // Install: download the pinned files, then one elevated script adds the driver.
  const source = require('fs').readFileSync(path.join(__dirname, '../../sender-pc/main.js'), 'utf8');
  const sums = Object.fromEntries([...source.matchAll(/(\w+): \{ url: '([^']+)',\s+sha256: '([0-9a-f]{64})'/g)].map((m) => [m[2], m[3]]));
  body = (url) => sums[url] || 'unexpected';
  calls.length = 0;
  reply = () => ({ err: null });
  assert.deepStrictEqual(await handlers['vdd-install'](), { ok: true });
  assert.deepStrictEqual(fetched.map((u) => u.split('/').pop()), ['nefcon_v1.14.0.zip', 'VirtualDisplayDriver-x86.Driver.Only.zip']);
  const outer = calls[0].args.join(' ');
  const script = Buffer.from(/-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)[1], 'base64').toString('utf16le');
  assert(/Start-Process powershell.exe -Verb RunAs/.test(outer), 'runs elevated');
  assert(/Start-Process -FilePath '[^']*x64[\\/]nefconw\.exe' -ArgumentList 'install', \$inf, 'Root\\MttVDD' -Wait -PassThru/.test(script)
    && /MttVDD\.inf/.test(script) && /\$p\.ExitCode -ne 0/.test(script), script);
  assert(script.includes(sums[fetched[1]].toUpperCase()) && /Get-FileHash/.test(script), 'checks the files again before installing');
  assert(/C:\\VirtualDisplayDriver\\vdd_settings\.xml/.test(script), 'driver settings file put in place');
  console.log('PASS install downloads the pinned files and adds the driver elevated');

  fetched.length = 0;
  body = () => 'tampered';
  calls.length = 0;
  const bad = await handlers['vdd-install']();
  assert.deepStrictEqual(bad, { ok: false, reason: 'downloaded file is damaged' });
  assert.strictEqual(calls.length, 0, 'nothing runs with a damaged file');
  console.log('PASS a damaged download is refused before anything runs');

  body = (url) => sums[url];
  reply = (file, args) => {
    // The elevated script failed and wrote why.
    require('fs').writeFileSync(path.join(require('os').tmpdir(), 'projector-cast-vdd', 'result.txt'), 'driver setup ended with code 5\r\n');
    return { err: new Error('exit 1') };
  };
  assert.deepStrictEqual(await handlers['vdd-install'](), { ok: false, reason: 'driver setup ended with code 5' });
  reply = () => ({ err: new Error('The operation was canceled by the user.') });
  assert.deepStrictEqual(await handlers['vdd-install'](), { ok: false, reason: 'administrator permission was not given' });
  console.log('PASS the reason for a failed install is reported');

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
