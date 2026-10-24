package com.projectorcast.receiver;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * LAN signalling for the receiver. Plain Java, no Android dependencies (tested on a desktop JVM).
 *
 * UDP  {@link #DISCOVERY_PORT}: "PCAST?<code>" -> "PCAST!<name>" (only when the code matches)
 * HTTP {@link #HTTP_PORT}:
 *   GET  /ping                -> {"ok":true,"name":...}
 *   POST /offer  (X-Cast-Code) body = SDP offer JSON -> SDP answer JSON
 *   POST /stop   (X-Cast-Code) -> {"ok":true}
 *   POST /update (X-Cast-Code) body = new APK -> {"ok":true}; Android then asks to install it
 *   GET  /stats  (X-Cast-Code) -> what the projector sees right now, for the PC's report
 */
public class CastServer {

    public static final int HTTP_PORT = 47800;
    public static final int DISCOVERY_PORT = 47801;
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int MAX_BODY = 512 * 1024;
    private static final int MAX_APK = 60 * 1024 * 1024;

    public interface Handler {
        /**
         * Called on a server thread; returns the SDP answer JSON or throws.
         * senderIp is the PC's address as seen by this socket.
         */
        String onOffer(String offerJson, String senderName, String senderIp) throws Exception;

        void onStop();

        /** A newer copy of this app pushed by the PC app. */
        void onUpdate(byte[] apk) throws Exception;

        /** JSON with the projector's current stats and recent events. */
        String onStats();
    }

    private final String code;
    private final String name;
    private final int version;
    private final Handler handler;
    private volatile boolean running;
    private ServerSocket http;
    private DatagramSocket udp;
    private int wrongCodes;
    private long lockedUntil;

    public CastServer(String code, String name, int version, Handler handler) {
        this.code = code;
        this.name = name;
        this.version = version;
        this.handler = handler;
    }

    public void start() throws IOException {
        running = true;
        http = new ServerSocket();
        http.setReuseAddress(true);
        http.bind(new InetSocketAddress(HTTP_PORT));
        udp = new DatagramSocket(null);
        udp.setReuseAddress(true);
        udp.setBroadcast(true);
        udp.bind(new InetSocketAddress(DISCOVERY_PORT));

        Thread h = new Thread(new Runnable() {
            public void run() { acceptLoop(); }
        }, "cast-http");
        h.setDaemon(true);
        h.start();
        Thread d = new Thread(new Runnable() {
            public void run() { discoveryLoop(); }
        }, "cast-discovery");
        d.setDaemon(true);
        d.start();
    }

    public void stop() {
        running = false;
        try { if (http != null) http.close(); } catch (IOException ignored) { }
        if (udp != null) udp.close();
    }

    private void discoveryLoop() {
        byte[] buf = new byte[256];
        while (running) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                String msg = new String(p.getData(), 0, p.getLength(), UTF8).trim();
                if (msg.equals("PCAST?" + code)) {
                    byte[] reply = ("PCAST!" + name).getBytes(UTF8);
                    udp.send(new DatagramPacket(reply, reply.length, p.getAddress(), p.getPort()));
                }
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = http.accept();
                Thread t = new Thread(new Runnable() {
                    public void run() { serve(s); }
                }, "cast-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    private void serve(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { respond(out, 400, "{\"error\":\"bad request\"}"); return; }
            String method = parts[0].toUpperCase(Locale.US);
            String path = parts[1];
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            Map<String, String> headers = new HashMap<String, String>();
            String line;
            while ((line = readLine(in)) != null && line.length() > 0) {
                int c = line.indexOf(':');
                if (c > 0) headers.put(line.substring(0, c).trim().toLowerCase(Locale.US), line.substring(c + 1).trim());
            }

            if (method.equals("OPTIONS")) { respond(out, 204, ""); return; }
            if (method.equals("GET") && path.equals("/ping")) {
                respond(out, 200, "{\"ok\":true,\"name\":" + quote(name) + ",\"version\":" + version + "}");
                return;
            }
            if (method.equals("GET") && path.equals("/stats")) {
                if (!codeAccepted(headers.get("x-cast-code"))) { respond(out, 403, "{\"error\":\"wrong code\"}"); return; }
                respond(out, 200, handler.onStats());
                return;
            }
            if (!method.equals("POST")) { respond(out, 404, "{\"error\":\"not found\"}"); return; }
            // Check the code before reading anything big.
            if (!codeAccepted(headers.get("x-cast-code"))) {
                respond(out, 403, "{\"error\":\"wrong code\"}");
                return;
            }

            int len = 0;
            if (headers.containsKey("content-length")) {
                try { len = Integer.parseInt(headers.get("content-length")); } catch (NumberFormatException e) { len = -1; }
            }
            int limit = path.equals("/update") ? MAX_APK : MAX_BODY;
            if (len < 0 || len > limit) { respond(out, 413, "{\"error\":\"body too large\"}"); return; }
            if (path.equals("/update")) s.setSoTimeout(120000);
            byte[] body = new byte[len];
            int read = 0;
            while (read < len) {
                int n = in.read(body, read, len - read);
                if (n < 0) break;
                read += n;
            }
            if (read < len) { respond(out, 400, "{\"error\":\"body cut short\"}"); return; }

            if (path.equals("/offer")) {
                String sender = headers.containsKey("x-cast-sender") ? headers.get("x-cast-sender") : "PC";
                try {
                    String answer = handler.onOffer(new String(body, 0, read, UTF8), sender,
                            s.getInetAddress().getHostAddress());
                    respond(out, 200, answer);
                } catch (Exception e) {
                    respond(out, 500, "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}");
                }
            } else if (path.equals("/stop")) {
                handler.onStop();
                respond(out, 200, "{\"ok\":true}");
            } else if (path.equals("/update")) {
                try {
                    handler.onUpdate(body);
                    respond(out, 200, "{\"ok\":true}");
                } catch (Exception e) {
                    respond(out, 500, "{\"error\":" + quote(String.valueOf(e.getMessage())) + "}");
                }
            } else {
                respond(out, 404, "{\"error\":\"not found\"}");
            }
        } catch (SocketTimeoutException ignored) {
        } catch (IOException ignored) {
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    /** Rate-limits code guessing: 10 wrong codes lock requests for 30 seconds. */
    private synchronized boolean codeAccepted(String given) {
        long now = System.currentTimeMillis();
        if (now < lockedUntil) return false;
        if (code.equals(given)) {
            wrongCodes = 0;
            return true;
        }
        if (++wrongCodes >= 10) {
            wrongCodes = 0;
            lockedUntil = now + 30000;
        }
        return false;
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("line too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return new String(b.toByteArray(), UTF8);
    }

    private static void respond(OutputStream out, int status, String json) throws IOException {
        byte[] body = json.getBytes(UTF8);
        String reason = status == 200 ? "OK" : status == 204 ? "No Content" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: Content-Type, X-Cast-Code, X-Cast-Sender\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(UTF8));
        out.write(body);
        out.flush();
    }

    /** JSON string literal, also safe to embed in JavaScript source. */
    public static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (ch < 0x20 || ch == '\u2028' || ch == '\u2029') b.append(String.format(Locale.US, "\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.append('"').toString();
    }
}
