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
import android.view.KeyEvent;
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

    /** Display modes, switched with the remote's left/right arrows. 1 plays natively; 2-4 use the WebView. */
    private static final String[] MODES = {"", "Native (recommended)", "Web standard", "Web GPU layer", "Web canvas"};

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<Integer, String[]> answers = new HashMap<Integer, String[]>();
    private final Map<Integer, CountDownLatch> latches = new HashMap<Integer, CountDownLatch>();
    private int nextOfferId = 1;

    private WebView web;
    private SurfaceViewRenderer surface;
    private NativePlayer player;
    private TextView badge;
    private TextView statsView;
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
        if (NativePlayer.load(this)) {
            try {
                surface = new SurfaceViewRenderer(this);
                root.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                player = new NativePlayer(this, surface, nativeEvents);
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
            }
        });
        web.setFocusable(false);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        statsView = overlayText(Gravity.BOTTOM | Gravity.START, 15);
        statsView.setTypeface(Typeface.MONOSPACE);
        root.addView(statsView, overlayParams(Gravity.BOTTOM | Gravity.START));
        badge = overlayText(Gravity.TOP | Gravity.END, 16);
        root.addView(badge, overlayParams(Gravity.TOP | Gravity.END));
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
            Toast.makeText(this, "Could not open network port: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }

        ui.postDelayed(ipWatcher, 3000);
        registerReceiver(installResult, new IntentFilter(INSTALL_ACTION));
    }

    private static final String INSTALL_ACTION = "com.projectorcast.receiver.INSTALL_RESULT";

    /** Android's installer reports back here: show its confirmation screen, or say why it failed. */
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
        String text = "Update not installed: " + why + ". Install ProjectorCast.apk by USB instead.";
        if (nativeCasting()) showIdle(text);
        else js("stopCast(" + CastServer.quote(text) + ")");
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    /** Re-shows the address if the projector changes Wi-Fi network. */
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
            player.readStats(new NativePlayer.StatsText() {
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

    /** Back to the code screen (native sessions). */
    private void showIdle(String reason) {
        if (player != null) player.closeSession();
        if (surface != null) surface.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        statsView.setVisibility(View.GONE);
        badge.setVisibility(View.GONE);
        js("stopCast(" + CastServer.quote(reason) + ")");
    }

    private final NativePlayer.Listener nativeEvents = new NativePlayer.Listener() {
        public void onFirstFrame() {
            web.setVisibility(View.GONE);
        }

        public void onConnectionWeak() {
            showBadge("Connection weak...", 0);
        }

        public void onConnected() {
            // Sound but no picture after a few seconds: say so instead of leaving the code screen up silently.
            ui.removeCallbacks(noPictureCheck);
            ui.postDelayed(noPictureCheck, 6000);
            showBadge("Casting from " + sender + "  \u00b7  OK: stats  \u00b7  \u25c0 \u25b6: display mode " + mode + "/4", 6000);
        }

        public void onEnded(String reason) {
            showIdle(reason);
        }
    };

    private final Runnable noPictureCheck = new Runnable() {
        public void run() {
            if (nativeCasting() && !player.hasPicture()) {
                showBadge("No picture from the native player yet. Press \u25c0 \u25b6 to try another display mode.", 0);
            }
        }
    };

    private void cycleMode(int step) {
        int next = mode;
        do {
            next = ((next - 1 + step + 4) % 4) + 1;
        } while (next == 1 && player == null);
        boolean wasNative = mode == 1;
        mode = next;
        prefs().edit().putInt("playerMode", mode).apply();
        applyDisplayMode();
        String label = "Display mode " + mode + "/4: " + MODES[mode];
        if (wasNative != (mode == 1)) {
            // Switching between the native and the web player needs a new connection; the PC reconnects by itself.
            if (nativeCasting()) showIdle(label + ". Reconnecting...");
            else js("if (pc) stopCast(" + CastServer.quote(label + ". Reconnecting...") + ")");
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

    /** Web modes: tell the page how to draw; "GPU layer" also puts the whole WebView in a hardware layer. */
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
                if (nativeCasting()) showIdle("The PC stopped casting");
                else js("stopCast('The PC stopped casting')");
            }
        });
    }

    @Override
    public void onUpdate(final byte[] apk) throws Exception {
        if (apk.length < 4 || apk[0] != 'P' || apk[1] != 'K') throw new Exception("not an APK");
        ui.post(new Runnable() {
            public void run() {
                if (nativeCasting()) showIdle("Installing the update... select Install when Android asks.");
                else js("stopCast('Installing the update... select Install when Android asks.')");
            }
        });
        try {
            installWithSession(apk);
        } catch (Exception sessionError) {
            // Very old or unusual installers: fall back to handing Android the file.
            installWithFile(apk, sessionError);
        }
    }

    /** Android's PackageInstaller API: works without a file-viewer app and shows the system's confirmation. */
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

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (SystemClock.uptimeMillis() - lastBackPress < 2000) {
                    finish();
                } else {
                    lastBackPress = SystemClock.uptimeMillis();
                    Toast.makeText(this, "Press Back again to close", Toast.LENGTH_SHORT).show();
                }
            }
            return true;
        }
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_INFO) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (nativeCasting()) {
                    statsOn = !statsOn;
                    statsView.setVisibility(View.GONE);
                    ui.removeCallbacks(statsTick);
                    if (statsOn) ui.post(statsTick);
                } else {
                    js("toggleStats()");
                }
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
