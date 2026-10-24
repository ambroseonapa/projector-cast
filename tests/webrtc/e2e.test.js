// End-to-end: sender (cast-core.js) -> receiver (receiver.html) over a real WebRTC connection in Chromium.
const { chromium } = require(process.env.PLAYWRIGHT_DIR || 'playwright');
const path = require('path');
const assert = require('assert');

const RECEIVER = 'file://' + path.resolve(__dirname, '../../receiver-android/assets/receiver.html');
const SENDER = 'file://' + path.resolve(__dirname, 'sender-test.html');

async function setup(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const receiver = await ctx.newPage();
  const sender = await ctx.newPage();
  const errors = [];
  for (const p of [receiver, sender]) p.on('pageerror', (e) => errors.push(e.message));

  const pending = {};
  let nextId = 1;
  await receiver.exposeFunction('__answer', (id, ans, err) => { const p = pending[id]; delete pending[id]; if (p) p(err ? { err } : { ans }); });
  await receiver.addInitScript(() => { window.Cast = { answer: (id, a, e) => window.__answer(id, a, e), setDisplayMode: (m) => { window.__savedMode = m; } }; });
  await receiver.goto(RECEIVER);
  await receiver.evaluate(() => showInfo('482193', '192.168.1.50', 'Smart projector'));

  await sender.exposeFunction('relayOffer', async (offerText) => {
    const id = nextId++;
    const done = new Promise((r) => { pending[id] = r; });
    // Same call MainActivity makes: the offer goes in as a quoted string.
    await receiver.evaluate(([i, o]) => handleOffer(i, o, 'TEST-PC', '127.0.0.1'), [id, offerText]);
    const res = await done;
    if (res.err) throw new Error(res.err);
    return res.ans;
  });
  await sender.exposeFunction('relayStop', () => receiver.evaluate(() => stopCast('The PC stopped casting')));
  await sender.goto(SENDER);
  return { ctx, receiver, sender, errors };
}

async function receiverStats(receiver) {
  return receiver.evaluate(async () => {
    const out = { codecs: [] };
    const rep = await pc.getStats();
    const byId = {};
    rep.forEach((r) => { byId[r.id] = r; });
    rep.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') Object.assign(out, { w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, decoded: r.framesDecoded, dropped: r.framesDropped, freezes: r.freezeCount });
      if (r.type === 'inbound-rtp' && r.kind === 'audio') Object.assign(out, { audioBytes: r.bytesReceived, concealed: r.concealedSamples, samples: r.totalSamplesReceived });
      if (r.type === 'inbound-rtp' && r.codecId && byId[r.codecId]) out.codecs.push(byId[r.codecId].mimeType + ' ' + (byId[r.codecId].channels || '') + ' ' + (byId[r.codecId].sdpFmtpLine || ''));
    });
    const v = document.getElementById('video');
    out.videoW = v.videoWidth; out.videoH = v.videoHeight; out.time = v.currentTime; out.paused = v.paused;
    out.tracks = v.srcObject ? v.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState) : [];
    out.idleShown = getComputedStyle(document.getElementById('idle')).display !== 'none';
    return out;
  });
}

