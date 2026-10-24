import com.projectorcast.receiver.SdpTools;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/** Writes the native player's SDP fixes for the fixtures; node/sdp-parity.test.js compares them with receiver.html. */
public class SdpToolsTest {
    public static void main(String[] a) throws Exception {
        String offer = new String(Files.readAllBytes(Paths.get(a[0], "chrome-offer.sdp")), StandardCharsets.UTF_8);
        String answer = new String(Files.readAllBytes(Paths.get(a[0], "chrome-answer.sdp")), StandardCharsets.UTF_8);
        Files.write(Paths.get(a[1], "java-offer.sdp"), SdpTools.unhideAddresses(offer, "192.168.1.20").getBytes(StandardCharsets.UTF_8));
        Files.write(Paths.get(a[1], "java-answer.sdp"), SdpTools.wantStereo(answer).getBytes(StandardCharsets.UTF_8));
        Files.write(Paths.get(a[1], "java-answer-twice.sdp"), SdpTools.wantStereo(SdpTools.wantStereo(answer)).getBytes(StandardCharsets.UTF_8));
        if (!SdpTools.unhideAddresses(offer, "not-an-ip").equals(offer)) throw new AssertionError("bad IP must leave SDP alone");
    }
}
