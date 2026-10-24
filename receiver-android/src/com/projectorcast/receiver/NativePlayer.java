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
 * Plays the cast with the native WebRTC library instead of the WebView: frames go from the
 * projector's hardware decoder straight to a SurfaceView, which avoids the WebView video
 * flicker some TV chips have, and sound plays as media (not as a voice call).
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
    private final EglBase egl;
    private final PeerConnectionFactory factory;
    private PeerConnection pc;
    private VideoTrack videoTrack;
    private FrameGate gate;
    private Runnable dropTimer;

    // Stats bookkeeping
    private final Map<String, double[]> prev = new java.util.HashMap<String, double[]>();
    private int connectionDrops;
    private int sizeChanges;
    private String lastSize = "";

    NativePlayer(Context ctx, SurfaceViewRenderer view, Listener listener) {
        this.view = view;
        this.listener = listener;
        egl = EglBase.create();
        view.init(egl.getEglBaseContext(), null);
        view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        view.setEnableHardwareScaler(false);
        view.setMirror(false);

        JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(ctx)
                .setUseStereoOutput(true)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build())
                .createAudioDeviceModule();
        factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
                .createPeerConnectionFactory();
    }

    /** Called on a server thread: sets up a new session for this offer and returns the answer SDP. */
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
        lastSize = "";
        prev.clear();

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
        videoTrack = null;
        gate = null;
        if (old != null) old.dispose();
        view.clearImage();
    }

    void release() {
        closeSession();
        view.release();
        factory.dispose();
        egl.release();
    }

    /** True once this session's first video frame reached the screen. */
    boolean hasPicture() {
        FrameGate g = gate;
        return g != null && g.seen;
    }

    /**
     * Passes frames to the screen and reports the first frame of every session. (The renderer's own
     * first-frame event fires only once per app start, which left the code screen covering the
     * picture from the second cast on.)
     */
    private class FrameGate implements VideoSink {
        volatile boolean seen;

        public void onFrame(VideoFrame frame) {
            view.onFrame(frame);
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

    boolean active() {
        synchronized (this) {
            return pc != null;
        }
    }

    // ---- Stats (shown with the OK button) ----

    interface StatsText {
        void show(String text);
    }

    void readStats(final StatsText out) {
        PeerConnection conn;
        synchronized (this) {
            conn = pc;
        }
        if (conn == null) return;
        conn.getStats(new RTCStatsCollectorCallback() {
            public void onStatsDelivered(RTCStatsReport report) {
                final String text = formatStats(report);
                ui.post(new Runnable() {
                    public void run() { out.show(text); }
                });
            }
        });
    }

    private double perSec(String key, Object value, double ts) {
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

    private String formatStats(RTCStatsReport report) {
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
                double fps = perSec("vframes", m.get("framesDecoded"), ts);
                Object bytes = m.get("bytesReceived");
                double mbps = perSec("vbytes", bytes instanceof Number ? ((Number) bytes).doubleValue() * 8 / 1e6 : null, ts);
                b.append("Player    NATIVE (hardware path)\n");
                b.append("Picture   ").append(size).append("  ").append(fmt(fps, 0)).append(" fps  ").append(fmt(mbps, 1)).append(" Mbps\n");
                Object impl = m.get("decoderImplementation");
                b.append("Decoder   ").append(codecName.replace("video/", "")).append(impl != null ? "  " + impl : "").append('\n');
                b.append("Dropped   ").append(num(m.get("framesDropped"))).append(" frames   freezes ").append(num(m.get("freezeCount")))
                        .append("   lost packets ").append(num(m.get("packetsLost"))).append('\n');
                b.append("Size changes ").append(sizeChanges).append("   connection drops ").append(connectionDrops).append('\n');
            } else if ("audio".equals(m.get("kind"))) {
                Object bytes = m.get("bytesReceived");
                double kbps = perSec("abytes", bytes instanceof Number ? ((Number) bytes).doubleValue() * 8 / 1000 : null, ts);
                double conceal = perSec("aconc", m.get("concealedSamples"), ts);
                double total = perSec("atotal", m.get("totalSamplesReceived"), ts);
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
        public void onDataChannel(DataChannel d) { }
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
