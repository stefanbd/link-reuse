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
    /// Links the extension was given the go-ahead for: each once, so a link is never acted on twice.
    private readonly ConcurrentDictionary<string, bool> granted = new();
    private readonly SemaphoreSlim outputLock = new(1);
    private readonly SemaphoreSlim clients = new(16);
    private readonly Stream output = Console.OpenStandardOutput();
    private readonly CancellationTokenSource lifetime = new();

    internal async Task Run()
    {
        var input = Console.OpenStandardInput();
        // The extension greets as soon as it connects; the browser closing the input ends the wait otherwise.
        if (await Wire.Read(input) is not { Type: "hello" } hello) throw new InvalidDataException("Missing extension greeting.");
        // Always the version this app bundles: an extension of another version loads it, and this connection, which
        // routes nothing, ends with it.
        var version = Registration.ExtensionVersion();
        await Send(new Message("ready", ExtensionVersion: version));
        if (hello.ExtensionVersion != version)
        {
            while (await Wire.Read(input) is not null) { }
            return;
        }
        var (browser, browserProcessId) = Browsers.ParentBrowser();
        Directory.CreateDirectory(Registration.Sessions);
        using var process = Process.GetCurrentProcess();
        // Links go to the profile focused last; connecting isn't focus.
        var session = new Session("linkreuse-" + Guid.NewGuid().ToString("N"), browser, process.Id, process.StartTime.ToUniversalTime().Ticks,
            hello.Focused == true ? DateTime.UtcNow.Ticks : 0, browserProcessId);
        var file = Path.Combine(Registration.Sessions, session.Pipe + ".json");
        // An installer replacing this helper sets the event named after its session: tell the extension, so it connects
        // to the new helper at once, and end.
        var replaced = new EventWaitHandle(false, EventResetMode.ManualReset, session.Pipe);
        _ = Task.Run(async () =>
        {
            replaced.WaitOne();
            try { await Send(new Message("replaced")); }
            catch (Exception error) when (error is IOException or OperationCanceledException) { }
            Forget(file);
            Environment.Exit(0);
        });
        var listener = Listen(session.Pipe);
        try
        {
            Save(file, session);
            // The helper serves while both its extension and its listener do: either ending ends it.
            await await Task.WhenAny(Receive(input, file, session), listener);
        }
        finally
        {
            lifetime.Cancel();
            Forget(file);
            foreach (var waiting in pending.Values) waiting.TrySetCanceled();
            try { await listener; } catch { }
        }
    }

    private async Task Receive(Stream input, string file, Session session)
    {
        while (await Wire.Read(input, lifetime.Token) is { } message)
        {
            switch (message.Type)
            {
                case "result" when message.Id is not null && pending.TryRemove(message.Id, out var waiting):
                    waiting.TrySetResult(message);
                    break;
                case "authorize-create" when message.Id is not null:
                    var allowed = pending.ContainsKey(message.Id) && granted.TryAdd(message.Id, true);
                    await Send(new Message("create-authorized", message.Id, Error: allowed ? null : "The external request is no longer available."));
                    break;
                case "activity":
                    // Best effort: if the write fails, the last focus stands.
                    session = session with { ActiveAt = DateTime.UtcNow.Ticks };
                    try { Save(file, session); }
                    catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
                    break;
            }
        }
    }

    private static void Save(string file, Session session)
    {
        File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(session, WireJson.Default.Session));
        File.Move(file + ".tmp", file, true);
    }

    /// Unpublishes the session; a failure here can't keep the helper from ending.
    private static void Forget(string file)
    {
        try { File.Delete(file); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
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

    /// One link: it ends with the extension's answer, or when the router or this helper goes away. Its connection is
    /// closed before its place is freed, so there are never more than 16.
    private async Task Serve(NamedPipeServerStream pipe)
    {
        string? id = null;
        await using (pipe)
        {
            try
            {
                var request = await Wire.Read(pipe, lifetime.Token);
                if (request?.Type != "open" || !Program.ValidURL(request.Url)) throw new InvalidDataException("Invalid web-link request.");
                id = Guid.NewGuid().ToString("N");
                var waiting = new TaskCompletionSource<Message>(TaskCreationOptions.RunContinuationsAsynchronously);
                pending[id] = waiting;
                await Send(new Message("open", id, request.Url));
                var response = await waiting.Task;
                await Wire.Write(pipe, response, lifetime.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or InvalidDataException)
            {
                // An accepted request may still finish; never reopen it through a second path.
            }
        }
        if (id is not null) { pending.TryRemove(id, out _); granted.TryRemove(id, out _); }
        clients.Release();
    }

    /// The browser's connected profiles. Routing uses only helpers running the registered one (`current`), as on the Mac:
    /// a link that waits while an update lands reaches the new version's helper, and one an update left behind gets none.
    /// An installer stops the rest.
    internal static IEnumerable<Session> LiveSessions(string browser, bool current = true)
    {
        var host = current ? Registration.RegisteredHost(browser) : null;
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
                if (process.StartTime.ToUniversalTime().Ticks != session.Started || process.ProcessName != "LinkReuse" ||
                    host is not null && !string.Equals(process.MainModule?.FileName, host, StringComparison.OrdinalIgnoreCase)) session = null;
            }
            catch (Exception error) when (error is IOException or JsonException or ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { session = null; }
            if (session is not null) yield return session;
        }
    }

    /// The profile focused last; among profiles never focused, the one whose helper started first.
    private static Session? Newest(string browser) => LiveSessions(browser).OrderByDescending(value => value.ActiveAt)
        .ThenBy(value => value.Started).FirstOrDefault();

    /// Brings the browser forward (starting it only when it has no window) and waits for its extension to connect, however
    /// long the browser takes, or until it quits.
    private static async Task<Session> Connected(string browser)
    {
        if (!Browsers.HasExtension(browser, new Uri(Registration.Origin()).Host)) throw new InvalidOperationException("Link Reuse isn't loaded in this browser. Run link-reuse --setup, load the bundled extension, then try the link again.");
        Directory.CreateDirectory(Registration.Sessions);
        var changed = new SemaphoreSlim(0);
        using var sessions = new FileSystemWatcher(Registration.Sessions, "linkreuse-*.json") { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite };
        sessions.Created += (_, _) => changed.Release();
        sessions.Changed += (_, _) => changed.Release();
        sessions.Renamed += (_, _) => changed.Release();
        sessions.Error += (_, _) => changed.Release();
        sessions.EnableRaisingEvents = true;
        Browsers.Show(browser);
        var quit = Browsers.Quit(browser);
        // Checked after the watch starts, so a session that connects in between is never missed.
        while (true)
        {
            if (Newest(browser) is { } session) return session;
            if (await Task.WhenAny(changed.WaitAsync(), quit) == quit) throw new InvalidOperationException("The browser quit before Link Reuse could connect to it.");
        }
    }

    internal static async Task Open(string browser, string url)
    {
        var session = Newest(browser) ?? await Connected(browser);
        const string ended = "The browser connection ended before the link was sent. Please open it again.";
        Process host;
        try { host = Process.GetProcessById(session.ProcessId); }
        catch (ArgumentException) { throw new IOException(ended); }
        using (host)
        {
            await using var pipe = new NamedPipeClientStream(".", session.Pipe, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            using var stop = new CancellationTokenSource();
            // A free connection, however long the helper stays busy, unless the helper ends first.
            var connecting = pipe.ConnectAsync(stop.Token);
            if (await Task.WhenAny(connecting, host.WaitForExitAsync()) != connecting)
            {
                stop.Cancel();
                throw new IOException(ended);
            }
            await connecting;
            AllowSetForegroundWindow((uint)session.BrowserProcessId);
            await Wire.Write(pipe, new Message("open", Url: url));
            // The answer, or the end of the connection when the helper or its browser goes away.
            var response = await Wire.Read(pipe);
            if (response is null) throw new IOException("The browser connection ended. Check whether the link opened before trying again.");
            if (response.Error is not null) throw new InvalidOperationException(response.Error);
            if (response.Type != "result" || response.Result is not ("focused" or "opened")) throw new InvalidDataException("Unexpected browser response.");
        }
    }

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AllowSetForegroundWindow(uint processId);
}
