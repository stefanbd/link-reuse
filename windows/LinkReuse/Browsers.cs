using Microsoft.Win32;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LinkReuse;

[SupportedOSPlatform("windows")]
internal static class Browsers
{
    internal static readonly Dictionary<string, (string Exe, string Vendor, string Relative)> Known = new()
    {
        ["edge"] = ("msedge.exe", "Microsoft\\Edge", "Microsoft\\Edge\\Application\\msedge.exe"),
        ["chrome"] = ("chrome.exe", "Google\\Chrome", "Google\\Chrome\\Application\\chrome.exe"),
        ["brave"] = ("brave.exe", "BraveSoftware\\Brave-Browser", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    };

    internal static string? Find(string id)
    {
        if (!Known.TryGetValue(id, out var browser)) return null;
        foreach (var root in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\" + browser.Exe);
            if (key?.GetValue(null) is string path && File.Exists(path)) return path;
        }
        foreach (var folder in new[] { Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var path = Path.Combine(Environment.GetFolderPath(folder), browser.Relative);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    internal static string Detect()
    {
        using var choice = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice");
        var name = choice?.GetValue("ProgId") as string ?? "";
        foreach (var (id, prefix) in new[] { ("edge", "MSEdge"), ("chrome", "Chrome"), ("brave", "Brave") })
            if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && Find(id) is not null) return id;
        return Known.Keys.FirstOrDefault(id => Find(id) is not null) ?? throw new InvalidOperationException("Install Edge, Chrome or Brave first.");
    }

    internal static string ParentBrowser()
    {
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Cannot identify the browser.");
        try
        {
            var parents = new Dictionary<uint, (uint Parent, string Name)>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Name = "" };
            if (Process32FirstW(snapshot, ref entry)) do
            {
                parents[entry.Id] = (entry.Parent, entry.Name);
            } while (Process32NextW(snapshot, ref entry));
            var id = (uint)Environment.ProcessId;
            for (var depth = 0; depth < 8 && parents.TryGetValue(id, out var process); depth++)
            {
                var browser = Known.FirstOrDefault(value => value.Value.Exe.Equals(process.Name, StringComparison.OrdinalIgnoreCase)).Key;
                if (browser is not null) return browser;
                id = process.Parent;
            }
        }
        finally { CloseHandle(snapshot); }
        throw new InvalidOperationException("The helper must be launched by a supported browser.");
    }

    internal static void Launch(string id, string? argument = null)
    {
        var start = new ProcessStartInfo(Find(id) ?? throw new InvalidOperationException("The chosen browser is not installed.")) { UseShellExecute = false };
        if (argument is not null) start.ArgumentList.Add(argument);
        using var process = Process.Start(start);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, Id;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
