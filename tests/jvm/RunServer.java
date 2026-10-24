import com.projectorcast.receiver.CastServer;

/** Runs the receiver's server with a canned answer, for the PC-side network test. */
public class RunServer {
    public static void main(String[] a) throws Exception {
        new CastServer("482193", "Test Projector", 3, new CastServer.Handler() {
            public String onOffer(String offer, String sender, String ip) {
                System.out.println("OFFER from " + sender + ": " + offer.length() + " bytes");
                return "{\"type\":\"answer\",\"sdp\":\"v=0\\r\\n\"}";
            }
            public void onStop() { System.out.println("STOP"); }
            public void onUpdate(byte[] b) { System.out.println("UPDATE " + b.length); }
        }).start();
        System.out.println("READY");
        Thread.sleep(Long.MAX_VALUE);
    }
}
