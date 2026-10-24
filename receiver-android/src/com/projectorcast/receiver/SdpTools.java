package com.projectorcast.receiver;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** SDP fixes for the native player; the same rules as receiver.html. Plain Java so it is tested on a desktop JVM. */
public final class SdpTools {
    private SdpTools() { }

    private static final Pattern LOCAL_NAME =
            Pattern.compile("(?im)^(a=candidate:\\S+ \\d+ udp \\d+ )[0-9a-f-]+\\.local( )");
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    /** Browsers may hide their address behind a random "xxxx.local" name; put the PC's real address back. */
    public static String unhideAddresses(String sdp, String ip) {
        if (ip == null || !IPV4.matcher(ip).matches()) return sdp;
        return LOCAL_NAME.matcher(sdp).replaceAll("$1" + Matcher.quoteReplacement(ip) + "$2");
    }

    /** Ask for stereo, high-bitrate sound (by default the browser negotiates mono-quality voice). */
    public static String wantStereo(String sdp) {
        Matcher m = Pattern.compile("(?i)a=rtpmap:(\\d+) opus/48000").matcher(sdp);
        if (!m.find()) return sdp;
        String pt = m.group(1);
        Matcher f = Pattern.compile("a=fmtp:" + pt + " ([^\\r\\n]*)").matcher(sdp);
        if (!f.find()) return sdp;
        String params = f.group(1).replaceAll(";?\\s*(stereo|sprop-stereo|maxaveragebitrate)=\\d+", "");
        String line = "a=fmtp:" + pt + " " + params + ";stereo=1;sprop-stereo=1;maxaveragebitrate=256000";
        return sdp.substring(0, f.start()) + line + sdp.substring(f.end());
    }
}
