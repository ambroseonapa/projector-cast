# Captures the sound of one process tree (Windows process loopback, build 20348 or later) and writes
# it to stdout as 48 kHz stereo 16-bit PCM. With $Mute, that app is also muted on this PC while
# casting; it is unmuted when stdin closes or receives "stop".
# main.js puts "$TargetWindow = <window handle>; $Mute = <bool>" in front of this script.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace ProjectorCast {

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler {
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation {
    void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient {
    void Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint frames);
    void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr handle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient {
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong qpc);
    void ReleaseBuffer(uint frames);
    void GetNextPacketSize(out uint frames);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    void EnumAudioEndpoints(int flow, int stateMask, out IMMDeviceCollection devices);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
    void GetCount(out uint count);
    void Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    void Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
    void GetAudioSessionControl(); // not used; keeps the method order
    void GetSimpleAudioVolume();   // not used
    void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
    void GetCount(out int count);
    void GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
    // IAudioSessionControl, not used; keeps the method order
    void m1(); void m2(); void m3(); void m4(); void m5(); void m6(); void m7(); void m8(); void m9();
    void GetSessionIdentifier(); void GetSessionInstanceIdentifier();
    void GetProcessId(out uint pid);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6F7E2DE5A04B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
    void SetMasterVolume(float level, ref Guid context);
    void GetMasterVolume(out float level);
    void SetMute(int mute, ref Guid context);
    void GetMute(out int mute);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComVisible(true)]
public class Activation : IActivateAudioInterfaceCompletionHandler, IAgileObject {
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public object Client;
    public int Result;
    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) {
        op.GetActivateResult(out Result, out Client);
        Done.Set();
    }
}

