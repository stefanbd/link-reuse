using Microsoft.Win32;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;

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

    /// Every running process, with its parent and executable name.
    private static Dictionary<uint, (uint Parent, string Name)> Processes()
    {
        var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Cannot list the running processes.");
        try
        {
            var processes = new Dictionary<uint, (uint Parent, string Name)>();
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), Name = "" };
            if (Process32FirstW(snapshot, ref entry)) do
            {
                processes[entry.Id] = (entry.Parent, entry.Name);
            } while (Process32NextW(snapshot, ref entry));
            return processes;
        }
        finally { CloseHandle(snapshot); }
    }

    internal static (string Browser, int ProcessId) ParentBrowser()
    {
        var parents = Processes();
        var id = (uint)Environment.ProcessId;
        for (var depth = 0; depth < 8 && parents.TryGetValue(id, out var process); depth++)
        {
            var browser = Known.FirstOrDefault(value => value.Value.Exe.Equals(process.Name, StringComparison.OrdinalIgnoreCase)).Key;
            if (browser is not null) return (browser, (int)id);
            id = process.Parent;
        }
        throw new InvalidOperationException("The helper must be launched by a supported browser.");
    }

    /// Completes when the browser quits: when each of its main processes in this session (its executable, not started
    /// by itself) has exited. Its other processes come and go with its tabs.
    internal static Task Quit(string id)
    {
        var exe = Known[id].Exe;
        using var self = Process.GetCurrentProcess();
        var processes = Processes();
        var mains = new List<Task>();
        foreach (var (pid, (parent, name)) in processes)
        {
            if (!name.Equals(exe, StringComparison.OrdinalIgnoreCase) ||
                (processes.TryGetValue(parent, out var starter) && starter.Name.Equals(exe, StringComparison.OrdinalIgnoreCase))) continue;
            try
            {
                var process = Process.GetProcessById((int)pid);
                if (process.SessionId == self.SessionId) mains.Add(process.WaitForExitAsync());
            }
            catch (ArgumentException) { }
        }
        return Task.WhenAll(mains);
    }

    /// Whether a profile of the browser has the extension installed and enabled, read from the profiles' preference
    /// files (the record the browser's extensions page shows).
    internal static bool HasExtension(string id, string extension, string? userData = null)
    {
        userData ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Known[id].Vendor, "User Data");
        if (!Directory.Exists(userData)) return false;
        foreach (var profile in Directory.EnumerateDirectories(userData))
        foreach (var name in new[] { "Secure Preferences", "Preferences" })
        {
            try
            {
                using var preferences = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(profile, name)));
                JsonElement? entry = preferences.RootElement;
                foreach (var key in new[] { "extensions", "settings", extension })
                    entry = entry is { ValueKind: JsonValueKind.Object } parent && parent.TryGetProperty(key, out var child) ? child : null;
                if (entry is { ValueKind: JsonValueKind.Object } found && Enabled(found)) return true;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { }
        }
        return false;
    }

    // Disabled: older Chromium sets state 0; newer lists disable_reasons (an array, or a non-zero mask).
    private static bool Enabled(JsonElement entry)
    {
        if (entry.TryGetProperty("state", out var state) && state.ValueKind == JsonValueKind.Number && state.TryGetInt64(out var value) && value == 0) return false;
        if (!entry.TryGetProperty("disable_reasons", out var reasons)) return true;
        return reasons.ValueKind switch
        {
            JsonValueKind.Array => reasons.GetArrayLength() == 0,
            JsonValueKind.Number => reasons.TryGetInt64(out var mask) && mask == 0,
            _ => true,
        };
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
