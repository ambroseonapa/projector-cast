package com.projectorcast.receiver;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * A full-screen browser for links sent from the PC app. The arrows jump between the page's links and
 * buttons (OK opens one); holding OK switches to a pointer (OK clicks, the top and bottom edges
 * scroll). Media keys control the page's video, Back goes back a page or closes the browser. Pages
 * made for TV remotes (YouTube's TV layout) get the remote's keys directly.
 */
public class BrowserActivity extends Activity {

    static final String EXTRA_URL = "url";

    /** The open browser, for commands from the PC (UI thread only). */
    static BrowserActivity current;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private Pointer pointer;
    private TextView hint;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private String defaultAgent;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(false); // links that open a new window open here
        defaultAgent = s.getUserAgentString();
        applyAgent();
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true); // sign-in pages
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                boolean tv = isTvPage(url);
                if (tv && !pageKeys) say("Remote keys go to the page  \u00b7  Back: back / close", 5000);
                pageKeys = tv;
                if (tv) pointer.setVisibility(View.INVISIBLE);
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Web pages open here; "open in the app" links (intent:, market:...) are ignored.
                return !url.matches("(?i)^https?:.*");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                // A video's own full-screen button.
                exitFullscreen();
                fullscreenView = view;
                fullscreenDone = callback;
                root.addView(view, 1, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.INVISIBLE);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Protected (DRM) video is allowed, as in Chrome; camera and microphone are not.
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID.equals(r)) {
                        request.grant(new String[]{r});
                        return;
                    }
                }
                request.deny();
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        pointer = new Pointer(this);
        root.addView(pointer, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        hint = new TextView(this);
        hint.setTextColor(Color.rgb(216, 240, 255));
        hint.setBackgroundColor(Color.argb(190, 0, 0, 0));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        int pad = dp(10);
        hint.setPadding(pad, pad / 2, pad, pad / 2);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        lp.bottomMargin = dp(20);
        root.addView(hint, lp);

        setContentView(root);
        current = this;
        open(getIntent().getStringExtra(EXTRA_URL));
        say("▲▼◀▶ next link  ·  OK open  ·  hold OK: pointer  ·  Back: back / close", 6000);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent.getStringExtra(EXTRA_URL));
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private final Runnable hideHint = new Runnable() {
        public void run() { hint.setVisibility(View.GONE); }
    };

    private void say(String text, long ms) {
        hint.setText(text);
        hint.setVisibility(View.VISIBLE);
        ui.removeCallbacks(hideHint);
        ui.postDelayed(hideHint, ms);
    }

    // ---- Commands (also from the PC) ----

    /** Only web links: a pasted "example.com" gets https:// in front. */
    static String cleanUrl(String url) throws Exception {
        String u = url == null ? "" : url.trim();
        if (u.length() == 0) throw new Exception("no link given");
        if (!u.matches("(?i)^[a-z][a-z0-9+.-]*:.*")) u = "https://" + u;
        if (!u.matches("(?i)^https?://[^\\s]+$")) throw new Exception("only web links (http or https) can be opened");
        return u;
    }

    void open(String url) {
        if (url == null) return;
        exitFullscreen();
        applyAgent(url);
        web.loadUrl(url);
    }

    /** YouTube's TV layout: made for remotes and low-power TVs, and only served to TV browsers. */
    static boolean isTvPage(String url) {
        return url != null && url.matches("(?i)^https?://(www\\.|m\\.)?youtube\\.com/tv.*");
    }

    private void applyAgent(String url) {
        if (isTvPage(url)) {
            web.getSettings().setUserAgentString("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36");
            return;
        }
        applyAgent();
    }

    private void applyAgent() {
        boolean desktop = getSharedPreferences("cast", MODE_PRIVATE).getBoolean("desktopSite", false);
        String agent = defaultAgent.replace("; wv", ""); // some sign-in pages refuse "in-app" browsers
        agent = agent.replaceAll("Version/[\\d.]+ ", "");
        if (desktop) {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("Chrome/[\\d.]+").matcher(agent);
            agent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + (m.find() ? m.group() : "Chrome/120.0.0.0") + " Safari/537.36";
        }
        web.getSettings().setUserAgentString(agent);
    }

    // The page's first video; used by play/pause, seeking and "full screen".
    private static final String VIDEO = "var v=document.querySelector('video');";

    /** Runs a command from the PC; throws with a message for the PC app. UI thread. */
    void command(JSONObject c) throws Exception {
        String action = c.optString("action");
        if (action.equals("open")) {
            open(cleanUrl(c.optString("url")));
        } else if (action.equals("key")) {
            // The PC's keyboard used as the remote.
            int code = keyCode(c.optString("key"));
            dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
            dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
        } else if (action.equals("back")) {
            back();
        } else if (action.equals("reload")) {
            web.reload();
        } else if (action.equals("close")) {
            finish();
        } else if (action.equals("play")) {
            web.evaluateJavascript(VIDEO + "if(v){v.paused?v.play():v.pause();}", null);
        } else if (action.equals("seek")) {
            web.evaluateJavascript(VIDEO + "if(v){v.currentTime+=" + c.optInt("seconds", 10) + ";}", null);
        } else if (action.equals("fullscreen")) {
            // The video fills the screen (its own full-screen button may not respond to a remote).
            web.evaluateJavascript(VIDEO + "if(v){if(v.dataset.pcFull){v.style.cssText=v.dataset.pcFull;delete v.dataset.pcFull;}"
                    + "else{v.dataset.pcFull=v.style.cssText||' ';v.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;"
                    + "z-index:2147483647;background:#000;object-fit:contain';}}", null);
        } else if (action.equals("desktop")) {
            getSharedPreferences("cast", MODE_PRIVATE).edit().putBoolean("desktopSite", c.optBoolean("on")).apply();
            applyAgent(web.getUrl());
            web.reload();
        } else {
            throw new Exception("unknown command");
        }
    }

    /** Types into the text box selected on the page. Server thread; waits for the page's answer. */
    static void type(final String text, final boolean enter) throws Exception {
        final String[] result = {null};
        final CountDownLatch done = new CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            public void run() {
                final BrowserActivity b = current;
                if (b == null) { done.countDown(); return; }
                String js = "(function(){var e=document.activeElement;"
                        + "if(!e||!(e.isContentEditable||/^(INPUT|TEXTAREA)$/.test(e.tagName)))return 'none';"
                        + "document.execCommand('insertText',false," + CastServer.quote(text) + ");return 'ok';})()";
                b.web.evaluateJavascript(js, new ValueCallback<String>() {
                    public void onReceiveValue(String v) {
                        result[0] = v;
                        if (enter && "\"ok\"".equals(v)) {
                            b.web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER));
                            b.web.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
                        }
                        done.countDown();
                    }
                });
            }
        });
        if (!done.await(3, TimeUnit.SECONDS)) throw new Exception("the page did not answer");
        if (result[0] == null) throw new Exception("no page is open on the projector");
        if (!"\"ok\"".equals(result[0])) throw new Exception("select a text box on the projector first");
    }

    private void back() {
        if (fullscreenView != null) exitFullscreen();
        else if (web.canGoBack()) web.goBack();
        else finish();
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        web.setVisibility(View.VISIBLE);
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
    }

    // ---- Remote ----

    private static int keyCode(String key) throws Exception {
        if (key.equals("up")) return KeyEvent.KEYCODE_DPAD_UP;
        if (key.equals("down")) return KeyEvent.KEYCODE_DPAD_DOWN;
        if (key.equals("left")) return KeyEvent.KEYCODE_DPAD_LEFT;
        if (key.equals("right")) return KeyEvent.KEYCODE_DPAD_RIGHT;
        if (key.equals("ok")) return KeyEvent.KEYCODE_DPAD_CENTER;
        if (key.equals("back")) return KeyEvent.KEYCODE_BACK;
        if (key.equals("mode")) return KeyEvent.KEYCODE_MENU;
        throw new Exception("unknown key");
    }

    private boolean pointerMode;   // otherwise the arrows jump between links
    private boolean pageKeys;      // a page made for remotes gets the keys itself
    private boolean okHeld;

    private void toggleMode() {
        pointerMode = !pointerMode;
        if (pointerMode) {
            pointer.show();
            say("Pointer: ▲▼◀▶ move  ·  OK click  ·  hold OK: links", 4000);
        } else {
            pointer.setVisibility(View.INVISIBLE);
            say("Links: ▲▼◀▶ next link  ·  OK open  ·  hold OK: pointer", 4000);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
        boolean arrow = code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN
                || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        if (code == KeyEvent.KEYCODE_BACK) {
            if (!down) back();
            return true;
        }
        if (pageKeys && fullscreenView == null && (arrow || ok)) {
            if (!web.hasFocus()) web.requestFocus();
            return web.dispatchKeyEvent(event);
        }
        if (code == KeyEvent.KEYCODE_MENU) {
            if (!down) toggleMode();
            return true;
        }
        if (ok) {
            // Holding OK switches between links and pointer.
            if (down && event.getRepeatCount() > 0 && !okHeld && event.getEventTime() - event.getDownTime() >= 600) {
                okHeld = true;
                toggleMode();
            } else if (!down) {
                if (!okHeld) {
                    if (pointerMode || fullscreenView != null) click();
                    else linkClick();
                }
                okHeld = false;
            }
            return true;
        }
        if (arrow) {
            if (!down) return true;
            if (pointerMode || fullscreenView != null) movePointer(code, event.getRepeatCount());
            else linkMove(code);
            return true;
        }
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (!down) web.evaluateJavascript(VIDEO + "if(v){v.paused?v.play():v.pause();}", null);
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if (!down) web.evaluateJavascript(VIDEO + "if(v){v.currentTime+=" + (code == KeyEvent.KEYCODE_MEDIA_REWIND ? -10 : 10) + ";}", null);
                return true;
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                if (down) scrollAtPointer(code == KeyEvent.KEYCODE_PAGE_UP || code == KeyEvent.KEYCODE_CHANNEL_UP ? -0.8f : 0.8f);
                return true;
            default:
                return super.dispatchKeyEvent(event);
        }
    }

    /**
     * Link navigation, run in the page: the arrows move a highlight to the nearest link, button or
     * box in that direction; "edge" when there is none (the page then scrolls).
     */
    static final String NAV = "window.__pcNav=window.__pcNav||(function(){var cur=null;"
            + "function vis(e){var r=e.getBoundingClientRect();return r.width>4&&r.height>4&&r.bottom>0&&r.right>0"
            + "&&r.top<innerHeight&&r.left<innerWidth&&getComputedStyle(e).visibility!=='hidden';}"
            + "function all(){return [].slice.call(document.querySelectorAll('a[href],button,input,select,textarea,"
            + "[role=button],[role=link],[role=tab],[role=menuitem],[tabindex]:not([tabindex=\"-1\"]),[onclick]')).filter(vis);}"
            + "function mark(e){if(cur){cur.style.outline=cur.__pcOutline||'';cur.style.outlineOffset=cur.__pcOffset||'';}cur=e;"
            + "if(e){e.__pcOutline=e.style.outline;e.__pcOffset=e.style.outlineOffset;e.style.outline='4px solid #2f8cff';"
            + "e.style.outlineOffset='2px';e.scrollIntoView({block:'nearest',inline:'nearest'});}}"
            + "return{move:function(d){var c=cur&&document.contains(cur)&&vis(cur)?cur:null;var els=all();"
            + "if(!els.length)return 'edge';if(!c){mark(els[0]);return 'ok';}"
            + "var a=c.getBoundingClientRect(),ax=a.left+a.width/2,ay=a.top+a.height/2,best=null,bs=1e9;"
            + "els.forEach(function(e){if(e===c||c.contains(e)||e.contains(c))return;var r=e.getBoundingClientRect(),"
            + "dx=r.left+r.width/2-ax,dy=r.top+r.height/2-ay;var m=d=='left'?-dx:d=='right'?dx:d=='up'?-dy:dy;"
            + "var side=(d=='left'||d=='right')?Math.abs(dy):Math.abs(dx);if(m<=2)return;var sc=m+side*2;"
            + "if(sc<bs){bs=sc;best=e;}});if(best){mark(best);return 'ok';}return 'edge';},"
            + "click:function(){if(cur&&document.contains(cur)){cur.focus();cur.click();return 'ok';}return 'none';}};})();";

    private void linkMove(final int code) {
        final String dir = code == KeyEvent.KEYCODE_DPAD_UP ? "up" : code == KeyEvent.KEYCODE_DPAD_DOWN ? "down"
                : code == KeyEvent.KEYCODE_DPAD_LEFT ? "left" : "right";
        web.evaluateJavascript(NAV + "__pcNav.move('" + dir + "')", new ValueCallback<String>() {
            public void onReceiveValue(String r) {
                // Nothing further that way: scroll to bring more of the page in.
                if ("\"edge\"".equals(r) && (dir.equals("up") || dir.equals("down"))) scrollAtPointer(dir.equals("up") ? -0.35f : 0.35f);
            }
        });
    }

    private void linkClick() {
        web.evaluateJavascript(NAV + "__pcNav.click()", new ValueCallback<String>() {
            public void onReceiveValue(String r) {
                if (!"\"ok\"".equals(r)) linkMove(KeyEvent.KEYCODE_DPAD_DOWN); // nothing highlighted yet: highlight the first link
            }
        });
    }

    /** Faster the longer a key is held; at the top or bottom edge the page scrolls instead. */
    private void movePointer(int code, int repeat) {
        float step = dp(14) * Math.min(1 + repeat / 3f, 5);
        pointer.show();
        int w = root.getWidth(), h = root.getHeight();
        if (code == KeyEvent.KEYCODE_DPAD_UP && pointer.y <= 1) { scrollAtPointer(-0.35f); return; }
        if (code == KeyEvent.KEYCODE_DPAD_DOWN && pointer.y >= h - 2) { scrollAtPointer(0.35f); return; }
        if (code == KeyEvent.KEYCODE_DPAD_UP) pointer.y -= step;
        if (code == KeyEvent.KEYCODE_DPAD_DOWN) pointer.y += step;
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) pointer.x -= step;
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) pointer.x += step;
        pointer.x = Math.max(0, Math.min(w - 1, pointer.x));
        pointer.y = Math.max(0, Math.min(h - 1, pointer.y));
        pointer.invalidate();
    }

    /** Scrolls whatever scrolls under the pointer (a list, or the page) by part of a screen. */
    private void scrollAtPointer(float screens) {
        if (pointer.x < 0) { pointer.x = root.getWidth() / 2f; pointer.y = root.getHeight() / 2f; }
        if (pointerMode) pointer.show();
        @SuppressWarnings("deprecation")
        float scale = web.getScale();
        float x = pointer.x / scale, y = pointer.y / scale;
        web.evaluateJavascript("(function(x,y,dy){var e=document.elementFromPoint(x,y);"
                + "while(e&&e!==document.body&&e!==document.documentElement){var s=getComputedStyle(e);"
                + "if(/(auto|scroll)/.test(s.overflowY)&&e.scrollHeight>e.clientHeight){e.scrollBy({top:dy,behavior:'smooth'});return;}"
                + "e=e.parentElement;}window.scrollBy({top:dy,behavior:'smooth'});})(" + x + "," + y + ","
                + Math.round(screens * root.getHeight() / scale) + ")", null);
    }

    /** A tap where the pointer is. */
    private void click() {
        pointer.show();
        View target = fullscreenView != null ? fullscreenView : web;
        long t = SystemClock.uptimeMillis();
        MotionEvent downEv = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, pointer.x, pointer.y, 0);
        MotionEvent upEv = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, pointer.x, pointer.y, 0);
        downEv.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        upEv.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        target.dispatchTouchEvent(downEv);
        target.dispatchTouchEvent(upEv);
        downEv.recycle();
        upEv.recycle();
    }

    /** The on-screen pointer; hides after a few seconds without remote keys. */
    private static class Pointer extends View {
        float x = -1, y = -1;
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path arrow = new Path();
        private final Runnable hide = new Runnable() {
            public void run() { setVisibility(INVISIBLE); }
        };

        Pointer(Context ctx) {
            super(ctx);
            fill.setColor(Color.WHITE);
            edge.setColor(Color.BLACK);
            edge.setStyle(Paint.Style.STROKE);
            edge.setStrokeWidth(2 * ctx.getResources().getDisplayMetrics().density);
            float d = ctx.getResources().getDisplayMetrics().density;
            arrow.moveTo(0, 0);
            arrow.lineTo(0, 22 * d);
            arrow.lineTo(6 * d, 17 * d);
            arrow.lineTo(10 * d, 26 * d);
            arrow.lineTo(14 * d, 24 * d);
            arrow.lineTo(10 * d, 15 * d);
            arrow.lineTo(17 * d, 15 * d);
            arrow.close();
            setVisibility(INVISIBLE);
        }

        void show() {
            if (x < 0) { x = getWidth() / 2f; y = getHeight() / 2f; }
            setVisibility(VISIBLE);
            removeCallbacks(hide);
            postDelayed(hide, 5000);
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            c.save();
            c.translate(x, y);
            c.drawPath(arrow, fill);
            c.drawPath(arrow, edge);
            c.restore();
        }
    }

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        exitFullscreen();
        web.destroy();
        super.onDestroy();
    }
}
