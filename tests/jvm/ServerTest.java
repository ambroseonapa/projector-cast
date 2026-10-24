import com.projectorcast.receiver.CastServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

/** Exercises CastServer's discovery and HTTP endpoints on a desktop JVM. */
public class ServerTest {
    static int failures = 0;
    static void check(boolean ok, String what) {
        System.out.println((ok ? "PASS " : "FAIL ") + what);
        if (!ok) failures++;
    }

    static String[] http(String method, String path, String code, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + CastServer.HTTP_PORT + path).openConnection(Proxy.NO_PROXY);
        c.setRequestMethod(method);
        if (code != null) c.setRequestProperty("X-Cast-Code", code);
        c.setRequestProperty("X-Cast-Sender", "Test PC");
        if (body != null) {
            c.setDoOutput(true);
            c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
        }
        int status = c.getResponseCode();
        InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
        String text = in == null ? "" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        return new String[]{String.valueOf(status), text, c.getHeaderField("Access-Control-Allow-Origin")};
    }

    static String udp(String msg) throws Exception {
        try (DatagramSocket s = new DatagramSocket()) {
            s.setSoTimeout(1000);
            byte[] b = msg.getBytes(StandardCharsets.UTF_8);
            s.send(new DatagramPacket(b, b.length, InetAddress.getByName("127.0.0.1"), CastServer.DISCOVERY_PORT));
            byte[] buf = new byte[256];
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            try { s.receive(p); } catch (SocketTimeoutException e) { return null; }
            return new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
        }
    }

    public static void main(String[] a) throws Exception {
        final String[] seen = new String[2];
        final boolean[] stopped = {false};
        CastServer server = new CastServer("482193", "Smart \"Projector\"", new CastServer.Handler() {
            public String onOffer(String offer, String sender, String ip) throws Exception {
                seen[0] = offer; seen[1] = sender;
                if (offer.contains("explode")) throw new Exception("receiver said no");
                return "{\"type\":\"answer\",\"sdp\":\"v=0\"}";
            }
            public void onStop() { stopped[0] = true; }
        });
        server.start();

        check("PCAST!Smart \"Projector\"".equals(udp("PCAST?482193")), "discovery answers the right code");
        check(udp("PCAST?000000") == null, "discovery stays silent for a wrong code");
        check(udp("hello") == null, "discovery ignores junk");

        String[] r = http("GET", "/ping", null, null);
        check(r[0].equals("200") && r[1].equals("{\"ok\":true,\"name\":\"Smart \\\"Projector\\\"\"}"), "ping returns escaped name: " + r[1]);
        check("*".equals(r[2]), "CORS header present");

        r = http("POST", "/offer", "111111", "{\"type\":\"offer\"}");
        check(r[0].equals("403") && seen[0] == null, "offer with wrong code is refused before reaching the handler");
        r = http("POST", "/offer", null, "{\"type\":\"offer\"}");
        check(r[0].equals("403"), "offer without code is refused");

        String offer = "{\"type\":\"offer\",\"sdp\":\"v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\n\"}";
        r = http("POST", "/offer", "482193", offer);
        check(r[0].equals("200") && r[1].contains("\"answer\""), "offer with right code returns the answer");
        check(offer.equals(seen[0]) && "Test PC".equals(seen[1]), "handler got the exact body and sender name");

        StringBuilder big = new StringBuilder("{\"type\":\"offer\",\"sdp\":\"");
        for (int i = 0; i < 2000; i++) big.append("a=candidate:1 1 udp 2122260223 192.168.1.").append(i % 250).append(" 5000 typ host\\r\\n");
        String bigBody = big.append("\"}").toString();
        r = http("POST", "/offer", "482193", bigBody);
        check(r[0].equals("200") && bigBody.equals(seen[0]), "large offer (" + bigBody.length() + " bytes) arrives intact");

        StringBuilder huge = new StringBuilder();
        while (huge.length() < 600 * 1024) huge.append("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        boolean refused;
        try { refused = http("POST", "/offer", "482193", huge.toString())[0].equals("413"); }
        catch (IOException e) { refused = true; }
        check(refused, "600 KB body is refused");

        r = http("POST", "/offer", "482193", "{\"explode\":1}");
        check(r[0].equals("500") && r[1].contains("receiver said no"), "handler errors become JSON 500: " + r[1]);

        r = http("POST", "/stop", "482193", "{}");
        check(r[0].equals("200") && stopped[0], "stop reaches the handler");
        r = http("GET", "/nothing", null, null);
        check(r[0].equals("404"), "unknown path is 404");
        r = http("OPTIONS", "/offer", null, null);
        check(r[0].equals("204"), "CORS preflight ok");

        check(CastServer.quote("a\u2028b\"\\\n\u0001").equals("\"a\\u2028b\\\"\\\\\\n\\u0001\""), "quote() escapes JSON specials and line separators");

        for (int i = 0; i < 10; i++) http("POST", "/stop", String.valueOf(100000 + i), "{}");
        r = http("POST", "/stop", "482193", "{}");
        check(r[0].equals("403"), "after 10 wrong codes even the right code is locked out for a while");

        server.stop();
        System.out.println(failures == 0 ? "ALL SERVER TESTS PASSED" : failures + " FAILURE(S)");
        System.exit(failures == 0 ? 0 : 1);
    }
}
