package com.projectorcast.receiver;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Handler;
import android.os.Looper;

import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RTCStats;
import org.webrtc.RTCStatsCollectorCallback;
import org.webrtc.RTCStatsReport;
import org.webrtc.RendererCommon;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SoftwareVideoDecoderFactory;
import org.webrtc.VideoDecoderFactory;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSink;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Receives the cast with the native WebRTC library and renders to a SurfaceView, bypassing the
 * WebView video path (which flickers on some TV chips). Audio is played with media attributes.
 */
class NativePlayer {

    interface Listener {
        void onFirstFrame();

        void onConnectionWeak();

        void onConnected();

        void onEnded(String reason);
    }

    private static boolean loaded;
    private static boolean loadTried;

    /** Loads the native library once; false if this projector's CPU type is not supported. */
    static synchronized boolean load(Context ctx) {
        if (!loadTried) {
            loadTried = true;
            try {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx.getApplicationContext())
                        .createInitializationOptions());
                loaded = true;
            } catch (Throwable t) {
                loaded = false;
            }
        }
        return loaded;
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final SurfaceViewRenderer view;
    private final Listener listener;
    private final Context ctx;
    private final EglBase egl;
    final PictureDrawer picture = new PictureDrawer();
    private volatile DataChannel control;
    private PeerConnectionFactory factory;
    private JavaAudioDeviceModule adm;
    private int strategy;

    /**
     * Decoder setups, tried in order. Some TV hardware decoders stall after the first frame when
     * rendering to a texture; MainActivity moves to the next setup when that happens.
     */
    static final String[] STRATEGIES = {"hardware", "hardware (buffered)", "software"};
    private PeerConnection pc;
    private VideoTrack videoTrack;
    private FrameGate gate;
    private Runnable dropTimer;
    private volatile int videoDelayMs;
    private final android.os.HandlerThread delayThread = new android.os.HandlerThread("video-delay");
    private final Handler delayed;

    // Stats bookkeeping
    private int connectionDrops;
    private int sizeChanges;
    private String lastSize = "";

    NativePlayer(Context ctx, SurfaceViewRenderer view, Listener listener, int strategy) {
        this.ctx = ctx;
        this.view = view;
        this.listener = listener;
        delayThread.start();
        delayed = new Handler(delayThread.getLooper());
        egl = EglBase.create();
        view.init(egl.getEglBaseContext(), null, EglBase.CONFIG_PLAIN, picture);
        view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        view.setEnableHardwareScaler(false);
        view.setMirror(false);
        buildFactory(strategy);
    }

    int strategy() { return strategy; }

    /** Shows the picture this much later, to match sound that plays late (Bluetooth speakers). */
    void setVideoDelay(int ms) { videoDelayMs = Math.max(0, ms); }

    /** UI thread. Ends the session and rebuilds the factory; the PC reconnects automatically. */
    void setStrategy(int s) {
        closeSession();
        if (s != strategy || factory == null) buildFactory(s);
    }

    private void buildFactory(int s) {
        strategy = ((s % STRATEGIES.length) + STRATEGIES.length) % STRATEGIES.length;
        if (factory != null) factory.dispose();
        if (adm != null) adm.release();
        adm = JavaAudioDeviceModule.builder(ctx)
                .setUseStereoOutput(true)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build())
                .createAudioDeviceModule();
        VideoDecoderFactory decoders;
        if (strategy == 0) decoders = new DefaultVideoDecoderFactory(egl.getEglBaseContext());
        else if (strategy == 1) decoders = new DefaultVideoDecoderFactory(null); // hardware decoder, frames copied to memory
        else decoders = new SoftwareVideoDecoderFactory(); // if it has no H.264, VP8 gets negotiated instead
        factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoDecoderFactory(decoders)
                .createPeerConnectionFactory();
    }

    /** Server thread. Starts a session for the offer and returns the answer SDP. */
    String answer(String offerSdp, String senderIp) throws Exception {
        final CountDownLatch closed = new CountDownLatch(1);
        ui.post(new Runnable() {
            public void run() {
                closeSession();
                closed.countDown();
            }
        });
        closed.await(3, TimeUnit.SECONDS);

        PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(new ArrayList<PeerConnection.IceServer>());
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        cfg.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        cfg.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;
        cfg.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED;

        final CountDownLatch gathered = new CountDownLatch(1);
        final PeerConnection conn = factory.createPeerConnection(cfg, new Observer(gathered));
        if (conn == null) throw new Exception("could not create the native player");
        synchronized (this) {
            pc = conn;
        }
        connectionDrops = 0;
        sizeChanges = 0;
        lastReceived = -1;
        lastRendered = -1;
        stuckSeconds = 0;
        lastSize = "";
        synchronized (prevs) {
            prevs.clear();
        }

        Result r = new Result();
        conn.setRemoteDescription(r, new SessionDescription(SessionDescription.Type.OFFER, SdpTools.unhideAddresses(offerSdp, senderIp)));
        r.await("set offer");

        Result a = new Result();
        conn.createAnswer(a, new MediaConstraints());
        SessionDescription ans = a.await("create answer");

        Result l = new Result();
        conn.setLocalDescription(l, new SessionDescription(SessionDescription.Type.ANSWER, SdpTools.wantStereo(ans.description)));
        l.await("set answer");

        gathered.await(3, TimeUnit.SECONDS);
        SessionDescription local = conn.getLocalDescription();
        if (local == null) throw new Exception("no answer");
        return local.description;
    }

    /** UI thread. */
    void closeSession() {
        if (dropTimer != null) ui.removeCallbacks(dropTimer);
        dropTimer = null;
        PeerConnection old;
        synchronized (this) {
            old = pc;
            pc = null;
        }
        if (videoTrack != null && gate != null) {
            try { videoTrack.removeSink(gate); } catch (Throwable ignored) { }
        }
        if (gate != null) gate.close();
        videoTrack = null;
        gate = null;
        control = null; // disposed with the connection
        if (old != null) old.dispose();
        view.clearImage();
    }

    void release() {
        closeSession();
        view.release();
        delayThread.quit();
        if (factory != null) factory.dispose();
        if (adm != null) adm.release();
        egl.release();
    }

    // ---- Freeze detection ----

    interface Health {
        void result(boolean frozen, boolean neverShown);
    }

    private long lastReceived = -1;
    private long lastRendered = -1;
    private int stuckSeconds;

    /**
     * Call once a second. Reports a freeze when frames keep arriving for 3 s while none are rendered
     * (a static source sends almost no frames, so it is not reported).
     */
    void checkHealth(final Health out) {
        final PeerConnection conn;
        synchronized (this) {
            conn = pc;
        }
        final FrameGate g = gate;
        if (conn == null) return;
        conn.getStats(new RTCStatsCollectorCallback() {
            public void onStatsDelivered(RTCStatsReport report) {
                long received = -1;
                for (RTCStats st : report.getStatsMap().values()) {
                    Map<String, Object> m = st.getMembers();
                    if (!"inbound-rtp".equals(st.getType()) || !"video".equals(m.get("kind"))) continue;
                    // Frames the decoder stalls on show up as "dropped", not "received": count both.
                    Object fr = m.get("framesReceived");
                    Object dropped = m.get("framesDropped");
                    if (!(fr instanceof Number)) fr = m.get("packetsReceived");
                    if (fr instanceof Number) received = ((Number) fr).longValue()
                            + (dropped instanceof Number ? ((Number) dropped).longValue() : 0);
                }
                long rendered = g != null ? g.count : 0;
                boolean stuckNow = lastReceived >= 0 && received - lastReceived >= 3 && rendered == lastRendered;
                stuckSeconds = stuckNow ? stuckSeconds + 1 : 0;
                lastReceived = received;
                lastRendered = rendered;
                final boolean frozen = stuckSeconds >= 3;
                final boolean never = frozen && rendered == 0;
                ui.post(new Runnable() {
                    public void run() { out.result(frozen, never); }
                });
            }
        });
    }

    /** True once this session's first video frame reached the screen. */
    boolean hasPicture() {
        FrameGate g = gate;
        return g != null && g.seen;
    }

    /**
     * Forwards frames to the renderer, after the lip-sync delay if one is set, and reports the first
     * frame of each session (the renderer's own first-frame event fires only once per renderer).
     */
    private class FrameGate implements VideoSink {
        volatile boolean seen;
        volatile long count;
        private final java.util.ArrayDeque<VideoFrame> held = new java.util.ArrayDeque<VideoFrame>();
        private boolean closed;

        private final Runnable showNext = new Runnable() {
            public void run() {
                VideoFrame f;
                synchronized (held) {
                    f = held.poll();
                }
                if (f == null) return;
                show(f);
                f.release();
            }
        };

        public void onFrame(VideoFrame frame) {
            int delay = videoDelayMs;
            synchronized (held) {
                if (closed) return;
                if (delay == 0 && held.isEmpty()) {
                    show(frame);
                    return;
                }
                VideoFrame copy = hold(frame);
                if (copy == null) return;
                held.add(copy);
            }
            delayed.postDelayed(showNext, delay);
        }

        /**
         * Keeps a frame for later. Hardware-decoder frames live in the decoder's single output texture,
         * which must be returned straight away, so those are copied to memory first.
         */
        private VideoFrame hold(VideoFrame frame) {
            VideoFrame.Buffer b = frame.getBuffer();
            if (b instanceof VideoFrame.TextureBuffer) {
                VideoFrame.I420Buffer copy = b.toI420();
                return copy == null ? null : new VideoFrame(copy, frame.getRotation(), frame.getTimestampNs());
            }
            frame.retain();
            return frame;
        }

        void close() {
            synchronized (held) {
                closed = true;
                for (VideoFrame f : held) f.release();
                held.clear();
            }
        }

        private void show(VideoFrame frame) {
            view.onFrame(frame);
            count++;
            if (!seen) {
                seen = true;
                ui.post(new Runnable() {
                    public void run() {
                        if (gate == FrameGate.this) listener.onFirstFrame();
                    }
                });
            }
        }
    }

    /** Sends a remote key to the PC; false if this connection has no control channel (older PC app). */
    boolean sendControl(String key) {
        DataChannel ch = control;
        if (ch == null || ch.state() != DataChannel.State.OPEN) return false;
        byte[] msg = ("{\"key\":" + CastServer.quote(key) + "}").getBytes(java.nio.charset.Charset.forName("UTF-8"));
        return ch.send(new DataChannel.Buffer(java.nio.ByteBuffer.wrap(msg), false));
    }

    boolean active() {
        synchronized (this) {
            return pc != null;
        }
    }

    // ---- Stats (shown with the OK button) ----

    interface StatsText {
        void show(String text);
    }

    /** {@code who} keeps rate calculations separate for each caller. */
    void readStats(final String who, final StatsText out) {
        PeerConnection conn;
        synchronized (this) {
            conn = pc;
        }
        if (conn == null) return;
        conn.getStats(new RTCStatsCollectorCallback() {
            public void onStatsDelivered(RTCStatsReport report) {
                final String text;
                synchronized (prevs) {
                    Map<String, double[]> p = prevs.get(who);
                    if (p == null) prevs.put(who, p = new java.util.HashMap<String, double[]>());
                    text = formatStats(report, p);
                }
                ui.post(new Runnable() {
                    public void run() { out.show(text); }
                });
            }
        });
    }

    private final Map<String, Map<String, double[]>> prevs = new java.util.HashMap<String, Map<String, double[]>>();

    private static double perSec(Map<String, double[]> prev, String key, Object value, double ts) {
        if (!(value instanceof Number)) return Double.NaN;
        double v = ((Number) value).doubleValue();
        double[] p = prev.put(key, new double[]{v, ts});
        return p != null && ts > p[1] ? (v - p[0]) * 1000000.0 / (ts - p[1]) : Double.NaN; // ts in microseconds
    }

    private static String num(Object o) {
        return o instanceof Number ? String.valueOf(((Number) o).longValue()) : "?";
    }

    private static String fmt(double v, int digits) {
        return Double.isNaN(v) ? "?" : String.format(Locale.US, "%." + digits + "f", v);
    }

    private String formatStats(RTCStatsReport report, Map<String, double[]> prev) {
        StringBuilder b = new StringBuilder();
        Map<String, RTCStats> all = report.getStatsMap();
        for (RTCStats s : all.values()) {
            if (!"inbound-rtp".equals(s.getType())) continue;
            Map<String, Object> m = s.getMembers();
            double ts = s.getTimestampUs();
            Object codecId = m.get("codecId");
            RTCStats codec = codecId != null ? all.get(String.valueOf(codecId)) : null;
            String codecName = codec != null ? String.valueOf(codec.getMembers().get("mimeType")) : "?";
            if ("video".equals(m.get("kind"))) {
                String size = num(m.get("frameWidth")) + "x" + num(m.get("frameHeight"));
                if (lastSize.length() > 0 && !size.equals(lastSize)) sizeChanges++;
                lastSize = size;
                double fps = perSec(prev, "vframes", m.get("framesDecoded"), ts);
                Object bytes = m.get("bytesReceived");
                double mbps = perSec(prev, "vbytes", bytes instanceof Number ? ((Number) bytes).doubleValue() * 8 / 1e6 : null, ts);
                b.append("Player    native, decoder: ").append(STRATEGIES[strategy]).append("\n");
                b.append("Picture   ").append(size).append("  ").append(fmt(fps, 0)).append(" fps  ").append(fmt(mbps, 1)).append(" Mbps\n");
                Object impl = m.get("decoderImplementation");
                b.append("Decoder   ").append(codecName.replace("video/", "")).append(impl != null ? "  " + impl : "").append('\n');
                FrameGate g = gate;
                Object recv = m.get("framesReceived");
                Object drop = m.get("framesDropped");
                double arriving = perSec(prev, "vrecv", recv instanceof Number
                        ? (Object) Double.valueOf(((Number) recv).doubleValue() + (drop instanceof Number ? ((Number) drop).doubleValue() : 0))
                        : null, ts);
                double shown = perSec(prev, "vshown", g != null ? (Object) Long.valueOf(g.count) : null, ts);
                b.append("Frames/s  arriving ").append(fmt(arriving, 0)).append("  decoded ").append(fmt(fps, 0))
                        .append("  shown ").append(fmt(shown, 0)).append('\n');
                b.append("Keyframes ").append(num(m.get("keyFramesDecoded"))).append("   picture requests ").append(num(m.get("pliCount")))
                        .append("   resends ").append(num(m.get("nackCount"))).append("   freeze time ")
                        .append(m.get("totalFreezesDuration") instanceof Number ? fmt(((Number) m.get("totalFreezesDuration")).doubleValue(), 1) + " s" : "?")
                        .append('\n');
                b.append("Dropped   ").append(num(m.get("framesDropped"))).append(" frames   freezes ").append(num(m.get("freezeCount")))
                        .append("   lost packets ").append(num(m.get("packetsLost"))).append('\n');
                b.append("Size changes ").append(sizeChanges).append("   connection drops ").append(connectionDrops).append('\n');
            } else if ("audio".equals(m.get("kind"))) {
                Object bytes = m.get("bytesReceived");
                double kbps = perSec(prev, "abytes", bytes instanceof Number ? ((Number) bytes).doubleValue() * 8 / 1000 : null, ts);
                double conceal = perSec(prev, "aconc", m.get("concealedSamples"), ts);
                double total = perSec(prev, "atotal", m.get("totalSamplesReceived"), ts);
                Object ch = codec != null ? codec.getMembers().get("channels") : null;
                b.append("Sound     ").append(fmt(kbps, 0)).append(" kbps  ")
                        .append(ch instanceof Number && ((Number) ch).intValue() == 2 ? "stereo" : "?")
                        .append("   gaps ").append(total > 0 ? fmt(100 * conceal / total, 1) : "?").append("%")
                        .append("   lost packets ").append(num(m.get("packetsLost"))).append('\n');
            }
        }
        return b.toString().trim();
    }

    // ---- WebRTC plumbing ----

    private class Observer implements PeerConnection.Observer {
        private final CountDownLatch gathered;

        Observer(CountDownLatch gathered) { this.gathered = gathered; }

        private boolean current() {
            synchronized (NativePlayer.this) {
                return pc != null;
            }
        }

        public void onTrack(RtpTransceiver transceiver) {
            attach(transceiver.getReceiver().track());
        }

        public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {
            attach(receiver.track());
        }

        private void attach(final MediaStreamTrack track) {
            if (!(track instanceof VideoTrack)) return; // audio plays by itself
            ui.post(new Runnable() {
                public void run() {
                    if (videoTrack == track) return;
                    if (videoTrack != null && gate != null) videoTrack.removeSink(gate);
                    if (gate != null) gate.close();
                    videoTrack = (VideoTrack) track;
                    gate = new FrameGate();
                    videoTrack.addSink(gate);
                }
            });
        }

        public void onIceConnectionChange(final PeerConnection.IceConnectionState state) {
            ui.post(new Runnable() {
                public void run() {
                    if (!current()) return;
                    switch (state) {
                        case CONNECTED:
                        case COMPLETED:
                            if (dropTimer != null) ui.removeCallbacks(dropTimer);
                            dropTimer = null;
                            listener.onConnected();
                            break;
                        case DISCONNECTED:
                            connectionDrops++;
                            listener.onConnectionWeak();
                            if (dropTimer != null) ui.removeCallbacks(dropTimer);
                            dropTimer = new Runnable() {
                                public void run() {
                                    closeSession();
                                    listener.onEnded("Connection lost. Start casting again on the PC.");
                                }
                            };
                            ui.postDelayed(dropTimer, 8000);
                            break;
                        case FAILED:
                            closeSession();
                            listener.onEnded("Connection lost. Start casting again on the PC.");
                            break;
                        default:
                            break;
                    }
                }
            });
        }

        public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.countDown();
        }

        public void onSignalingChange(PeerConnection.SignalingState s) { }
        public void onIceConnectionReceivingChange(boolean b) { }
        public void onIceCandidate(IceCandidate c) { }
        public void onIceCandidatesRemoved(IceCandidate[] c) { }
        public void onAddStream(MediaStream s) { }
        public void onRemoveStream(MediaStream s) { }
        public void onDataChannel(DataChannel d) {
            if ("control".equals(d.label()) && current()) control = d;
        }
        public void onRenegotiationNeeded() { }
    }

    /** SdpObserver that can be waited on from a background thread. */
    private static class Result implements SdpObserver {
        private final CountDownLatch done = new CountDownLatch(1);
        private SessionDescription sdp;
        private String error;

        public void onCreateSuccess(SessionDescription d) { sdp = d; done.countDown(); }
        public void onSetSuccess() { done.countDown(); }
        public void onCreateFailure(String e) { error = e; done.countDown(); }
        public void onSetFailure(String e) { error = e; done.countDown(); }

        SessionDescription await(String step) throws Exception {
            if (!done.await(10, TimeUnit.SECONDS)) throw new Exception(step + ": timed out");
            if (error != null) throw new Exception(step + ": " + error);
            return sdp;
        }
    }
}
