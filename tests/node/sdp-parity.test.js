// The native player (SdpTools.java) must fix SDP exactly like the web receiver (receiver.html).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { execFileSync } = require('child_process');

const fx = path.join(__dirname, '../fixtures');
const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdp-'));
execFileSync('java', ['-cp', path.join(__dirname, '../jvm/out'), 'SdpToolsTest', fx, out], { stdio: 'inherit' });

const html = fs.readFileSync(path.join(__dirname, '../../receiver-android/assets/receiver.html'), 'utf8');
const ctx = {};
for (const name of ['wantStereo', 'unhideAddresses']) {
  const m = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`).exec(html);
  vm.runInNewContext(m[0] + `;this.${name} = ${name};`, ctx);
}
const offer = fs.readFileSync(path.join(fx, 'chrome-offer.sdp'), 'utf8');
const answer = fs.readFileSync(path.join(fx, 'chrome-answer.sdp'), 'utf8');
const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');

const jsOffer = ctx.unhideAddresses(offer, '192.168.1.20');
assert.strictEqual(read('java-offer.sdp'), jsOffer);
assert(/udp \d+ 192\.168\.1\.20 \d+ typ host/.test(jsOffer) && !/udp \d+ \S+\.local /.test(jsOffer), 'all udp .local names replaced');
console.log('PASS native and web players restore the PC address the same way');

const jsAnswer = ctx.wantStereo(answer);
assert.strictEqual(read('java-answer.sdp'), jsAnswer);
assert(/a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000/.test(jsAnswer), jsAnswer.match(/a=fmtp:111.*/)[0]);
assert.strictEqual(read('java-answer-twice.sdp'), jsAnswer, 'applying twice changes nothing');
console.log('PASS native and web players request stereo sound the same way');
