package com.projectorcast.receiver;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

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

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Map<Integer, String[]> answers = new HashMap<Integer, String[]>();
    private final Map<Integer, CountDownLatch> latches = new HashMap<Integer, CountDownLatch>();
    private int nextOfferId = 1;

    private WebView web;
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

        code = loadCode();

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
        setContentView(web);
        hideSystemUi();
        web.loadUrl("file:///android_asset/receiver.html");

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            multicastLock = wifi.createMulticastLock("projectorcast");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }

        server = new CastServer(code, deviceName(), this);
        try {
            server.start();
        } catch (Exception e) {
            Toast.makeText(this, "Could not open network port: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }

        ui.postDelayed(ipWatcher, 3000);
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
                + CastServer.quote(deviceName()) + ")");
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

    @Override
    public void onStop() {
        js("stopCast('The PC stopped casting')");
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
            if (event.getAction() == KeyEvent.ACTION_UP) js("toggleStats()");
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(ipWatcher);
        if (server != null) server.stop();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
