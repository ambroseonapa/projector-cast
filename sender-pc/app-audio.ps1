# Captures the sound of one app, or of the apps showing on one screen (Windows process loopback,
# build 20348 or later), mixes it and writes it to stdout as 48 kHz stereo 16-bit PCM. With $Mute,
# those apps are muted on this PC meanwhile; they are unmuted when stdin closes or receives "stop".
# main.js puts $TargetWindow (a window handle, or 0), $ScreenRect (left, top, right, bottom in screen
# pixels, when capturing the apps on a screen), $SelfPid and $Mute in front of this script.

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

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    public struct Rect { public int Left, Top, Right, Bottom; }

    /// Processes with a visible window centred inside (or, with inside false, outside) this screen area.
    public static uint[] PidsOnScreen(int left, int top, int right, int bottom, bool inside) {
        SetProcessDpiAwarenessContext(new IntPtr(-4)); // real pixel positions on scaled screens
        HashSet<uint> found = new HashSet<uint>();
        EnumWindows(delegate (IntPtr w, IntPtr param) {
            Rect r;
            int cloaked;
            if (!IsWindowVisible(w) || IsIconic(w) || !GetWindowRect(w, out r)) return true;
            if (DwmGetWindowAttribute(w, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // on another desktop
            if (r.Right - r.Left < 100 || r.Bottom - r.Top < 60) return true;
            int cx = (r.Left + r.Right) / 2, cy = (r.Top + r.Bottom) / 2;
            if ((cx >= left && cx < right && cy >= top && cy < bottom) != inside) return true;
            uint pid = PidOfWindow(w.ToInt64());
            if (pid != 0) found.Add(pid);
            return true;
        }, IntPtr.Zero);
        uint[] result = new uint[found.Count];
        found.CopyTo(result);
        return result;
    }

    /// Sound captured from one process tree, waiting to be mixed.
    class Source {
        public volatile bool Stop;
        public readonly short[] Ring = new short[48000 * 2];
        public int Read, Size;
        public bool Primed;
    }

    static readonly Dictionary<uint, Source> sources = new Dictionary<uint, Source>();
    static volatile bool stopping;
    static Thread mixer;

    public static void Stop() { stopping = true; }

    /// True once capturing has ended: stopped, or stdout/stdin closed.
    public static bool Finished { get { return stopping || mixer == null || !mixer.IsAlive; } }

    public static void Join() { if (mixer != null) mixer.Join(1000); }

    /// Starts the mixer; "stop" or the end of stdin stops everything.
    public static void Start() {
        mixer = new Thread(Mix);
        mixer.IsBackground = true;
        mixer.Start();
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

    /// From now on captures exactly these processes (each with its child processes).
    public static void SetSources(uint[] pids) {
        lock (sources) {
            HashSet<uint> want = new HashSet<uint>(pids);
            foreach (uint pid in new List<uint>(sources.Keys)) {
                if (want.Contains(pid)) continue;
                sources[pid].Stop = true;
                sources.Remove(pid);
            }
            foreach (uint pid in want) {
                if (sources.ContainsKey(pid)) continue;
                Source src = new Source();
                uint target = pid;
                sources[pid] = src;
                Thread t = new Thread(delegate () {
                    try { Capture(target, src); }
                    catch (Exception e) { Console.Error.WriteLine(e.Message); }
                });
                t.IsBackground = true;
                t.Start();
            }
        }
    }

    /// Every few ms: adds up what the sources captured and writes it to stdout, in real time.
    static void Mix() {
        Stream stdout = Console.OpenStandardOutput();
        System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
        long written = 0; // frames
        int[] sum = new int[4800 * 2];
        byte[] bytes = new byte[4800 * 4];
        try {
            while (!stopping) {
                Thread.Sleep(5);
                long due = clock.ElapsedMilliseconds * 48 - written;
                if (due > 48000) { written += due - 4800; due = 4800; } // was held up: don't try to catch up
                if (due < 240) continue;
                int frames = (int)Math.Min(due, 4800);
                Array.Clear(sum, 0, frames * 2);
                Source[] all;
                lock (sources) {
                    all = new Source[sources.Count];
                    sources.Values.CopyTo(all, 0);
                }
                foreach (Source src in all) {
                    lock (src) {
                        if (!src.Primed && src.Size >= 960 * 2) src.Primed = true; // 20 ms in hand
                        if (!src.Primed) continue;
                        int n = Math.Min(src.Size, frames * 2);
                        for (int i = 0; i < n; i++) sum[i] += src.Ring[(src.Read + i) % src.Ring.Length];
                        src.Read = (src.Read + n) % src.Ring.Length;
                        src.Size -= n;
                        if (n < frames * 2) src.Primed = false;
                    }
                }
                for (int i = 0; i < frames * 2; i++) {
                    int v = Math.Max(-32768, Math.Min(32767, sum[i]));
                    bytes[2 * i] = (byte)v;
                    bytes[2 * i + 1] = (byte)(v >> 8);
                }
                stdout.Write(bytes, 0, frames * 4);
                stdout.Flush();
                written += frames;
            }
        } catch (IOException) {
            stopping = true; // stdout closed: the PC app is gone
        }
    }

    /// Captures process tree `pid` into `src` until it or everything is stopped.
    static void Capture(uint pid, Source src) {
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

        short[] buf = new short[0];
        client.Start();
        try {
            while (!stopping && !src.Stop) {
                ready.WaitOne(100);
                uint next;
                capture.GetNextPacketSize(out next);
                while (next > 0 && !stopping && !src.Stop) {
                    IntPtr data; uint frames, flags; ulong pos, qpc;
                    capture.GetBuffer(out data, out frames, out flags, out pos, out qpc);
                    int samples = (int)frames * 2;
                    if (buf.Length < samples) buf = new short[samples];
                    if ((flags & 2) != 0) Array.Clear(buf, 0, samples); // silent packet
                    else Marshal.Copy(data, buf, 0, samples);
                    capture.ReleaseBuffer(frames);
                    lock (src) {
                        int cap = src.Ring.Length;
                        for (int i = 0; i < samples; i++) {
                            src.Ring[(src.Read + src.Size) % cap] = buf[i];
                            if (src.Size < cap) src.Size++;
                            else src.Read = (src.Read + 1) % cap;
                        }
                        // Fallen behind the mixer: keep the delay short.
                        if (src.Size > 48000 * 2 / 5) {
                            int skip = src.Size - 48000 * 2 * 6 / 100;
                            src.Read = (src.Read + skip) % cap;
                            src.Size -= skip;
                        }
                    }
                    capture.GetNextPacketSize(out next);
                }
            }
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

# The given apps and all their child processes (browsers play sound from a child process).
function Get-Tree([uint32[]]$roots) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId
  $tree = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($r in $roots) { [void]$tree.Add($r) }
  do {
    $added = $false
    foreach ($p in $all) {
      if ($tree.Contains([uint32]$p.ParentProcessId) -and $tree.Add([uint32]$p.ProcessId)) { $added = $true }
    }
  } while ($added)
  ,$tree
}

# Windows' own processes, whose windows can sit on any screen.
$skip = @('explorer', 'ApplicationFrameHost', 'TextInputHost', 'ShellExperienceHost', 'StartMenuExperienceHost',
  'SearchHost', 'SearchApp', 'LockApp', 'dwm', 'ProjectorCast', 'Projector Cast', 'electron')

# What the projector hears: the app of the chosen window, or the apps with a window on the cast screen.
# Apps that also have a window on another screen are heard but not muted here ($state.shared).
function Get-Targets {
  if ($TargetWindow) {
    $p = [ProjectorCast.AppAudio]::PidOfWindow([long]$TargetWindow)
    $state.shared = @()
    if ($p) { return ,@([uint32]$p) }
    return ,@()
  }
  $r = $ScreenRect
  $elsewhere = [ProjectorCast.AppAudio]::PidsOnScreen($r[0], $r[1], $r[2], $r[3], $false)
  $found = @([ProjectorCast.AppAudio]::PidsOnScreen($r[0], $r[1], $r[2], $r[3], $true) | Where-Object {
    $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
    $_ -ne $SelfPid -and $proc -and $skip -notcontains $proc.ProcessName
  } | ForEach-Object { [uint32]$_ })
  $state.shared = @($found | Where-Object { $elsewhere -contains $_ })
  ,$found
}

$state = @{ shared = @(); told = '' }
function Tell-Shared {
  # Shown in the PC app: these apps' sound cannot be kept apart per window.
  $names = (@($state.shared | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique) -join ', ')
  if ($names -ne $state.told) { [Console]::Error.WriteLine("shared: $names"); $state.told = $names }
}
function Muted-Part($pids) { ,@($pids | Where-Object { $state.shared -notcontains $_ }) }

$current = Get-Targets
if ($TargetWindow -and $current.Count -eq 0) { [Console]::Error.WriteLine('the window was closed'); exit 1 }
[ProjectorCast.AppAudio]::SetSources([uint32[]]$current)
[ProjectorCast.AppAudio]::Start()
$muted = @()
try {
  while (-not [ProjectorCast.AppAudio]::Finished) {
    Tell-Shared
    if ($Mute) {
      $want = Muted-Part $current
      $unmute = @($muted | Where-Object { $want -notcontains $_ })
      try {
        if ($unmute.Count) { [ProjectorCast.AppAudio]::SetMute((Get-Tree $unmute), $false) }
        # Re-applied regularly: an app opens a new sound session when it starts playing again.
        if ($want.Count) { [ProjectorCast.AppAudio]::SetMute((Get-Tree $want), $true) }
      } catch { }
      $muted = $want
    }
    Start-Sleep -Milliseconds 1500
    $current = Get-Targets
    [ProjectorCast.AppAudio]::SetSources([uint32[]]$current)
  }
} finally {
  [ProjectorCast.AppAudio]::Stop()
  if ($muted.Count) { try { [ProjectorCast.AppAudio]::SetMute((Get-Tree $muted), $false) } catch { } }
  [ProjectorCast.AppAudio]::Join()
}
