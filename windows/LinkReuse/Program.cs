using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace LinkReuse;

internal static class Program
{
    internal static bool ValidURL(string? value) => value is not null && Encoding.UTF8.GetByteCount(value) <= 65536 &&
        !value.Any(character => char.IsControl(character) || character == '"') && Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.Scheme is "http" or "https" && !string.IsNullOrWhiteSpace(uri.Host);

    private static async Task<int> Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--self-test" }))
        {
            try { return await SelfTest(); }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("Link Reuse's native helper requires Windows."); return 1; }
        return await Run(args);
    }

    [SupportedOSPlatform("windows")]
    private static async Task<int> Run(string[] args)
    {
        var native = args.Any(value => value.StartsWith("chrome-extension://", StringComparison.Ordinal));
        try
        {
            if (native)
            {
                if (args[0] != Registration.Origin()) throw new InvalidOperationException("Unexpected extension origin.");
                await new NativeHost().Run();
                return 0;
            }
            var values = args.ToList();
            string? browser = null;
            var browserIndex = values.IndexOf("--browser");
            if (browserIndex >= 0)
            {
                if (browserIndex + 1 >= values.Count) throw new InvalidOperationException("Specify edge, chrome or brave after --browser.");
                browser = values[browserIndex + 1];
                values.RemoveRange(browserIndex, 2);
            }
            switch (values.Count == 1 ? values[0] : "")
            {
                case "--install": Registration.Install(browser); return 0;
                case "--uninstall": Registration.Uninstall(); return 0;
                case "--defaults": Registration.Defaults(); return 0;
                case "--setup": Browsers.Launch(Registration.Browser(browser), new Uri(Path.Combine(Registration.Home, "SETUP.html")).AbsoluteUri); return 0;
                case "--status":
                    var chosen = Registration.Browser(browser);
                    Show($"Browser: {chosen}\nConnected extension profiles: {NativeHost.LiveSessions(chosen).Count()}\n\nSetup: link-reuse --setup\nDefault links: link-reuse --defaults");
                    return 0;
            }
            if (values.Count == 0) { Browsers.Launch(Registration.Browser(browser), new Uri(Path.Combine(Registration.Home, "SETUP.html")).AbsoluteUri); return 0; }
            if (values.Count != 1 || !ValidURL(values[0])) throw new InvalidOperationException("Pass one http/https URL, optionally with --browser edge, chrome or brave. Setup: --setup; registration: --install; defaults: --defaults.");
            foreach (var url in values) await NativeHost.Open(Registration.Browser(browser), url);
            return 0;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or System.Text.Json.JsonException or OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            if (!native) Show(error is OperationCanceledException ? "The browser did not respond in time. Check whether the link opened before trying again." : error.Message, true);
            return 1;
        }
    }

    private static async Task<int> SelfTest()
    {
        foreach (var value in new[] { "https://example.test/a?x=1&y=2", "http://localhost:1234/", "https://example.test/%22%26" })
            if (!ValidURL(value)) throw new Exception("Valid URL rejected.");
        foreach (var value in new[] { "file:///C:/secret", "javascript:alert(1)", "--install", "https://example.test/\r\n", "https://" })
            if (ValidURL(value)) throw new Exception("Invalid URL accepted.");
        var expected = new Message("open", "test", "https://example.test/?x=\"&y=two");
        using var stream = new MemoryStream();
        await Wire.Write(stream, expected);
        stream.Position = 0;
        if (await Wire.Read(stream) != expected) throw new Exception("Native framing failed.");
        stream.SetLength(0);
        stream.Position = 0;
        stream.Write(new byte[] { 0xff, 0xff, 0xff, 0x7f });
        stream.Position = 0;
        try { await Wire.Read(stream); throw new Exception("Unbounded frame accepted."); }
        catch (InvalidDataException) { }
        if (OperatingSystem.IsWindows()) await CheckWindowsPipe(expected);
        Console.WriteLine("Windows request validation and native framing checks passed.");
        return 0;
    }

    [SupportedOSPlatform("windows")]
    private static async Task CheckWindowsPipe(Message expected)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var name = "linkreuse-check-" + Guid.NewGuid().ToString("N");
        await using var server = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
            System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly);
        var accepted = server.WaitForConnectionAsync(timeout.Token);
        await using var client = new System.IO.Pipes.NamedPipeClientStream(".", name, System.IO.Pipes.PipeDirection.InOut,
            System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly);
        await client.ConnectAsync(timeout.Token);
        await accepted;
        var reading = Wire.Read(server, timeout.Token);
        await Wire.Write(client, expected, timeout.Token);
        if (await reading != expected) throw new Exception("Current-user Windows pipe failed.");
    }

    [SupportedOSPlatform("windows")]
    private static void Show(string text, bool error = false) => MessageBoxW(IntPtr.Zero, text, "Link Reuse", error ? 0x10u : 0x40u);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}
