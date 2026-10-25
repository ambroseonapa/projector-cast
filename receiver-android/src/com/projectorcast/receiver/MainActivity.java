package com.projectorcast.receiver;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.GestureDetector;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.SurfaceViewRenderer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity implements CastServer.Handler {

    private static final long ANSWER_TIMEOUT_SEC = 20;

    /** Display modes (left/right on the remote): 1 is the native player, 2-4 use the WebView. */
    private static final String[] MODES = {"", "Native", "Web", "Web (GPU layer)", "Web (canvas)"};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<Integer, String[]> answers = new HashMap<Integer, String[]>();
    private final Map<Integer, CountDownLatch> latches = new HashMap<Integer, CountDownLatch>();
    private int nextOfferId = 1;

    private WebView web;
    private SurfaceViewRenderer surface;
    private NativePlayer player;
    private TextView badge;
    private TextView statsView;
    private TextView menuView;
    private boolean statsOn;
    private int mode;
    private String sender = "PC";
    private CastServer server;
    private WifiManager.MulticastLock multicastLock;
    private String code;
    private String lastIps = "";
    private long lastBackPress;
    private volatile boolean pageReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        code = loadCode();
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        // Native player surface sits underneath; the WebView (code screen, web modes) covers it until frames arrive.
        // The native player needs Android 7+; older devices use the WebView player.
        if (Build.VERSION.SDK_INT >= 24 && NativePlayer.load(this)) {
            try {
                surface = new SurfaceViewRenderer(this);
                root.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                player = new NativePlayer(this, surface, nativeEvents, prefs().getInt("decoder", 0));
                applyPicture();
                applySync();
                surface.setVisibility(View.GONE);
            } catch (Throwable t) {
                if (surface != null) root.removeView(surface);
                surface = null;
                player = null;
            }
        }
        mode = prefs().getInt("playerMode", 1);
        if (mode < 1 || mode > 4 || (mode == 1 && player == null)) mode = player != null ? 1 : 2;

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        web.addJavascriptInterface(new Bridge(), "Cast");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInfo();
                applyPicture();
                applySync();
            }
        });
        web.setFocusable(false);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statsView = overlayText(Gravity.BOTTOM | Gravity.START, 15);
        statsView.setTypeface(Typeface.MONOSPACE);
        root.addView(statsView, overlayParams(Gravity.BOTTOM | Gravity.START));
        badge = overlayText(Gravity.TOP | Gravity.END, 16);
        root.addView(badge, overlayParams(Gravity.TOP | Gravity.END));
        menuView = overlayText(Gravity.START, 18);
        menuView.setTypeface(Typeface.MONOSPACE);
        menuView.setLineSpacing(0, 1.25f);
        root.addView(menuView, overlayParams(Gravity.CENTER_VERTICAL | Gravity.START));
        setContentView(root);
        hideSystemUi();
        web.loadUrl("file:///android_asset/receiver.html");

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("projectorcast");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }

        applyDisplayMode();
        server = new CastServer(code, deviceName(), versionCode(), this);
        try {
            server.start();
        } catch (Exception e) {
            Toast.makeText(this, "Network port unavailable: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }

        ui.postDelayed(ipWatcher, 3000);
        watchAudioOutputs();
        registerReceiver(installResult, new IntentFilter(INSTALL_ACTION));
    }

    // ---- Event log for the PC's report ----

    private final java.util.LinkedList<String> events = new java.util.LinkedList<String>();

    void log(String what) {
        String line = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date()) + "  " + what;
        synchronized (events) {
            events.add(line);
            while (events.size() > 80) events.removeFirst();
        }
    }

    private String webViewVersion() {
        for (String pkg : new String[]{"com.google.android.webview", "com.android.webview", "com.android.chrome"}) {
            try { return pkg + " " + getPackageManager().getPackageInfo(pkg, 0).versionName; } catch (Exception ignored) { }
        }
        return "?";
    }

    /** Server thread. Diagnostics for the PC's report. */
    @Override
    public String onStats() {
        final String[] text = {""};
        final CountDownLatch done = new CountDownLatch(1);
        ui.post(new Runnable() {
            public void run() {
                if (nativeCasting()) {
                    player.readStats("report", new NativePlayer.StatsText() {
                        public void show(String t) { text[0] = t; done.countDown(); }
                    });
                } else if (web != null) {
                    web.evaluateJavascript("(document.getElementById('stats')||{}).textContent||''", new android.webkit.ValueCallback<String>() {
                        public void onReceiveValue(String v) {
                            try { text[0] = new JSONArray("[" + v + "]").getString(0); } catch (Exception e) { text[0] = String.valueOf(v); }
                            done.countDown();
                        }
                    });
                } else {
                    done.countDown();
                }
            }
        });
        try { done.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        try {
            JSONObject o = new JSONObject();
            o.put("app", versionName());
            o.put("device", Build.MANUFACTURER + " " + Build.MODEL + " (" + Build.HARDWARE + ")");
            o.put("android", Build.VERSION.RELEASE + " / API " + Build.VERSION.SDK_INT);
            o.put("webview", webViewVersion());
            o.put("mode", mode + "/4 " + MODES[mode]);
            o.put("decoding", player != null ? NativePlayer.STRATEGIES[player.strategy()] : "native player not available");
            o.put("casting", nativeCasting() ? "native" : "web or idle");
            o.put("picture", "brightness " + setting(0) + ", contrast " + setting(1) + ", colour " + setting(2) + ", sharpness " + setting(3)
                    + (player != null && player.picture.failed() ? " (not supported by this GPU)" : ""));
            o.put("lipSync", syncMs() + " ms, sound on " + (bluetoothOut ? "Bluetooth" : "speaker"));
            o.put("stats", text[0]);
            JSONArray ev = new JSONArray();
            synchronized (events) {
                for (String e : events) ev.put(e);
            }
            o.put("events", ev);
            return o.toString();
        } catch (Exception e) {
            return "{\"error\":" + CastServer.quote(String.valueOf(e)) + "}";
        }
    }

    private static final String INSTALL_ACTION = "com.projectorcast.receiver.INSTALL_RESULT";

    /** Install session result: show the confirmation screen or the error. */
    private final BroadcastReceiver installResult = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(confirm);
                        return;
                    } catch (Exception e) {
                        updateFailed("the installer could not open (" + e.getMessage() + ")");
                        return;
                    }
                }
            }
            if (status != PackageInstaller.STATUS_SUCCESS) {
                String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                updateFailed(msg != null ? msg : "status " + status);
            }
        }
    };

    private void updateFailed(String why) {
        log("update failed: " + why);
        String text = "Update failed: " + why + ".";
        if (nativeCasting()) showIdle(text);
        else js("stopCast(" + CastServer.quote(text) + ")");
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    /** Refreshes the displayed address when the network changes. */
    private final Runnable ipWatcher = new Runnable() {
        public void run() {
            String ips = localIps();
            if (!ips.equals(lastIps)) pushInfo();
            ui.postDelayed(this, 5000);
        }
    };

    private void pushInfo() {
        if (!pageReady) return;
        lastIps = localIps();
        js("showInfo(" + CastServer.quote(code) + "," + CastServer.quote(lastIps) + ","
                + CastServer.quote(deviceName()) + "," + CastServer.quote(mode + "/4 " + MODES[mode]) + ","
                + CastServer.quote(versionName()) + ")");
        if (mode >= 2) js("setWebMode(" + (mode - 1) + ")");
    }

    private TextView overlayText(int gravity, int sp) {
        TextView t = new TextView(this);
        t.setTextColor(Color.rgb(216, 240, 255));
        t.setBackgroundColor(Color.argb(190, 0, 0, 0));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);
        t.setPadding(pad, pad / 2, pad, pad / 2);
        t.setGravity(gravity);
        t.setVisibility(View.GONE);
        return t;
    }

    private FrameLayout.LayoutParams overlayParams(int gravity) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, gravity);
        int m = (int) (20 * getResources().getDisplayMetrics().density);
        lp.setMargins(m, m, m, m);
        return lp;
    }

    private final Runnable hideBadge = new Runnable() {
        public void run() { badge.setVisibility(View.GONE); }
    };

    private void showBadge(String text, long ms) {
        badge.setText(text);
        badge.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideBadge);
        if (ms > 0) ui.postDelayed(hideBadge, ms);
    }

    private final Runnable statsTick = new Runnable() {
        public void run() {
            if (!statsOn || player == null || !player.active()) return;
            player.readStats("panel", new NativePlayer.StatsText() {
                public void show(String text) {
                    if (statsOn && text.length() > 0) {
                        statsView.setText(text);
                        statsView.setVisibility(View.VISIBLE);
                    }
                }
            });
            ui.postDelayed(this, 1000);
        }
    };

    private boolean nativeCasting() {
        return player != null && player.active();
    }

    /** Returns to the code screen after a native session. */
    private void showIdle(String reason) {
        if (player != null) player.closeSession();
        if (surface != null) surface.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        statsView.setVisibility(View.GONE);
        badge.setVisibility(View.GONE);
        js("stopCast(" + CastServer.quote(reason) + ")");
    }

    private int autoSwitches;

    /** Runs every second during native playback; switches decoder setup on a freeze. */
    private final Runnable healthTick = new Runnable() {
        public void run() {
            if (!nativeCasting()) return;
            player.checkHealth(new NativePlayer.Health() {
                public void result(boolean frozen, boolean neverShown) {
                    if (!frozen || !nativeCasting()) return;
                    log("native: " + (neverShown ? "no picture" : "picture frozen") + " while video keeps arriving (decoding "
                            + NativePlayer.STRATEGIES[player.strategy()] + ")");
                    if (autoSwitches >= NativePlayer.STRATEGIES.length - 1) {
                        showBadge("Playback keeps stalling. Try display mode 4 (\u25c0 \u25b6).", 0);
                        ui.removeCallbacks(healthTick);
                        return;
                    }
                    autoSwitches++;
                    switchDecoder(player.strategy() + 1, "Switching decoder: ");
                }
            });
            ui.postDelayed(this, 1000);
        }
    };

    private void switchDecoder(int next, String why) {
        log("switching decoding: " + why + NativePlayer.STRATEGIES[((next % 3) + 3) % 3]);
        ui.removeCallbacks(healthTick);
        player.setStrategy(next);
        prefs().edit().putInt("decoder", player.strategy()).apply();
        String text = why + NativePlayer.STRATEGIES[player.strategy()] + "\u2026";
        showIdle(text);
        showBadge(text, 6000);
    }

    private final NativePlayer.Listener nativeEvents = new NativePlayer.Listener() {
        public void onFirstFrame() {
            log("native: first picture shown (decoding " + NativePlayer.STRATEGIES[player.strategy()] + ")");
            web.setVisibility(View.GONE);
        }

        public void onConnectionWeak() {
            log("native: connection weak");
            showBadge("Connection weak...", 0);
        }

        public void onConnected() {
            log("native: connected");
            // Sound but no picture after a few seconds: say so instead of leaving the code screen up silently.
            ui.removeCallbacks(noPictureCheck);
            ui.postDelayed(noPictureCheck, 8000);
            ui.removeCallbacks(healthTick);
            ui.postDelayed(healthTick, 2000);
            showBadge(sender + "  \u00b7  OK: status  \u00b7  \u25c0 \u25b6: display mode  \u00b7  hold OK: menu", 4000);
        }

        public void onEnded(String reason) {
            log("native: ended - " + reason);
            showIdle(reason);
        }
    };

    private final Runnable noPictureCheck = new Runnable() {
        public void run() {
            if (nativeCasting() && !player.hasPicture()) {
                showBadge("No picture. Try another display mode (\u25c0 \u25b6).", 0);
            }
        }
    };

    private void cycleMode(int step) {
        int next = mode;
        do {
            next = ((next - 1 + step + 4) % 4) + 1;
        } while (next == 1 && player == null);
        boolean wasNative = mode == 1;
        log("display mode " + mode + " -> " + next);
        mode = next;
        prefs().edit().putInt("playerMode", mode).apply();
        applyDisplayMode();
        String label = "Display mode " + mode + "/4: " + MODES[mode];
        if (wasNative != (mode == 1)) {
            // Switching between the native and the web player needs a new connection; the PC reconnects by itself.
            if (nativeCasting()) showIdle(label + "\u2026");
            else js("if (pc) stopCast(" + CastServer.quote(label + "\u2026") + ")");
        }
        showBadge(label + "   (\u25c0 \u25b6 to change)", 4000);
        pushInfo();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("cast", MODE_PRIVATE);
    }

    private int versionCode() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** Web modes: selects the page's render path; mode 3 also uses a hardware layer for the WebView. */
    private void applyDisplayMode() {
        if (web == null) return;
        web.setLayerType(mode == 3 ? View.LAYER_TYPE_HARDWARE : View.LAYER_TYPE_NONE, null);
        if (mode >= 2) js("setWebMode(" + (mode - 1) + ")");
    }

    private String loadCode() {
        SharedPreferences p = getSharedPreferences("cast", MODE_PRIVATE);
        String c = p.getString("code", null);
        if (c == null) {
            c = String.valueOf(100000 + new SecureRandom().nextInt(900000));
            p.edit().putString("code", c).apply();
        }
        return c;
    }

    private static String deviceName() {
        String m = Build.MODEL == null ? "" : Build.MODEL.trim();
        return m.length() == 0 ? "Projector" : m;
    }

    static String localIps() {
        List<String> out = new ArrayList<String>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        StringBuilder b = new StringBuilder();
        for (String ip : out) {
            if (b.length() > 0) b.append("  ");
            b.append(ip);
        }
        return b.toString();
    }

    private void js(final String script) {
        ui.post(new Runnable() {
            public void run() {
                if (web != null) web.evaluateJavascript(script, null);
            }
        });
    }

    // ---- CastServer.Handler (server threads) ----

    @Override
    public String onOffer(String offerJson, String senderName, String senderIp) throws Exception {
        if (!pageReady) throw new Exception("receiver not ready yet, try again");
        log("offer from " + senderName + " (" + senderIp + "), display mode " + mode + "/4 " + MODES[mode]);
        if (mode == 1 && player != null) return nativeOffer(offerJson, senderName, senderIp);
        int id;
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (this) {
            id = nextOfferId++;
            latches.put(id, latch);
        }
        // Passed as a quoted string and parsed by the page, so a bad body can never run as script.
        js("handleOffer(" + id + "," + CastServer.quote(offerJson) + "," + CastServer.quote(senderName)
                + "," + CastServer.quote(senderIp) + ")");
        boolean ok = latch.await(ANSWER_TIMEOUT_SEC, TimeUnit.SECONDS);
        String[] result;
        synchronized (this) {
            latches.remove(id);
            result = answers.remove(id);
        }
        if (!ok || result == null) throw new Exception("receiver did not answer in time");
        if (result[1] != null) throw new Exception(result[1]);
        return result[0];
    }

    private String nativeOffer(String offerJson, final String senderName, String senderIp) throws Exception {
        JSONObject offer = new JSONObject(offerJson);
        if (!"offer".equals(offer.optString("type")) || !offer.has("sdp")) throw new Exception("bad offer");
        final CountDownLatch shown = new CountDownLatch(1);
        ui.post(new Runnable() {
            public void run() {
                sender = senderName;
                js("if (pc) stopCast(''); setStatus(" + CastServer.quote("Connecting to " + senderName + "...") + ")");
                web.setVisibility(View.VISIBLE);
                surface.setVisibility(View.VISIBLE);
                shown.countDown();
            }
        });
        shown.await(3, TimeUnit.SECONDS);
        String answerSdp = player.answer(offer.getString("sdp"), senderIp);
        JSONObject answer = new JSONObject();
        answer.put("type", "answer");
        answer.put("sdp", answerSdp);
        return answer.toString();
    }

    @Override
    public void onStop() {
        ui.post(new Runnable() {
            public void run() {
                if (nativeCasting()) showIdle("");
                else js("stopCast('')");
            }
        });
    }

    @Override
    public void onUpdate(final byte[] apk) throws Exception {
        if (apk.length < 4 || apk[0] != 'P' || apk[1] != 'K') throw new Exception("not an APK");
        ui.post(new Runnable() {
            public void run() {
                if (nativeCasting()) showIdle("Installing update\u2026");
                else js("stopCast('Installing update\u2026')");
            }
        });
        try {
            installWithSession(apk);
        } catch (Exception sessionError) {
            // Very old or unusual installers: fall back to handing Android the file.
            installWithFile(apk, sessionError);
        }
    }

    /** Installs through a PackageInstaller session (no file-viewer app required). */
    private void installWithSession(byte[] apk) throws Exception {
        PackageInstaller installer = getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(getPackageName());
        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            OutputStream out = session.openWrite("update.apk", 0, apk.length);
            try {
                out.write(apk);
                session.fsync(out);
            } finally {
                out.close();
            }
            Intent done = new Intent(INSTALL_ACTION).setPackage(getPackageName());
            PendingIntent pi = PendingIntent.getBroadcast(this, id, done, PendingIntent.FLAG_UPDATE_CURRENT);
            session.commit(pi.getIntentSender());
        } catch (Exception e) {
            session.abandon();
            throw e;
        } finally {
            session.close();
        }
    }

    private void installWithFile(byte[] apk, final Exception first) throws Exception {
        File dir = getExternalCacheDir();
        File file;
        if (dir != null) {
            file = new File(dir, "update.apk");
            FileOutputStream out = new FileOutputStream(file);
            try { out.write(apk); } finally { out.close(); }
        } else {
            // Readable by the system installer: allowed because this app targets API 23.
            @SuppressWarnings("deprecation")
            FileOutputStream out = openFileOutput("update.apk", MODE_WORLD_READABLE);
            try { out.write(apk); } finally { out.close(); }
            file = getFileStreamPath("update.apk");
        }
        final Uri uri = Uri.fromFile(file);
        ui.post(new Runnable() {
            public void run() {
                for (String action : new String[]{Intent.ACTION_INSTALL_PACKAGE, Intent.ACTION_VIEW}) {
                    Intent i = new Intent(action);
                    i.setDataAndType(uri, "application/vnd.android.package-archive");
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try {
                        startActivity(i);
                        return;
                    } catch (Exception ignored) { }
                }
                updateFailed(String.valueOf(first.getMessage()));
            }
        });
    }

    private class Bridge {
        @JavascriptInterface
        public void answer(int id, String answerJson, String error) {
            synchronized (MainActivity.this) {
                CountDownLatch l = latches.get(id);
                if (l == null) return;
                answers.put(id, new String[]{answerJson, error == null || error.length() == 0 ? null : error});
                l.countDown();
            }
        }
    }

    // ---- Menu (Menu key or hold OK): picture settings and keys for the PC ----

    private static final String[] SETTINGS = {"Brightness", "Contrast", "Colour", "Sharpness"};
    private static final String[] SETTING_KEYS = {"pictureBrightness", "pictureContrast", "pictureColour", "pictureSharpness"};
    /** Menu rows: the four settings, then these. Second value: key sent to the PC. */
    private static final String[][] ROWS = {
            {"Reset picture", null},
            {"Lip sync", null},
            {"Play / pause", "playpause"},
            {"Back", "back"},
            {"Forward", "forward"},
            {"Previous", "previous"},
            {"Next", "next"},
    };
    private static final int RESET_ROW = 4, SYNC_ROW = 5, FIRST_PC_ROW = 6;
    private static final Map<String, String> KEY_NAMES = new HashMap<String, String>();

    static {
        for (String[] r : ROWS) if (r[1] != null) KEY_NAMES.put(r[1], r[0]);
    }

    private boolean menuOpen;
    private int menuRow;

    private int setting(int i) {
        return prefs().getInt(SETTING_KEYS[i], 0);
    }

    private void applyPicture() {
        if (player != null) player.picture.set(setting(0), setting(1), setting(2), setting(3));
        js("setPicture(" + setting(0) + "," + setting(1) + "," + setting(2) + ")");
    }

    // ---- Lip sync: Bluetooth speakers play sound 150-300 ms late, so the picture is delayed to match ----

    private boolean bluetoothOut;

    /** Delay in ms, kept separately for Bluetooth and for the projector's own speaker. */
    private int syncMs() {
        return bluetoothOut ? prefs().getInt("syncBluetooth", 200) : prefs().getInt("syncSpeaker", 0);
    }

    private void applySync() {
        bluetoothOut = bluetoothConnected();
        if (player != null) player.setVideoDelay(syncMs());
        js("setVideoDelay(" + syncMs() + ")");
    }

    private boolean bluetoothConnected() {
        if (Build.VERSION.SDK_INT < 23) return false;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return false;
        for (android.media.AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            // A2DP, BLE headset, BLE speaker
            if (t == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == 26 || t == 27) return true;
        }
        return false;
    }

    /** Re-applies lip sync when a Bluetooth speaker connects or disconnects. */
    private void watchAudioOutputs() {
        if (Build.VERSION.SDK_INT < 23) return;
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        am.registerAudioDeviceCallback(new android.media.AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(android.media.AudioDeviceInfo[] added) { outputsChanged(); }

            @Override
            public void onAudioDevicesRemoved(android.media.AudioDeviceInfo[] removed) { outputsChanged(); }
        }, ui);
    }

    private void outputsChanged() {
        boolean was = bluetoothOut;
        applySync();
        if (was != bluetoothOut) {
            log("sound output: " + (bluetoothOut ? "Bluetooth" : "speaker") + ", lip sync " + syncMs() + " ms");
            if (menuOpen) setMenu(true);
        }
    }

    private final Runnable closeMenu = new Runnable() {
        public void run() { setMenu(false); }
    };

    private void setMenu(boolean open) {
        menuOpen = open;
        ui.removeCallbacks(closeMenu);
        if (!open) {
            menuView.setVisibility(View.GONE);
            return;
        }
        ui.postDelayed(closeMenu, 15000);
        StringBuilder b = new StringBuilder("Picture\n");
        for (int i = 0; i < SETTINGS.length + ROWS.length; i++) {
            if (i == SYNC_ROW) b.append("\nSound\n");
            if (i == FIRST_PC_ROW) b.append("\nPC\n");
            boolean sel = i == menuRow;
            b.append(sel ? "\u25b8 " : "  ");
            if (i < SETTINGS.length || i == SYNC_ROW) {
                String name = i == SYNC_ROW ? "Lip sync" : SETTINGS[i];
                int v = i == SYNC_ROW ? syncMs() : setting(i);
                String value = i == SYNC_ROW ? (v > 0 ? "+" : "") + v + " ms" : (v > 0 && i < 3 ? "+" : "") + v;
                b.append(String.format(java.util.Locale.US, "%-11s", name))
                        .append(sel ? "\u25c0 " + value + " \u25b6" : "  " + value);
                if (i == 3 && mode != 1) b.append("  (display mode 1 only)");
                if (i == SYNC_ROW) b.append(bluetoothOut ? "  (Bluetooth)" : "  (speaker)");
            } else {
                b.append(ROWS[i - SETTINGS.length][0]);
            }
            b.append('\n');
        }
        if (menuRow == SYNC_ROW) b.append("\nMouth moves after the voice: lower. Voice after the mouth: raise.\n");
        b.append("\n\u25b2\u25bc choose  \u25c0\u25b6 change  OK select  Back close");
        menuView.setText(b.toString());
        menuView.setVisibility(View.VISIBLE);
    }

    private void menuMove(int step) {
        int rows = SETTINGS.length + ROWS.length;
        menuRow = ((menuRow + step) % rows + rows) % rows;
        setMenu(true);
    }

    private void menuChange(int step) {
        if (menuRow == SYNC_ROW) {
            int v = Math.max(0, Math.min(800, syncMs() + step * 20));
            prefs().edit().putInt(bluetoothOut ? "syncBluetooth" : "syncSpeaker", v).apply();
            applySync();
            setMenu(true);
            return;
        }
        if (menuRow >= SETTINGS.length) return;
        int min = menuRow == 3 ? 0 : -50, max = menuRow == 3 ? 100 : 50;
        int v = Math.max(min, Math.min(max, setting(menuRow) + step * (menuRow == 3 ? 10 : 5)));
        prefs().edit().putInt(SETTING_KEYS[menuRow], v).apply();
        applyPicture();
        setMenu(true);
    }

    private void menuSelect() {
        if (menuRow < SETTINGS.length || menuRow == SYNC_ROW) {
            setMenu(false);
        } else if (menuRow == RESET_ROW) {
            SharedPreferences.Editor e = prefs().edit();
            for (String k : SETTING_KEYS) e.remove(k);
            e.apply();
            log("picture reset");
            applyPicture();
            setMenu(true);
        } else {
            sendToPc(ROWS[menuRow - SETTINGS.length][1]);
            setMenu(true);
        }
    }

    /** Sends a remote key to the PC over the casting connection. */
    private void sendToPc(final String key) {
        final String name = KEY_NAMES.get(key);
        if (nativeCasting()) {
            pcKeyResult(name, player.sendControl(key));
        } else if (web != null) {
            web.evaluateJavascript("pc ? sendControl(" + CastServer.quote(key) + ") : null", new android.webkit.ValueCallback<String>() {
                public void onReceiveValue(String v) {
                    if ("null".equals(v)) showBadge("Start casting from the PC first.", 3000);
                    else pcKeyResult(name, "true".equals(v));
                }
            });
        }
    }

    private void pcKeyResult(String name, boolean sent) {
        showBadge(sent ? "PC: " + name : "Update Projector Cast on the PC to control it from here.", sent ? 1500 : 4000);
    }

    private static String mediaKey(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                return "playpause";
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                return "next";
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                return "previous";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
                return "forward";
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                return "back";
            default:
                return null;
        }
    }

    /** Menu keys while the menu is open. */
    private boolean menuKey(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean up = event.getAction() == KeyEvent.ACTION_UP;
        if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS) {
            if (up) setMenu(false);
        } else if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) {
            if (down) menuMove(code == KeyEvent.KEYCODE_DPAD_DOWN ? 1 : -1);
        } else if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (down) menuChange(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
        } else if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER) {
            if (up) menuSelect();
        } else {
            return false;
        }
        return true;
    }

    // ---- Activity plumbing ----

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    // Touch devices without a remote: tap = status, swipe left/right = display mode, long press = menu
    // (in the menu: swipe up/down = choose, swipe left/right = change, tap = select).
    private GestureDetector gestures;

    @Override
    public boolean dispatchTouchEvent(MotionEvent ev) {
        if (gestures == null) {
            gestures = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
                @Override
                public boolean onDown(MotionEvent e) { return true; }

                @Override
                public boolean onSingleTapConfirmed(MotionEvent e) {
                    if (menuOpen) menuSelect();
                    else toggleStatus();
                    return true;
                }

                @Override
                public void onLongPress(MotionEvent e) {
                    if (!menuOpen) setMenu(true);
                }

                @Override
                public boolean onFling(MotionEvent a, MotionEvent b, float vx, float vy) {
                    if (a == null) return false;
                    boolean sideways = Math.abs(vx) >= Math.abs(vy);
                    if (menuOpen) {
                        if (sideways) menuChange(vx > 0 ? 1 : -1);
                        else menuMove(vy > 0 ? 1 : -1);
                        return true;
                    }
                    if (!sideways || Math.abs(b.getX() - a.getX()) < 120) return false;
                    cycleMode(vx < 0 ? 1 : -1);
                    return true;
                }
            });
        }
        gestures.onTouchEvent(ev);
        return true;
    }

    private void toggleStatus() {
        if (nativeCasting()) {
            statsOn = !statsOn;
            statsView.setVisibility(View.GONE);
            ui.removeCallbacks(statsTick);
            if (statsOn) ui.post(statsTick);
        } else {
            js("toggleStats()");
        }
    }

    private boolean okHeld;

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int key = event.getKeyCode();
        boolean ok = key == KeyEvent.KEYCODE_DPAD_CENTER || key == KeyEvent.KEYCODE_ENTER || key == KeyEvent.KEYCODE_NUMPAD_ENTER;
        // Holding OK opens the menu (many projector remotes have no Menu key).
        if (ok && okHeld) {
            if (event.getAction() == KeyEvent.ACTION_UP) okHeld = false;
            return true;
        }
        if (ok && !menuOpen && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() > 0
                && event.getEventTime() - event.getDownTime() >= 600) {
            okHeld = true;
            menuRow = 0;
            setMenu(true);
            return true;
        }
        if (ok && event.getAction() == KeyEvent.ACTION_DOWN) return true; // acted on when released
        String media = mediaKey(key);
        if (media != null) {
            if (event.getAction() == KeyEvent.ACTION_UP) sendToPc(media);
            return true;
        }
        if (menuOpen && menuKey(event)) return true;
        if (key == KeyEvent.KEYCODE_MENU || key == KeyEvent.KEYCODE_SETTINGS) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                menuRow = 0;
                setMenu(true);
            }
            return true;
        }
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (SystemClock.uptimeMillis() - lastBackPress < 2000) {
                    finish();
                } else {
                    lastBackPress = SystemClock.uptimeMillis();
                    Toast.makeText(this, "Press Back again to exit", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_INFO) {
            if (event.getAction() == KeyEvent.ACTION_UP) toggleStatus();
            return true;
        }
        if ((code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN) && mode == 1 && player != null) {
            // Up/down: choose how the native player decodes (also changes by itself if the picture freezes).
            if (event.getAction() == KeyEvent.ACTION_UP) {
                autoSwitches = 0;
                switchDecoder(player.strategy() + (code == KeyEvent.KEYCODE_DPAD_DOWN ? 1 : -1), "Decoder: ");
            }
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (event.getAction() == KeyEvent.ACTION_UP) cycleMode(code == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : -1);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(ipWatcher);
        if (server != null) server.stop();
        if (player != null) player.release();
        try { unregisterReceiver(installResult); } catch (Exception ignored) { }
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
