import com.projectorcast.receiver.CastServer;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

/** Real CastServer whose WebView side is replaced by an HTTP call to the test's receiver page. */
public class RelayServer {
    static String post(String path, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:47900" + path).openConnection(Proxy.NO_PROXY);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setReadTimeout(25000);
        c.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
        if (c.getResponseCode() != 200) throw new Exception(new String(c.getErrorStream().readAllBytes(), StandardCharsets.UTF_8));
        return new String(c.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    }

    public static void main(String[] a) throws Exception {
        new CastServer("482193", "Relay Projector", Integer.parseInt(System.getProperty("version", "3")), new CastServer.Handler() {
            public String onOffer(String offer, String sender, String ip) throws Exception {
                System.out.println("offer from " + sender + " @ " + ip);
                return post("/offer", "{\"offer\":" + CastServer.quote(offer) + ",\"sender\":" + CastServer.quote(sender)
                        + ",\"ip\":" + CastServer.quote(ip) + "}");
            }
            public void onUpdate(byte[] b) throws Exception {
                System.out.println("update " + b.length);
                post("/update", "{\"bytes\":" + b.length + ",\"pk\":" + (b[0] == 'P' && b[1] == 'K') + "}");
            }
            public void onStop() {
                System.out.println("stop");
                try { post("/stop", "{}"); } catch (Exception ignored) { }
            }
        }).start();
        System.out.println("READY");
        Thread.sleep(Long.MAX_VALUE);
    }
}