async function run(browser, opts, label, gpu) {
  const { ctx, receiver, sender, errors } = await setup(browser);
  if (gpu) await sender.evaluate((always) => simulateWindowsGpu(always), gpu === 'always-throw');
  const t0 = Date.now();
  await sender.evaluate((o) => runCast(o), opts);
  await sender.waitForFunction(() => window.log.some((l) => l.startsWith('live:')), null, { timeout: 15000 });
  const connectMs = Date.now() - t0;
  const timeline = [];
  for (let i = 0; i < 8; i++) {
    await receiver.waitForTimeout(1000);
    timeline.push(await sender.evaluate(() => window.lastStats));
  }
  console.log(`  [${label}] sender over 8 s:`, timeline.join(' | '));
  const s = await receiverStats(receiver);
  const senderStats = timeline[timeline.length - 1];
  const sent = await sender.evaluate(async () => {
    const rep = await window.session.pc.getStats(); const out = [];
    const byId = {}; rep.forEach((r) => { byId[r.id] = r; });
    rep.forEach((r) => { if (r.type === 'outbound-rtp' && byId[r.codecId]) out.push(r.kind + ' ' + byId[r.codecId].mimeType + ' ' + byId[r.codecId].sdpFmtpLine); });
    return out;
  });
  console.log(`  [${label}] sender codecs:`, sent.join(' || '));
  console.log(`  [${label}] connected in ${connectMs} ms; receiver:`, JSON.stringify(s));
  console.log(`  [${label}] sender stats line: "${senderStats}"`);

  assert(!s.idleShown, 'video shown instead of code screen');
  assert(s.videoW >= 1280 && s.videoH >= 720, `HD picture arrived (${s.videoW}x${s.videoH})`);
  assert(!s.paused && s.time > 3, 'video is playing');
  assert(s.tracks.includes('video:live') && s.tracks.includes('audio:live'), 'video and audio tracks live: ' + s.tracks);
  assert(s.audioBytes > 10000, 'audio data flowing');
  const audioCodec = s.codecs.find((c) => /opus/i.test(c)) || '';
  assert(/stereo=1/.test(audioCodec), 'stereo opus negotiated: ' + audioCodec);
  assert(s.decoded > 100, 'frames decoded: ' + s.decoded);
  if (opts.quality === 'p720_60') assert(s.w === 1280 && s.h === 720, '720p setting sends 1280x720: ' + s.w + 'x' + s.h);
  assert.strictEqual(s.dropped || 0, 0, 'no dropped frames');
  const kbpsAudio = s.audioBytes * 8 / 1000 / s.time;
  assert(kbpsAudio > 128, 'sound sent at music quality: ' + kbpsAudio.toFixed(0) + ' kbps');
  const deg = await sender.evaluate(() => window.session.pc.getSenders().find((x) => x.track && x.track.kind === 'video').getParameters().degradationPreference);
  assert(!deg || deg === 'maintain-resolution', 'picture size is locked: ' + deg);
  await receiver.evaluate(() => toggleStats());
  await receiver.waitForTimeout(1500);
  const panel = await receiver.evaluate(() => ({ text: document.getElementById('stats').textContent, shown: getComputedStyle(document.getElementById('stats')).display }));
  console.log('  [' + label + '] projector stats panel:\n    ' + panel.text.split('\n').join('\n    '));
  assert(panel.shown === 'block' && /Picture/.test(panel.text) && /Decoder/.test(panel.text) && /Sound .*stereo/.test(panel.text), 'stats panel works');
  assert(/Size changes 0/.test(panel.text), 'no picture size changes');

  const want = opts.buffer == null ? 150 : opts.buffer;
  const buffers = await receiver.evaluate(() => pc.getReceivers().map((r) => ('jitterBufferTarget' in r ? r.jitterBufferTarget : r.playoutDelayHint * 1000)));
  assert(buffers.length === 2 && buffers.every((b) => Math.round(b) === want), 'receive buffer follows the PC setting: ' + buffers + ' want ' + want);

  if (opts.checkModes) {
    const look = () => receiver.evaluate(() => {
      const c = document.getElementById('canvas');
      let lit = 0;
      if (getComputedStyle(c).display !== 'none' && c.width) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4 * 997) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      }
      const v = document.getElementById('video');
      return { mode: displayMode, videoShown: getComputedStyle(v).display !== 'none' && v.getBoundingClientRect().width > 100,
        gpu: v.className === 'gpu', canvasShown: getComputedStyle(c).display !== 'none', lit, playing: !v.paused, t: v.currentTime };
    });
    await receiver.evaluate(() => setWebMode(2));
    const m2 = await look();
    assert(m2.mode === 2 && m2.videoShown && m2.gpu && !m2.canvasShown, 'mode 2 GPU layer: ' + JSON.stringify(m2));
    await receiver.evaluate(() => setWebMode(3));
    await receiver.waitForTimeout(1000);
    const m3 = await look();
    await receiver.waitForTimeout(1000);
    const m3b = await look();
    assert(m3.mode === 3 && m3.canvasShown && !m3.videoShown && m3.lit > 20 && m3b.t > m3.t + 0.5 && m3b.playing, 'mode 3 canvas paints the live picture: ' + JSON.stringify(m3) + JSON.stringify(m3b));
    await receiver.evaluate(() => setWebMode(1));
    const m1 = await look();
    assert(m1.mode === 1 && m1.videoShown && !m1.canvasShown && !m1.gpu, 'back to mode 1: ' + JSON.stringify(m1));
    await receiver.evaluate(() => setWebMode(9));
    assert.strictEqual((await look()).mode, 1, 'unknown web mode falls back to standard');
    console.log('PASS web display modes (standard, GPU layer, canvas) all show the picture');
  }
  console.log(`  [${label}] freezes=${s.freezes} dropped=${s.dropped}`);
  assert((s.freezes || 0) <= 1, 'at most one freeze: ' + s.freezes);
  assert(/\d+×\d+ · \d+ fps/.test(senderStats || ''), 'sender shows live stats');

  // A second "Start casting" replaces the old session cleanly.
  await sender.evaluate(() => window.session.connect());
  await receiver.waitForTimeout(3000);
  const s2 = await receiverStats(receiver);
  assert(s2.decoded > 30 && s2.videoW >= 1280, 'reconnect works: ' + JSON.stringify(s2));

  await sender.evaluate(() => window.session.stop('Stopped'));
  await receiver.waitForTimeout(500);
  const idle = await receiver.evaluate(() => ({ idle: getComputedStyle(document.getElementById('idle')).display, status: document.getElementById('status').textContent, pc: window.pc }));
  assert(idle.idle === 'flex' && idle.pc === null, 'receiver returns to code screen after stop: ' + JSON.stringify(idle));
  assert.deepStrictEqual(errors, [], 'no page errors');
  await ctx.close();
  return s;
}

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
  // Unit check of the SDP tuning on a realistic answer.
  const page = await browser.newPage();
  await page.goto(SENDER);
  const tuned = await page.evaluate(() => {
    const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96 102', 'c=IN IP4 0.0.0.0', 'b=AS:300', 'a=rtpmap:96 VP8/90000',
      'a=rtpmap:102 H264/90000', 'a=fmtp:102 profile-level-id=42e01f;packetization-mode=1',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1', ''].join('\r\n');
    return CastCore.tuneAnswer(sdp, 12000);
  });
  assert(/b=AS:12000/.test(tuned) && !/b=AS:300/.test(tuned), 'video bandwidth line replaced');
  assert(/a=fmtp:96 x-google-start-bitrate=7200;x-google-min-bitrate=2400;x-google-max-bitrate=12000/.test(tuned), 'VP8 gets its own fmtp');
  assert(/a=fmtp:102 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=7200/.test(tuned), 'H264 fmtp extended');
  assert(/a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000/.test(tuned), 'opus stereo');
  assert(tuned.indexOf('a=fmtp:96') < tuned.indexOf('m=audio'), 'VP8 fmtp stays inside the video section');
  assert(tuned.endsWith('\r\n') && !/\r\n\r\n/.test(tuned), 'SDP line endings intact');
  console.log('PASS SDP tuning');
  const unhidden = await page.evaluate(() => CastCore.unhideAddresses(
    'a=candidate:1 1 udp 2122260223 3f1a2b4c-1111-2222-3333-444455556666.local 54321 typ host generation 0\r\n' +
    'a=candidate:2 1 tcp 1518280447 9a9a9a9a-1111-2222-3333-444455556666.local 9 typ host tcptype active\r\n', '192.168.1.50'));
  assert(unhidden.includes('udp 2122260223 192.168.1.50 54321 typ host'), 'udp .local replaced: ' + unhidden);
  assert(unhidden.includes('9a9a9a9a-1111-2222-3333-444455556666.local'), 'tcp line untouched');
  console.log('PASS hidden .local addresses replaced');
  await page.close();

  await run(browser, { quality: 'p720_30', content: 'motion', codec: 'h264', audio: true, checkModes: true }, '720p30 default');
  await run(browser, { quality: 'p720_30', content: 'motion', codec: 'h264', audio: true, buffer: 0 }, '720p30 lowest delay');
  console.log('PASS lowest-delay setting reaches the projector');
  console.log('PASS 720p30 (new default)');
  await run(browser, { quality: 'p1080_60', content: 'motion', codec: 'h264', audio: true }, '1080p60 H264 motion');
  console.log('PASS 1080p60 / H.264 / sound');
  await run(browser, { quality: 'p1080_30', content: 'detail', codec: 'vp8', audio: true }, '1080p30 VP8 detail');
  console.log('PASS 1080p30 / VP8 / sound');
  await run(browser, { quality: 'p720_60', content: 'motion', codec: 'h264', audio: true }, '720p60');
  console.log('PASS 720p60');
  const g1 = await run(browser, { quality: 'p1080_30', content: 'motion', codec: 'h264', audio: true }, 'Windows GPU codec list', 'extra-h264');
  assert(g1.codecs.some((c) => /video\/H264/.test(c)), 'still uses H.264 on such a PC: ' + g1.codecs);
  console.log('PASS PC whose GPU lists an unusable H.264 format still casts in H.264');
  await run(browser, { quality: 'p1080_30', content: 'motion', codec: 'h264', audio: true }, 'codec prefs always rejected', 'always-throw');
  console.log('PASS casting still works if the codec preference is refused outright');
  await browser.close();
  console.log('ALL WEBRTC END-TO-END TESTS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
