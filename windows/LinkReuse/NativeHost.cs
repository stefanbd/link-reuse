using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;

namespace LinkReuse;

[SupportedOSPlatform("windows")]
internal sealed class NativeHost
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource<Message>> pending = new();
    private readonly SemaphoreSlim outputLock = new(1);
    private readonly SemaphoreSlim clients = new(16);
    private readonly Stream output = Console.OpenStandardOutput();
    private readonly CancellationTokenSource lifetime = new();

    internal async Task Run()
    {
        var input = Console.OpenStandardInput();
        using var greetingTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        if ((await Wire.Read(input, greetingTimeout.Token))?.Type != "hello") throw new InvalidDataException("Missing extension greeting.");
        var (browser, browserProcessId) = Browsers.ParentBrowser();
        Directory.CreateDirectory(Registration.Sessions);
        using var process = Process.GetCurrentProcess();
        var session = new Session("linkreuse-" + Guid.NewGuid().ToString("N"), browser, process.Id, process.StartTime.ToUniversalTime().Ticks, DateTime.UtcNow.Ticks, browserProcessId);
        var file = Path.Combine(Registration.Sessions, session.Pipe + ".json");
        var listener = Listen(session.Pipe);
        try
        {
            File.WriteAllText(file, JsonSerializer.Serialize(session, WireJson.Default.Session));
            await Send(new Message("ready"));
            while (await Wire.Read(input) is { } message)
            {
                if (message.Type == "result" && message.Id is not null && pending.TryRemove(message.Id, out var waiting)) waiting.TrySetResult(message);
                if (message.Type == "activity")
                {
                    session = session with { Created = DateTime.UtcNow.Ticks };
                    File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(session, WireJson.Default.Session));
                    File.Move(file + ".tmp", file, true);
                }
            }
        }
        finally
        {
            lifetime.Cancel();
            File.Delete(file);
            foreach (var waiting in pending.Values) waiting.TrySetCanceled();
            try { await listener; } catch (OperationCanceledException) { }
        }
    }

    private async Task Send(Message message)
    {
        await outputLock.WaitAsync(lifetime.Token);
        try { await Wire.Write(output, message, lifetime.Token); }
        finally { outputLock.Release(); }
    }

    private async Task Listen(string name)
    {
        while (!lifetime.IsCancellationRequested)
        {
            await clients.WaitAsync(lifetime.Token);
            var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 16, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 4096, 4096);
            try { await pipe.WaitForConnectionAsync(lifetime.Token); }
            catch { pipe.Dispose(); clients.Release(); throw; }
            _ = Serve(pipe);
        }
    }

    private async Task Serve(NamedPipeServerStream pipe)
    {
        await using (pipe)
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            string? id = null;
            try
            {
                var request = await Wire.Read(pipe, timeout.Token);
                if (request?.Type != "open" || !Program.ValidURL(request.Url)) throw new InvalidDataException("Invalid web-link request.");
                id = Guid.NewGuid().ToString("N");
                var waiting = new TaskCompletionSource<Message>(TaskCreationOptions.RunContinuationsAsynchronously);
                pending[id] = waiting;
                await Send(new Message("open", id, request.Url));
                var response = await waiting.Task.WaitAsync(timeout.Token);
                await Wire.Write(pipe, response, timeout.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or InvalidDataException)
            {
                // An accepted request may still finish; never reopen it through a second path.
            }
            finally { if (id is not null) pending.TryRemove(id, out _); clients.Release(); }
        }
    }

    internal static IEnumerable<Session> LiveSessions(string browser)
    {
        if (!Directory.Exists(Registration.Sessions)) yield break;
        foreach (var file in Directory.EnumerateFiles(Registration.Sessions, "linkreuse-*.json"))
        {
            Session? session = null;
            try
            {
                if (new FileInfo(file).Length > 4096) continue;
                session = JsonSerializer.Deserialize(File.ReadAllText(file), WireJson.Default.Session);
                if (session is null || session.Browser != browser || !session.Pipe.StartsWith("linkreuse-", StringComparison.Ordinal) ||
                    !Guid.TryParseExact(session.Pipe[10..], "N", out _)) continue;
                using var process = Process.GetProcessById(session.ProcessId);
                if (process.StartTime.ToUniversalTime().Ticks != session.Started || process.ProcessName != "LinkReuse") session = null;
            }
            catch (Exception error) when (error is IOException or JsonException or ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { session = null; }
            if (session is not null) yield return session;
        }
    }

    internal static async Task Open(string browser, string url)
    {
        var sessions = LiveSessions(browser).OrderByDescending(value => value.Created).ToArray();
        if (sessions.Length == 0)
        {
            Browsers.Launch(browser);
            for (var attempt = 0; attempt < 40 && sessions.Length == 0; attempt++)
            {
                await Task.Delay(100);
                sessions = LiveSessions(browser).OrderByDescending(value => value.Created).ToArray();
            }
        }
        if (sessions.Length == 0) throw new InvalidOperationException("The Link Reuse extension is not connected in this browser. Run link-reuse --setup, load the bundled extension, then try the link again.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        await using var pipe = new NamedPipeClientStream(".", sessions[0].Pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.ConnectAsync(1000, timeout.Token);
        AllowSetForegroundWindow((uint)sessions[0].BrowserProcessId);
        await Wire.Write(pipe, new Message("open", Url: url), timeout.Token);
        var response = await Wire.Read(pipe, timeout.Token);
        if (response is null) throw new IOException("The browser connection ended. Check whether the link opened before trying again.");
        if (response.Error is not null) throw new InvalidOperationException(response.Error);
        if (response.Type != "result" || response.Result is not ("focused" or "opened")) throw new InvalidDataException("Unexpected browser response.");
    }

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AllowSetForegroundWindow(uint processId);
}
