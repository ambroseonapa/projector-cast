'use strict';

/*
 * Sender side of the WebRTC session. Network access goes through the `api` object, so this file
 * has no Electron dependency and also runs in a plain browser (used by the tests).
 */
(function (global) {
  const QUALITY = {
    p540_30: { label: '540p, 30 fps (low-power projectors)', width: 960, height: 540, fps: 30, kbps: 3500 },
    p720_60: { label: '720p, 60 fps', width: 1280, height: 720, fps: 60, kbps: 6000 },
    p720_30: { label: '720p, 30 fps', width: 1280, height: 720, fps: 30, kbps: 5000 },
    p1080_60: { label: '1080p, 60 fps', width: 1920, height: 1080, fps: 60, kbps: 12000 },
    p1080_30: { label: '1080p, 30 fps', width: 1920, height: 1080, fps: 30, kbps: 8000 },
    p4k_30: { label: '4K, 30 fps', width: 3840, height: 2160, fps: 30, kbps: 25000 },
  };

  /** Raises the bitrate limits in the projector's answer and enables stereo Opus. */
  function tuneAnswer(sdp, kbps) {
    const lines = sdp.split(/\r\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const out = [];
    let kind = null;
    let codecs = {};
    let fmtpSeen = {};

    const flushMissingFmtp = () => {
      if (kind !== 'video') return;
      for (const pt of Object.keys(codecs)) {
        if (!fmtpSeen[pt] && /^(VP8|VP9|H264|AV1)$/i.test(codecs[pt])) out.push(`a=fmtp:${pt} ${bitrateHints(kbps)}`);
      }
    };

    // Codec name per payload type, per media section.
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

  /** Replaces mDNS (.local) ICE candidates with the projector's IP address. */
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

  /** Puts the wanted codec first; baseline H.264 before other profiles. */
  function orderCodecs(codecs, codec) {
    const want = codec === 'vp8' ? /vp8/i : /h264/i;
    const baseline = (c) => (/42e01f|42001f/.test(c.sdpFmtpLine || '') ? 1 : 0);
    const first = codecs.filter((c) => want.test(c.mimeType)).sort((a, b) => baseline(b) - baseline(a));
    return first.length ? first.concat(codecs.filter((c) => !want.test(c.mimeType))) : null;
  }

  /**
   * Best effort. Chrome rejects codecs it cannot also receive, and some GPU encoders advertise H.264
   * profiles outside that set, so only codecs present in both lists are offered.
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
   * One casting session: captures once and (re)connects to the projector as needed.
   * events: onState(text, kind), onStats(text), onStream(stream), onQuality(key), onRemoteKey(key), onEnded(reason)
   */
  class CastSession {
    constructor(api, opts, events) {
      this.api = api;
      this.opts = opts;
      this.events = events;
      this.q = QUALITY[opts.quality] || QUALITY.p720_60;
      this.stream = null;
      this.pc = null;
      this.stopped = false;
      this.retries = 0;
      this.weakTimer = null;
      this.statsTimer = null;
    }

    videoConstraints() {
      return {
        width: { ideal: this.q.width, max: this.q.width },
        height: { ideal: this.q.height, max: this.q.height },
        frameRate: { ideal: this.q.fps, max: this.q.fps },
      };
    }

    setContentHint(track) {
      if ('contentHint' in track) track.contentHint = this.opts.content === 'detail' ? 'detail' : 'motion';
    }

    async start(stream) {
      this.stream = stream || await navigator.mediaDevices.getDisplayMedia({
        video: this.videoConstraints(),
        // Raw stereo: voice processing would degrade music and commentary.
        audio: this.opts.audio ? {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 2, sampleRate: 48000,
        } : false,
        systemAudio: 'include',
      });
      const v = this.stream.getVideoTracks()[0];
      if (!v) throw new Error('Nothing was captured.');
      if (this.events.onStream) this.events.onStream(this.stream);
      this.setContentHint(v);
      this.watchEnd(v);
      for (const a of this.stream.getAudioTracks()) if ('contentHint' in a) a.contentHint = 'music';
      await this.connect();
    }

    watchEnd(track) {
      track.addEventListener('ended', () => {
        // Ignore tracks already replaced by switchSource().
        if (this.stream && this.stream.getVideoTracks()[0] === track) this.stop('Capture stopped.');
      });
    }

    /** Switches to another screen or window without reconnecting; sound continues. */
    async switchSource() {
      if (this.stopped) return;
      const fresh = await navigator.mediaDevices.getDisplayMedia({ video: this.videoConstraints(), audio: false });
      const nv = fresh.getVideoTracks()[0];
      if (!nv) throw new Error('Nothing was captured.');
      this.setContentHint(nv);
      const old = this.stream.getVideoTracks()[0];
      this.stream.removeTrack(old);
      this.stream.addTrack(nv);
      this.watchEnd(nv);
      old.stop();
      const sender = this.pc && this.pc.getSenders().find((x) => x.track === old || (x.track && x.track.kind === 'video'));
      if (sender) {
        await sender.replaceTrack(nv);
        await this.tuneSender(sender);
      }
      if (this.events.onStream) this.events.onStream(this.stream);
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

      // Remote-control keys pressed on the projector (play/pause, skip...).
      const control = pc.createDataChannel('control');
      control.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && typeof msg.key === 'string' && this.events.onRemoteKey && pc === this.pc) this.events.onRemoteKey(msg.key);
      };

      pc.addEventListener('iceconnectionstatechange', () => this.onIce(pc));

      this.events.onState('Connecting…', 'busy');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc, 2500);
      if (pc !== this.pc) return;

      const answer = await this.api.sendOffer(this.opts.ip, this.opts.code,
        { type: 'offer', sdp: pc.localDescription.sdp, buffer: this.opts.buffer == null ? 150 : this.opts.buffer });
      if (pc !== this.pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswer(unhideAddresses(answer.sdp, this.opts.ip), this.q.kbps) });
      // The projector closes DTLS when it drops the session (e.g. display-mode switch): reconnect at once.
      const dtls = vt.sender.transport;
      if (dtls) {
        dtls.addEventListener('statechange', () => {
          if (pc === this.pc && (dtls.state === 'closed' || dtls.state === 'failed')) this.reconnect();
        });
      }
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
      p.encodings[0].maxFramerate = Math.min(this.q.fps, this.fpsCap || this.q.fps);
      // Capture may ignore the size constraints; scale in the encoder instead.
      const s = sender.track && sender.track.getSettings ? sender.track.getSettings() : {};
      const scale = s.width && s.height ? Math.max(1, s.width / this.q.width, s.height / this.q.height) : 1;
      p.encodings[0].scaleResolutionDownBy = scale;
      p.encodings[0].priority = 'high';
      p.encodings[0].networkPriority = 'high';
      // Resolution changes reset TV hardware decoders (visible as blinking); trade quality/fps instead.
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
      clearTimeout(this.weakTimer);
      if (st === 'connected' || st === 'completed') {
        this.retries = 0;
        this.events.onState('Casting to ' + (this.opts.name || 'projector'), 'live');
        this.startStats();
      } else if (st === 'disconnected') {
        this.events.onState('Weak connection…', 'busy');
        // Reconnect after 3 s rather than waiting ~30 s for ICE to fail.
        this.weakTimer = setTimeout(() => {
          if (pc === this.pc && pc.iceConnectionState === 'disconnected') this.reconnect();
        }, 3000);
      } else if (st === 'failed') {
        this.reconnect();
      }
    }

    reconnect() {
      if (this.stopped || this.reconnecting) return;
      if (this.retries >= 8) return this.stop('Connection to the projector lost.');
      this.retries++;
      this.reconnecting = true;
      this.events.onState(`Reconnecting (${this.retries}/8)…`, 'busy');
      setTimeout(() => {
        this.reconnecting = false;
        this.connect().catch(() => this.reconnect());
      }, 1500);
    }

    /**
     * Called every 2 s with the projector's decoded frame rate, and the rate frames reach it when the
     * native player reports that. Frames arriving faster than the projector decodes them queue up and
     * the picture lags behind the sound, so the send rate is capped just below the decode rate. The cap
     * is raised again after 10 s of keeping up (longer if a raise fails).
     */
    async adaptToProjector(decodedFps, arrivingFps) {
      if (this.stopped || !this.pc || !(decodedFps >= 0) || this.lastSentFps == null) return;
      const arriving = arrivingFps >= 0 ? arrivingFps : null;
      this.samples = (this.samples || []).concat({ decoded: decodedFps, sent: this.lastSentFps, arriving }).slice(-3);
      if (this.samples.length < 3) return;
      const decoded = this.samples.reduce((a, x) => a + x.decoded, 0) / 3;
      const sent = this.samples.reduce((a, x) => a + x.sent, 0) / 3;
      // Compare with what reached the projector: the PC's own count is taken over a different
      // 2 s window and differs a lot when the picture keeps changing between moving and still.
      const reached = this.samples.every((x) => x.arriving != null)
        ? this.samples.reduce((a, x) => a + x.arriving, 0) / 3 : sent;
      const cap = this.fpsCap || this.q.fps;
      // A still or paused source sends few frames; that says nothing about the projector. (Compare
      // with the cap too: once capped low, the PC never sends more than the cap.)
      if (sent < Math.min(12, cap * 0.85)) {
        this.keptUpSince = 0;
        return;
      }
      this.raiseWait = this.raiseWait || 10000;
      let next = cap;
      if (decoded < reached * 0.88) {
        next = Math.max(10, Math.floor(decoded * 0.9));
        // The last raise overshot: wait longer before the next one.
        if (this.raisedAt && Date.now() - this.raisedAt < 15000) this.raiseWait = Math.min(this.raiseWait * 2, 120000);
        this.keptUpSince = 0;
      } else if (this.fpsCap && sent >= cap * 0.85) {
        this.keptUpSince = this.keptUpSince || Date.now();
        if (Date.now() - this.keptUpSince > this.raiseWait) {
          next = Math.min(this.q.fps, cap + 5);
          this.raisedAt = Date.now();
          this.keptUpSince = 0;
        }
      }
      if (next === cap) return;
      this.fpsCap = next >= this.q.fps ? 0 : next;
      this.samples = [];
      // Under 24 fps, step down to 540p once: it decodes faster.
      if (this.fpsCap && this.fpsCap < 24 && this.q.width > 960 && !this.autoReduced) {
        this.autoReduced = true;
        await this.setQuality('p540_30');
        if (this.events.onQuality) this.events.onQuality('p540_30');
        return;
      }
      const sender = this.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender) await this.tuneSender(sender);
    }

    /** Changes size and frame rate in place, without reconnecting. */
    async setQuality(key) {
      this.q = QUALITY[key] || this.q;
      this.opts.quality = key;
      this.fpsCap = 0;
      this.samples = [];
      try { await this.stream.getVideoTracks()[0].applyConstraints(this.videoConstraints()); } catch (_) { /* encoder scales */ }
      const sender = this.pc && this.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender) await this.tuneSender(sender);
    }

    /** Applies quality, content and buffer settings. Only a buffer change needs a reconnect. */
    async update(changes) {
      if (this.stopped) return;
      const reconnect = changes.buffer != null && changes.buffer !== (this.opts.buffer == null ? 150 : this.opts.buffer);
      if (!reconnect) {
        if (changes.content) {
          this.opts.content = changes.content;
          this.setContentHint(this.stream.getVideoTracks()[0]);
        }
        if (changes.quality) await this.setQuality(changes.quality);
        return;
      }
      Object.assign(this.opts, changes);
      this.q = QUALITY[this.opts.quality] || this.q;
      this.fpsCap = 0;
      this.samples = [];
      const v = this.stream.getVideoTracks()[0];
      this.setContentHint(v);
      try { await v.applyConstraints(this.videoConstraints()); } catch (_) { /* encoder scales */ }
      this.retries = 0;
      await this.connect();
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
            if (r.framesPerSecond != null) this.lastSentFps = r.framesPerSecond;
            const size = r.frameWidth ? `${r.frameWidth}×${r.frameHeight}` : '';
            const fps = r.framesPerSecond != null ? `${Math.round(r.framesPerSecond)} fps` : '';
            const mbps = kbps != null ? (kbps / 1000).toFixed(1) + ' Mbps' : '';
            let limit = '';
            if (r.qualityLimitationReason === 'bandwidth') limit = ' · limited by network';
            else if (r.qualityLimitationReason === 'cpu') limit = ' · limited by CPU';
            video = [size, fps, mbps].filter(Boolean).join(' · ') + limit
              + (this.fpsCap ? ` · capped at ${this.fpsCap} fps` : '');
          } else if (r.kind === 'audio' && kbps != null) {
            const t = this.stream && this.stream.getAudioTracks()[0];
            const ch = t && t.getSettings ? t.getSettings().channelCount : null;
            audio = `Audio ${Math.round(kbps)} kbps${ch === 1 ? ' mono' : ch === 2 ? ' stereo' : ''}`;
          }
        });
        this.events.onStats([video, audio].filter(Boolean).join('\n'));
      }, 1000);
    }

    closePc() {
      clearInterval(this.statsTimer);
      clearTimeout(this.weakTimer);
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
