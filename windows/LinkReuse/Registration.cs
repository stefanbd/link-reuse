using Microsoft.Win32;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;

namespace LinkReuse;

[SupportedOSPlatform("windows")]
internal static class Registration
{
    internal static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Link Reuse");
    internal static string Sessions => Path.Combine(Root, "sessions");
    internal static string Exe => Environment.ProcessPath ?? throw new InvalidOperationException("Cannot locate Link Reuse.");
    internal static string Home => Path.GetDirectoryName(Exe)!;
    private const string Client = @"Software\Clients\StartMenuInternet\LinkReuse";
    private const string ProgId = @"Software\Classes\LinkReuse.Url";

    internal static string Origin()
    {
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(Home, "extension", "manifest.json")));
        var hash = SHA256.HashData(Convert.FromBase64String(manifest.RootElement.GetProperty("key").GetString()!));
        var id = string.Concat(Convert.ToHexString(hash)[..32].ToLowerInvariant().Select(character => (char)('a' + Convert.ToInt32(character.ToString(), 16))));
        return $"chrome-extension://{id}/";
    }

    internal static string Browser(string? requested = null)
    {
        if (requested is not null)
        {
            if (!Browsers.Known.ContainsKey(requested) || Browsers.Find(requested) is null) throw new InvalidOperationException("Choose an installed browser: edge, chrome or brave.");
            return requested;
        }
        var file = Path.Combine(Root, "settings.json");
        if (File.Exists(file))
        {
            var saved = JsonSerializer.Deserialize(File.ReadAllText(file), WireJson.Default.Settings);
            if (saved is not null && Browsers.Find(saved.Browser) is not null) return saved.Browser;
        }
        return Browsers.Detect();
    }

    internal static void Install(string? requested)
    {
        Directory.CreateDirectory(Root);
        var browser = Browser(requested);
        StopHosts();
        File.WriteAllText(Path.Combine(Root, "settings.json"), JsonSerializer.Serialize(new Settings(browser), WireJson.Default.Settings));
        using (var key = Registry.CurrentUser.CreateSubKey(ProgId))
        {
            key.SetValue(null, "Link Reuse web link");
            key.SetValue("URL Protocol", "");
        }
        Set(ProgId + @"\shell\open\command", null, $"\"{Exe}\" \"%1\"");
        Set(Client, null, "Link Reuse");
        Set(Client + @"\Capabilities", "ApplicationName", "Link Reuse");
        Set(Client + @"\Capabilities", "ApplicationDescription", "Reuse an existing browser tab before opening an external link.");
        Set(Client + @"\Capabilities\URLAssociations", "http", "LinkReuse.Url");
        Set(Client + @"\Capabilities\URLAssociations", "https", "LinkReuse.Url");
        Set(@"Software\RegisteredApplications", "LinkReuse", Client + @"\Capabilities");
        foreach (var (id, value) in Browsers.Known)
        {
            var file = Path.Combine(Root, id + "-host.json");
            using var output = File.Create(file);
            using (var writer = new Utf8JsonWriter(output))
            {
                writer.WriteStartObject();
                writer.WriteString("name", "me.dichev.link_reuse");
                writer.WriteString("description", "Link Reuse local browser bridge");
                writer.WriteString("path", Exe);
                writer.WriteString("type", "stdio");
                writer.WriteStartArray("allowed_origins");
                writer.WriteStringValue(Origin());
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            Set(@"Software\" + value.Vendor + @"\NativeMessagingHosts\me.dichev.link_reuse", null, file);
        }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
    }

    internal static void Uninstall()
    {
        using var command = Registry.CurrentUser.OpenSubKey(ProgId + @"\shell\open\command");
        if (!string.Equals(command?.GetValue(null) as string, $"\"{Exe}\" \"%1\"", StringComparison.OrdinalIgnoreCase)) return;
        StopHosts();
        Registry.CurrentUser.DeleteSubKeyTree(ProgId, false);
        Registry.CurrentUser.DeleteSubKeyTree(Client, false);
        using (var registered = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true)) registered?.DeleteValue("LinkReuse", false);
        foreach (var (id, value) in Browsers.Known)
        {
            var key = @"Software\" + value.Vendor + @"\NativeMessagingHosts\me.dichev.link_reuse";
            using var host = Registry.CurrentUser.OpenSubKey(key);
            var file = Path.Combine(Root, id + "-host.json");
            if (host?.GetValue(null) as string != file) continue;
            Registry.CurrentUser.DeleteSubKeyTree(key, false);
            File.Delete(file);
        }
        SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
    }

    internal static void Defaults() => Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=LinkReuse") { UseShellExecute = true })?.Dispose();
    private static void StopHosts()
    {
        foreach (var browser in Browsers.Known.Keys)
        foreach (var session in NativeHost.LiveSessions(browser))
        {
            try { using var process = Process.GetProcessById(session.ProcessId); process.Kill(); File.Delete(Path.Combine(Sessions, session.Pipe + ".json")); }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or IOException or System.ComponentModel.Win32Exception) { }
        }
    }
    private static void Set(string path, string? name, string value) { using var key = Registry.CurrentUser.CreateSubKey(path); key.SetValue(name, value); }
    [DllImport("shell32.dll")] private static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
