'use strict';

/*
 * Sender side of the WebRTC session. No Electron APIs here: everything that touches the
 * network goes through the `api` object, so this file also runs in a plain browser for tests.
 */
(function (global) {
  const QUALITY = {
    p720_30: { label: 'HD 720p · 30 fps (best for most projectors)', width: 1280, height: 720, fps: 30, kbps: 5000 },
    p1080_60: { label: 'Full HD 1080p · 60 fps (strong PC and projector)', width: 1920, height: 1080, fps: 60, kbps: 12000 },
    p1080_30: { label: 'Full HD 1080p · 30 fps (weaker Wi-Fi)', width: 1920, height: 1080, fps: 30, kbps: 8000 },
    p720_60: { label: 'HD 720p · 60 fps (weak Wi-Fi)', width: 1280, height: 720, fps: 60, kbps: 6000 },
    p4k_30: { label: '4K · 30 fps (only for 4K projectors)', width: 3840, height: 2160, fps: 30, kbps: 25000 },
  };

  /** Raises the receiver's advertised limits so the PC starts sharp and sends stereo sound. */
  function tuneAnswer(sdp, kbps) {
    const lines = sdp.split(/\r\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const out = [];
    let kind = null;
    let codecs = {};
    let fmtpSeen = {};

    const flushMissingFmtp = () => {
      // Video codecs without an fmtp line (VP8) still need the bitrate hints.
      if (kind !== 'video') return;
      for (const pt of Object.keys(codecs)) {
        if (!fmtpSeen[pt] && /^(VP8|VP9|H264|AV1)$/i.test(codecs[pt])) out.push(`a=fmtp:${pt} ${bitrateHints(kbps)}`);
      }
    };

    // First pass: find codec names per payload per section.
    const sections = [];
    let cur = null;
    for (const l of lines) {
      if (l.startsWith('m=')) {
        cur = { kind: l.slice(2).split(' ')[0], codecs: {} };
        sections.push(cur);
      }
      const m = cur && /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
      if (m) cur.codecs[m[1]] = m[2];
    }

    let sectionIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (l.startsWith('m=')) {
        flushMissingFmtp();
        sectionIndex++;
        kind = sections[sectionIndex].kind;
        codecs = sections[sectionIndex].codecs;
        fmtpSeen = {};
        out.push(l);
        continue;
      }
      if (kind === 'video' && l.startsWith('c=')) {
        out.push(l);
        out.push(`b=AS:${kbps}`);
        continue;
      }
      if (kind === 'video' && l.startsWith('b=')) continue; // replaced above
      const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (f) {
        const pt = f[1];
        const name = codecs[pt] || '';
        fmtpSeen[pt] = true;
        if (kind === 'audio' && /^opus$/i.test(name)) {
          l = setParams(l, { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '256000', useinbandfec: '1' });
        } else if (kind === 'video' && /^(VP8|VP9|H264|AV1)$/i.test(name)) {
          l = `${l};${bitrateHints(kbps)}`;
        }
      }
      out.push(l);
    }
    flushMissingFmtp();
    return out.join('\r\n') + '\r\n';
  }

  /** Replaces hidden "xxxx.local" ICE addresses with the projector's real IP (found by discovery). */
  function unhideAddresses(sdp, ip) {
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sdp;
    return sdp.replace(/^(a=candidate:\S+ \d+ udp \d+ )[0-9a-f-]+\.local( )/gim, `$1${ip}$2`);
  }

  function bitrateHints(kbps) {
    return `x-google-start-bitrate=${Math.round(kbps * 0.6)};x-google-min-bitrate=${Math.round(kbps * 0.2)};x-google-max-bitrate=${kbps}`;
  }

  function setParams(fmtpLine, params) {
    const m = /^(a=fmtp:\d+ )(.*)$/.exec(fmtpLine);
    const pairs = m[2].split(';').map((s) => s.trim()).filter(Boolean);
    const map = new Map(pairs.map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
    for (const [k, v] of Object.entries(params)) map.set(k, v);
    return m[1] + [...map].map(([k, v]) => `${k}=${v}`).join(';');
  }

  function waitForIce(pc, ms) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  const codecKey = (c) => `${c.mimeType.toLowerCase()}|${c.clockRate}|${c.sdpFmtpLine || ''}`;

  /** Orders `codecs` so the wanted codec comes first (baseline H.264 first of all: what TV chips decode in hardware). */
  function orderCodecs(codecs, codec) {
    const want = codec === 'vp8' ? /vp8/i : /h264/i;
    const baseline = (c) => (/42e01f|42001f/.test(c.sdpFmtpLine || '') ? 1 : 0);
    const first = codecs.filter((c) => want.test(c.mimeType)).sort((a, b) => baseline(b) - baseline(a));
    return first.length ? first.concat(codecs.filter((c) => !want.test(c.mimeType))) : null;
  }

  /**
   * Best effort: a codec preference is never worth failing the cast over. Chrome only accepts codecs it
   * can also receive, and on many Windows PCs the GPU's H.264 encoder lists formats that aren't in that
   * set (setCodecPreferences then throws "invalid codec with name H264"), so offer the shared ones only.
   */
  function preferCodec(transceiver, codec) {
    if (!transceiver.setCodecPreferences || !global.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return 'default';
    const recv = (RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
    const send = (global.RTCRtpSender && RTCRtpSender.getCapabilities && (RTCRtpSender.getCapabilities('video') || {}).codecs) || recv;
    const sendKeys = new Set(send.map(codecKey));
    const shared = recv.filter((c) => sendKeys.has(codecKey(c)));
    for (const list of [shared, recv]) {
      const ordered = orderCodecs(list, codec);
      if (!ordered) continue;
      try {
        transceiver.setCodecPreferences(ordered);
        return ordered[0].mimeType;
      } catch (_) { /* try the next list */ }
    }
    return 'default';
  }

  /**
   * One casting session: capture once, (re)connect to the projector as needed.
   * events: onState(text, kind), onStats(text), onEnded(reason)
   */
  class CastSession {
    constructor(api, opts, events) {
      this.api = api;
      this.opts = opts;
      this.events = events;
      this.q = QUALITY[opts.quality] || QUALITY.p1080_60;
      this.stream = null;
      this.pc = null;
      this.stopped = false;
      this.retries = 0;
      this.statsTimer = null;
    }

    async start(stream) {
      this.stream = stream || await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: this.q.width, max: this.q.width },
          height: { ideal: this.q.height, max: this.q.height },
          frameRate: { ideal: this.q.fps, max: this.q.fps },
        },
        // Voice-call processing (echo cancelling, noise suppression, auto volume) ruins music and
        // commentary, so ask for the raw stereo sound.
        audio: this.opts.audio ? {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2, sampleRate: 48000,
        } : false,
        systemAudio: 'include',
      });
      const v = this.stream.getVideoTracks()[0];
      if (!v) throw new Error('No screen was captured');
      if ('contentHint' in v) v.contentHint = this.opts.content === 'detail' ? 'detail' : 'motion';
      v.addEventListener('ended', () => this.stop('Screen sharing was stopped'));
      for (const a of this.stream.getAudioTracks()) if ('contentHint' in a) a.contentHint = 'music';
      await this.connect();
    }

    async connect() {
      if (this.stopped) return;
      this.closePc();
      const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
      this.pc = pc;

      const v = this.stream.getVideoTracks()[0];
      const vt = pc.addTransceiver(v, { direction: 'sendonly', streams: [this.stream] });
      preferCodec(vt, this.opts.codec);
      const audioSenders = this.stream.getAudioTracks()
        .map((a) => pc.addTransceiver(a, { direction: 'sendonly', streams: [this.stream] }).sender);

      pc.addEventListener('iceconnectionstatechange', () => this.onIce(pc));

      this.events.onState('Connecting to the projector...', 'busy');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 2500);
      if (pc !== this.pc) return;

      const answer = await this.api.sendOffer(this.opts.ip, this.opts.code, { type: 'offer', sdp: pc.localDescription.sdp });
      if (pc !== this.pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswer(unhideAddresses(answer.sdp, this.opts.ip), this.q.kbps) });
      await this.tuneSender(vt.sender);
      for (const s of audioSenders) await this.tuneAudio(s);
    }

    async tuneAudio(sender) {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      p.encodings[0].maxBitrate = 256000;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      try { await sender.setParameters(p); } catch (_) { /* keep browser defaults */ }
    }

    async tuneSender(sender) {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = this.q.kbps * 1000;
      p.encodings[0].maxFramerate = this.q.fps;
      // Screen capture ignores size limits on some PCs; scale down here so the chosen quality is what's sent.
      const s = sender.track && sender.track.getSettings ? sender.track.getSettings() : {};
      const scale = s.width && s.height ? Math.max(1, s.width / this.q.width, s.height / this.q.height) : 1;
      p.encodings[0].scaleResolutionDownBy = scale;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      // Never change the picture size mid-stream: on TV chips every size change resets the hardware
      // decoder, which shows as the picture blinking. When Wi-Fi dips, lower quality/fps instead.
      p.degradationPreference = 'maintain-resolution';
      try {
        await sender.setParameters(p);
      } catch (e) {
        delete p.degradationPreference;
        try { await sender.setParameters(p); } catch (_) { /* keep browser defaults */ }
      }
    }

    onIce(pc) {
      if (pc !== this.pc || this.stopped) return;
      const st = pc.iceConnectionState;
      if (st === 'connected' || st === 'completed') {
        this.retries = 0;
        this.events.onState('Casting to ' + (this.opts.name || 'projector'), 'live');
        this.startStats();
      } else if (st === 'disconnected') {
        this.events.onState('Connection weak, holding on...', 'busy');
      } else if (st === 'failed') {
        this.reconnect();
      }
    }

    reconnect() {
      if (this.stopped) return;
      if (this.retries >= 5) return this.stop('Lost the projector. Check both are on the same network.');
      this.retries++;
      this.events.onState(`Reconnecting (${this.retries}/5)...`, 'busy');
      setTimeout(() => this.connect().catch(() => this.reconnect()), 1500);
    }

    startStats() {
      clearInterval(this.statsTimer);
      const prev = {};
      const rate = (key, bytes, ts) => {
        const p = prev[key];
        prev[key] = { bytes, ts };
        return p && ts > p.ts ? (bytes - p.bytes) * 8 / (ts - p.ts) : null; // kbit/s
      };
      this.statsTimer = setInterval(async () => {
        if (!this.pc) return;
        const report = await this.pc.getStats().catch(() => null);
        if (!report) return;
        let video = '';
        let audio = '';
        report.forEach((r) => {
          if (r.type !== 'outbound-rtp') return;
          const kbps = rate(r.kind, r.bytesSent, r.timestamp);
          if (r.kind === 'video') {
            const size = r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '';
            const fps = r.framesPerSecond != null ? `${Math.round(r.framesPerSecond)} fps` : '';
            const mbps = kbps != null ? (kbps / 1000).toFixed(1) + ' Mbps' : '';
            let limit = '';
            if (r.qualityLimitationReason === 'bandwidth') limit = ' · Wi-Fi is limiting quality';
            else if (r.qualityLimitationReason === 'cpu') limit = ' · PC is busy, lowering quality';
            video = [size, fps, mbps].filter(Boolean).join(' · ') + limit;
          } else if (r.kind === 'audio' && kbps != null) {
            const t = this.stream && this.stream.getAudioTracks()[0];
            const ch = t && t.getSettings ? t.getSettings().channelCount : null;
            audio = `Sound ${Math.round(kbps)} kbps${ch === 1 ? ' mono' : ch === 2 ? ' stereo' : ''}`;
          }
        });
        this.events.onStats([video, audio].filter(Boolean).join('\n'));
      }, 1000);
    }

    closePc() {
      clearInterval(this.statsTimer);
      if (this.pc) {
        const pc = this.pc;
        this.pc = null;
        try { pc.close(); } catch (_) { /* already closed */ }
      }
    }

    stop(reason) {
      if (this.stopped) return;
      this.stopped = true;
      this.closePc();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.api.sendStop(this.opts.ip, this.opts.code);
      this.events.onEnded(reason || 'Stopped');
    }
  }

  global.CastCore = { QUALITY, tuneAnswer, unhideAddresses, CastSession };
})(typeof window !== 'undefined' ? window : globalThis);
