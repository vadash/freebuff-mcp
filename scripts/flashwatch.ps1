# flashwatch: run a command and report every console window that pops up on the
# desktop while it runs ("cmd flashes"), with the process chain that caused each.
#
#   pwsh -NoProfile -File scripts/flashwatch.ps1 [-GraceMs 3000] [-Trace] <command> [args...]
#   pwsh -NoProfile -File scripts/flashwatch.ps1 npm test
#   pwsh -NoProfile -File scripts/flashwatch.ps1 npx vitest run tests/server.test.ts -t doctor
#
# A flash is a console window (conhost's, or Windows Terminal's when it is the default
# terminal) shown while the command runs. Windows whose owner chain reaches a process
# that predates the command are foreign (another program) and not counted. -Trace also
# logs window creation and every process the command's tree starts and ends: a process
# that got a console of its own is the parent of a new `conhost.exe 0x4`.
# Exit code: 1 if the command flashed any console window, else 0.

# No param block: pwsh -File would bind the command's own -flags to it. Leading
# flashwatch options are parsed here; the rest is the command, verbatim.
$GraceMs = 3000
$Trace = $false
$Command = [Collections.Generic.List[string]]$args
while ($Command.Count -gt 0) {
    if ($Command[0] -eq '-Trace') { $Trace = $true; $Command.RemoveAt(0) }
    elseif ($Command[0] -eq '-GraceMs' -and $Command.Count -gt 1) { $GraceMs = [int]$Command[1]; $Command.RemoveRange(0, 2) }
    else { break }
}
if ($Command.Count -eq 0) {
    Write-Error 'usage: flashwatch.ps1 [-GraceMs 3000] [-Trace] <command> [args...]'
    exit 2
}

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FlashWatch
{
    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint evThread, uint time);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr hmod, WinEventProc proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int retLen);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; public uint lPrivate; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
        public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    const uint EVENT_OBJECT_CREATE = 0x8000, EVENT_OBJECT_DESTROY = 0x8001, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000, WINEVENT_SKIPOWNPROCESS = 0x0002, WM_QUIT = 0x0012;
    public const string Conhost = "ConsoleWindowClass", Terminal = "CASCADIA_HOSTING_WINDOW_CLASS", Pseudo = "PseudoConsoleWindow";

    public class Shown { public long T; public string Cls; public string Title; public string Verdict; public long Ms = -1; }

    public static bool Trace;
    public static readonly List<Shown> Windows = new List<Shown>();  // every console-class window shown, in order

    static readonly WinEventProc Proc = OnEvent;
    static readonly HashSet<string> Hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "WindowsTerminal.exe", "OpenConsole.exe" };
    static readonly object Gate = new object();
    static readonly HashSet<uint> Ours = new HashSet<uint>();        // every pid ever in the command's tree
    static readonly HashSet<string> Before = new HashSet<string>();  // processes alive before the command started
    static readonly Dictionary<IntPtr, Shown> OnScreen = new Dictionary<IntPtr, Shown>();
    static readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);
    static volatile bool Polling = true;
    static Stopwatch Sw;
    static Thread Pump, Poller;
    static uint PumpTid;

    public static void Start()
    {
        Sw = Stopwatch.StartNew();
        lock (Gate)
        {
            Ours.Add((uint)Process.GetCurrentProcess().Id);
            foreach (var kv in Snapshot()) Before.Add(Key(kv.Key, kv.Value));
        }
        Poller = new Thread(Poll) { IsBackground = true };
        Poller.Start();
        Pump = new Thread(() =>
        {
            PumpTid = GetCurrentThreadId();
            IntPtr hook = SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE, IntPtr.Zero, Proc, 0, 0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
            Ready.Set();
            MSG m;
            while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) DispatchMessageW(ref m);
            UnhookWinEvent(hook);
        }) { IsBackground = true };
        Pump.Start();
        Ready.Wait();
    }

    public static void Stop()
    {
        PostThreadMessageW(PumpTid, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        Pump.Join(2000);
        Polling = false;
        Poller.Join(2000);
        // A Windows Terminal window is owned by WindowsTerminal.exe, so it takes the
        // verdict of the nearest pseudo console shown with it, which the client owns.
        foreach (var w in Windows)
        {
            if (w.Cls != Terminal) continue;
            Shown nearest = null;
            foreach (var p in Windows)
                if (p.Cls == Pseudo && p.Verdict != "unknown" && Math.Abs(p.T - w.T) <= 1500 &&
                    (nearest == null || Math.Abs(p.T - w.T) < Math.Abs(nearest.T - w.T))) nearest = p;
            if (nearest != null) w.Verdict = nearest.Verdict;
        }
    }

    static void Log(string s) { Console.Out.WriteLine("[flash] " + s); Console.Out.Flush(); }

    static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint evThread, uint time)
    {
        if (hwnd == IntPtr.Zero || idObject != 0 || idChild != 0) return;
        long t = Sw.ElapsedMilliseconds;
        if (ev == EVENT_OBJECT_HIDE || ev == EVENT_OBJECT_DESTROY)
        {
            Shown gone;
            if (!OnScreen.TryGetValue(hwnd, out gone)) return;
            OnScreen.Remove(hwnd);
            gone.Ms = t - gone.T;
            if (Trace) Log(string.Format("+{0}ms hidden after {1}ms: {2}", t, gone.Ms, gone.Title));
            return;
        }
        if (ev != EVENT_OBJECT_SHOW && !Trace) return;
        var cb = new StringBuilder(256);
        if (GetClassNameW(hwnd, cb, 256) == 0) return;
        string cls = cb.ToString();
        if (cls != Conhost && cls != Terminal && cls != Pseudo) return;
        var tb = new StringBuilder(512);
        GetWindowTextW(hwnd, tb, 512);
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        var snap = Snapshot();
        string verdict = Verdict(owner, snap);
        Log(string.Format("+{0}ms {1} {2} \"{3}\" ({4})\n          owner {5}", t, ev == EVENT_OBJECT_SHOW ? "SHOW" : "CREATE",
            cls, tb, verdict, Chain(owner, snap)));
        if (ev != EVENT_OBJECT_SHOW) return;
        var w = new Shown { T = t, Cls = cls, Title = tb.ToString(), Verdict = verdict };
        Windows.Add(w);
        OnScreen[hwnd] = w;
    }

    // ours: the owner chain reaches the command's tree; foreign: it reaches a process that
    // predates the command; unknown: it breaks first (a parent already exited), or the
    // window belongs to the terminal itself, which hosts consoles for every program.
    static string Verdict(uint pid, Dictionary<uint, Tuple<uint, string>> snap)
    {
        Tuple<uint, string> owner;
        if (snap.TryGetValue(pid, out owner) && Hosts.Contains(owner.Item2)) return "unknown";
        for (int i = 0; i < 32 && pid != 0; i++)
        {
            Tuple<uint, string> p;
            if (!snap.TryGetValue(pid, out p)) return "unknown";
            lock (Gate)
            {
                if (Ours.Contains(pid)) return "ours";
                if (Before.Contains(Key(pid, p))) return "foreign";
            }
            pid = p.Item1;
        }
        return "unknown";
    }

    // Tracks the command's process tree; toolhelp snapshots every 10ms catch even
    // short-lived helpers such as taskkill.
    static void Poll()
    {
        var seen = new HashSet<string>();
        lock (Gate) seen.UnionWith(Before);
        var live = new Dictionary<uint, Tuple<long, string>>();
        while (Polling)
        {
            var snap = Snapshot();
            foreach (var kv in snap)
            {
                if (!seen.Add(Key(kv.Key, kv.Value))) continue;
                lock (Gate)
                {
                    if (!Ours.Contains(kv.Value.Item1)) continue;
                    Ours.Add(kv.Key);
                }
                long t = Sw.ElapsedMilliseconds;
                live[kv.Key] = Tuple.Create(t, kv.Value.Item2);
                if (Trace) Log(string.Format("+{0}ms NEW {1}({2}) ppid={3} [{4}]", t, kv.Value.Item2, kv.Key, kv.Value.Item1, Trunc(CmdLine(kv.Key))));
            }
            foreach (var pid in new List<uint>(live.Keys))
            {
                Tuple<uint, string> p;
                if (snap.TryGetValue(pid, out p) && p.Item2 == live[pid].Item2) continue;
                if (Trace) Log(string.Format("+{0}ms EXIT {1}({2}) lived {3}ms", Sw.ElapsedMilliseconds, live[pid].Item2, pid, Sw.ElapsedMilliseconds - live[pid].Item1));
                live.Remove(pid);
            }
            Thread.Sleep(10);
        }
    }

    static string Key(uint pid, Tuple<uint, string> p) { return pid + ":" + p.Item1 + ":" + p.Item2; }

    static string Trunc(string s) { return s == null ? "" : s.Length > 220 ? s.Substring(0, 220) + "..." : s; }

    static Dictionary<uint, Tuple<uint, string>> Snapshot()
    {
        var d = new Dictionary<uint, Tuple<uint, string>>();
        IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);  // TH32CS_SNAPPROCESS
        var pe = new PROCESSENTRY32W();
        pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
        if (Process32FirstW(snap, ref pe))
            do { d[pe.th32ProcessID] = Tuple.Create(pe.th32ParentProcessID, pe.szExeFile); } while (Process32NextW(snap, ref pe));
        CloseHandle(snap);
        return d;
    }

    static string CmdLine(uint pid)
    {
        IntPtr h = OpenProcess(0x1000, false, pid);  // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return null;
        try
        {
            int len;
            NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);  // ProcessCommandLineInformation
            if (len <= 0) return null;
            IntPtr buf = Marshal.AllocHGlobal(len);
            try
            {
                if (NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
                int chars = (ushort)Marshal.ReadInt16(buf) / 2;
                return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, IntPtr.Size), chars);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally { CloseHandle(h); }
    }

    static string Chain(uint pid, Dictionary<uint, Tuple<uint, string>> snap)
    {
        var parts = new List<string>();
        for (int i = 0; i < 5 && pid != 0; i++)
        {
            Tuple<uint, string> p;
            if (!snap.TryGetValue(pid, out p)) { parts.Add("<exited>(" + pid + ")"); break; }
            string cl = CmdLine(pid);
            parts.Add(string.Format("{0}({1}){2}", p.Item2, pid, cl == null ? "" : " [" + Trunc(cl) + "]"));
            pid = p.Item1;
        }
        return string.Join("\n          <- ", parts);
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp
[FlashWatch]::Trace = $Trace
[FlashWatch]::Start()
$sw = [Diagnostics.Stopwatch]::StartNew()
$exe, $rest = $Command
& $exe @rest
$code = $LASTEXITCODE
Start-Sleep -Milliseconds $GraceMs  # catch flashes from processes that outlive the command
[FlashWatch]::Stop()

$shown = @([FlashWatch]::Windows | Where-Object Cls -ne ([FlashWatch]::Pseudo))
$flashes = @($shown | Where-Object Verdict -ne 'foreign')
$foreign = @($shown | Where-Object Verdict -eq 'foreign')
''
"=== flashwatch: command exit=$code, wall=$([int]$sw.Elapsed.TotalSeconds)s, flashes=$($flashes.Count), foreign windows ignored=$($foreign.Count) ==="
$flashes | Group-Object { "$($_.Verdict): $($_.Cls) `"$($_.Title)`"" } | Sort-Object Count -Descending |
    ForEach-Object { '{0,5} x {1}' -f $_.Count, $_.Name }
$ms = @($flashes | Where-Object Ms -ge 0 | ForEach-Object Ms | Sort-Object)
if ($ms.Count) { "on screen: min $($ms[0])ms, median $($ms[[int]($ms.Count / 2)])ms, max $($ms[-1])ms" }
exit ([int]($flashes.Count -gt 0))
