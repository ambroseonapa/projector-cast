package com.projectorcast.receiver;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.os.SystemClock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Estimates how late sound comes out of the current output by playing a second of silence and
 * comparing the frames written with the frames Android reports as played. For Bluetooth this
 * includes the speaker's own delay when the speaker reports it (most do; otherwise Android uses a
 * typical value).
 */
final class OutputLatency {

    private OutputLatency() { }

    /** Blocking, about 1.5 s. Returns the delay in ms, or -1 if it could not be measured. */
    static int measure() {
        final int rate = 48000;
        int min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) return -1;
        AudioTrack track;
        try {
            track = new AudioTrack(
                    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build(),
                    new AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build(),
                    min, AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE);
        } catch (Exception e) {
            return -1;
        }
        List<Double> samples = new ArrayList<Double>();
        try {
            if (track.getState() != AudioTrack.STATE_INITIALIZED) return -1;
            track.play();
            short[] silence = new short[rate / 100 * 2]; // 10 ms, stereo
            long written = 0;
            AudioTimestamp ts = new AudioTimestamp();
            long end = SystemClock.uptimeMillis() + 1500;
            while (SystemClock.uptimeMillis() < end) {
                int n = track.write(silence, 0, silence.length);
                if (n < 0) return -1;
                written += n / 2;
                // Skip the start-up: timestamps settle after a few hundred ms.
                if (SystemClock.uptimeMillis() > end - 900 && track.getTimestamp(ts) && ts.framePosition > 0) {
                    double queued = (written - ts.framePosition) * 1000.0 / rate;
                    double since = (System.nanoTime() - ts.nanoTime) / 1e6;
                    samples.add(queued - since);
                }
            }
        } catch (Exception e) {
            return -1;
        } finally {
            try { track.stop(); } catch (Exception ignored) { }
            track.release();
        }
        if (samples.size() < 5) return -1;
        Collections.sort(samples);
        double median = samples.get(samples.size() / 2);
        return median > 0 && median < 2000 ? (int) Math.round(median) : -1;
    }
}
