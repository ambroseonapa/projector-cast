'use strict';

/*
 * Plays 48 kHz stereo 16-bit PCM received from the app-sound helper. Keeps about 40-250 ms
 * buffered: enough to ride out uneven delivery, little enough to stay in step with the picture.
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(48000 * 2); // 1 s, interleaved
    this.read = 0;
    this.size = 0;
    this.playing = false;
    this.port.onmessage = (e) => this.push(e.data);
  }

  push(bytes) {
    const u8 = new Uint8Array(bytes);
    const pcm = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + (u8.byteLength & ~1)));
    const cap = this.ring.length;
    for (let i = 0; i < pcm.length; i++) {
      this.ring[(this.read + this.size) % cap] = pcm[i] / 32768;
      if (this.size < cap) this.size++;
      else this.read = (this.read + 1) % cap; // full: drop the oldest
    }
    // Fallen behind (e.g. after a pause): skip ahead to keep the delay short.
    const max = 48000 * 2 * 0.25;
    if (this.size > max) {
      const skip = (this.size - 48000 * 2 * 0.06) & ~1;
      this.read = (this.read + skip) % cap;
      this.size -= skip;
    }
  }

  process(inputs, outputs) {
    const [left, right] = outputs[0];
    const frames = left.length;
    if (!this.playing && this.size >= 48000 * 2 * 0.04) this.playing = true;
    if (!this.playing || this.size < frames * 2) {
      this.playing = false; // ran dry: wait for a little buffer again
      return true; // outputs are already silent
    }
    const cap = this.ring.length;
    for (let i = 0; i < frames; i++) {
      left[i] = this.ring[this.read];
      right[i] = this.ring[(this.read + 1) % cap];
      this.read = (this.read + 2) % cap;
    }
    this.size -= frames * 2;
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