public static class AppAudio {
    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid,
        IntPtr parameters, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    delegate bool EnumProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);

    /// The process that plays the sound of this window (0 if the window is gone).
    public static uint PidOfWindow(long handle) {
        IntPtr window = new IntPtr(handle);
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid == 0) return 0;
        string name = "";
        try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
        if (!name.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return pid;
        // Store apps: the frame belongs to ApplicationFrameHost, the app itself owns a child window.
        uint frame = pid, app = pid;
        EnumChildWindows(window, delegate (IntPtr child, IntPtr param) {
            uint p;
            GetWindowThreadProcessId(child, out p);
            if (p != 0 && p != frame) { app = p; return false; }
            return true;
        }, IntPtr.Zero);
        return app;
    }

    static volatile bool stopping;
    static Thread captureThread;

    public static void Stop() { stopping = true; }

    /// True once capturing has ended: stopped, failed, or stdin closed.
    public static bool Finished { get { return stopping || !captureThread.IsAlive; } }

    /// Captures on a background thread; "stop" or the end of stdin stops it.
    public static void Start(uint pid) {
        captureThread = new Thread(delegate () {
            try { Capture(pid); }
            catch (Exception e) { Console.Error.WriteLine(e.Message); }
        });
        captureThread.IsBackground = true;
        captureThread.Start();
        Thread watch = new Thread(delegate () {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null && line != "stop") { }
            } catch (IOException) { }
            stopping = true;
        });
        watch.IsBackground = true;
        watch.Start();
    }

    public static void Join() { captureThread.Join(1000); }

    /// Writes the sound of process tree `pid` to stdout until Stop().
    public static void Capture(uint pid) {
        // AUDIOCLIENT_ACTIVATION_PARAMS: type PROCESS_LOOPBACK (1), target pid, mode INCLUDE_TARGET_PROCESS_TREE (0)
        IntPtr p = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(p, 0, 1);
        Marshal.WriteInt32(p, 4, (int)pid);
        Marshal.WriteInt32(p, 8, 0);
        // PROPVARIANT holding a VT_BLOB (65) that points to the parameters
        IntPtr v = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i++) Marshal.WriteByte(v, i, 0);
        Marshal.WriteInt16(v, 0, 65);
        Marshal.WriteInt32(v, 8, 12);
        Marshal.WriteIntPtr(v, IntPtr.Size == 8 ? 16 : 12, p);

        Guid iid = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        Activation done = new Activation();
        IActivateAudioInterfaceAsyncOperation op;
        ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, v, done, out op);
        done.Done.WaitOne();
        if (done.Result != 0) throw new Exception("Windows could not capture this app (0x" + done.Result.ToString("X8") + ")");
        IAudioClient client = (IAudioClient)done.Client;

        // WAVEFORMATEX: PCM, 2 channels, 48000 Hz, 16-bit
        IntPtr fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 1);
        Marshal.WriteInt16(fmt, 2, 2);
        Marshal.WriteInt32(fmt, 4, 48000);
        Marshal.WriteInt32(fmt, 8, 48000 * 4);
        Marshal.WriteInt16(fmt, 12, 4);
        Marshal.WriteInt16(fmt, 14, 16);
        Marshal.WriteInt16(fmt, 16, 0);
        // LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM, 20 ms buffer
        client.Initialize(0, 0x00020000 | 0x00040000 | 0x80000000, 200000, 0, fmt, IntPtr.Zero);
        AutoResetEvent ready = new AutoResetEvent(false);
        client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        Guid captureIid = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        object svc;
        client.GetService(ref captureIid, out svc);
        IAudioCaptureClient capture = (IAudioCaptureClient)svc;

        Stream stdout = Console.OpenStandardOutput();
        byte[] buf = new byte[0];
        client.Start();
        try {
            while (!stopping) {
                ready.WaitOne(100);
                uint next;
                capture.GetNextPacketSize(out next);
                while (next > 0 && !stopping) {
                    IntPtr data; uint frames, flags; ulong pos, qpc;
                    capture.GetBuffer(out data, out frames, out flags, out pos, out qpc);
                    int bytes = (int)frames * 4;
                    if (buf.Length < bytes) buf = new byte[bytes];
                    if ((flags & 2) != 0) Array.Clear(buf, 0, bytes); // silent packet
                    else Marshal.Copy(data, buf, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    stdout.Write(buf, 0, bytes);
                    capture.GetNextPacketSize(out next);
                }
                stdout.Flush();
            }
        } catch (IOException) {
            // stdout closed: the PC app is gone
        } finally {
            client.Stop();
        }
    }

    /// Mutes or unmutes the audio sessions of the given processes on every output device.
    public static void SetMute(HashSet<uint> pids, bool mute) {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDeviceCollection devices;
        en.EnumAudioEndpoints(0, 1, out devices); // render, active
        uint count;
        devices.GetCount(out count);
        Guid mgrIid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        Guid none = Guid.Empty;
        for (uint d = 0; d < count; d++) {
            IMMDevice dev;
            devices.Item(d, out dev);
            object o;
            dev.Activate(ref mgrIid, 23, IntPtr.Zero, out o); // CLSCTX_ALL
            IAudioSessionEnumerator sessions;
            ((IAudioSessionManager2)o).GetSessionEnumerator(out sessions);
            int n;
            sessions.GetCount(out n);
            for (int i = 0; i < n; i++) {
                IAudioSessionControl2 s;
                sessions.GetSession(i, out s);
                uint pid;
                s.GetProcessId(out pid);
                if (pids.Contains(pid)) ((ISimpleAudioVolume)s).SetMute(mute ? 1 : 0, ref none);
            }
        }
    }
}
}
'@

if ($env:PCAST_COMPILE_ONLY) { exit 0 }

# The app and all its child processes (browsers play sound from a child process).
function Get-Tree([uint32]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $tree = New-Object 'System.Collections.Generic.HashSet[uint32]'
  [void]$tree.Add($root)
  do {
    $added = $false
    foreach ($p in $all) {
      if ($tree.Contains([uint32]$p.ParentProcessId) -and $tree.Add([uint32]$p.ProcessId)) { $added = $true }
    }
  } while ($added)
  ,$tree
}

$TargetPid = [ProjectorCast.AppAudio]::PidOfWindow([long]$TargetWindow)
if ($TargetPid -eq 0) { [Console]::Error.WriteLine('the window was closed'); exit 1 }
[ProjectorCast.AppAudio]::Start([uint32]$TargetPid)
try {
  while (-not [ProjectorCast.AppAudio]::Finished) {
    # Re-applied regularly: an app opens a new sound session when it starts playing again.
    if ($Mute) { try { [ProjectorCast.AppAudio]::SetMute((Get-Tree $TargetPid), $true) } catch { } }
    Start-Sleep -Milliseconds 1500
  }
} finally {
  [ProjectorCast.AppAudio]::Stop()
  if ($Mute) { try { [ProjectorCast.AppAudio]::SetMute((Get-Tree $TargetPid), $false) } catch { } }
  [ProjectorCast.AppAudio]::Join()
}
