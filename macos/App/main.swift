import AppKit
import Synchronization

/// Whether a link has been passed to its browser: written to a Chromium host, or given the go-ahead Safari's extension
/// asks for. Passing it and handing it to a replacing instance race; whichever comes first wins, so a link is never
/// both opened here and handed on.
final class Passing: Sendable {
    private let state = Mutex<Bool?>(nil)
    func pass() -> Bool { state.withLock { if $0 == nil { $0 = true }; return $0 == true } }
    func handOver() -> Bool { state.withLock { if $0 == nil { $0 = false }; return $0 == false } }
    var passed: Bool { state.withLock { $0 == true } }
}

/// One browser's links, opened one at a time in the order they came; the first is the one being opened. A browser
/// that is slow to connect holds up only its own links.
@MainActor
final class Lane {
    var links: [OpenRequest] = []
    var passing = Passing()
    var running: Task<Void, Never>?
    /// For a Chromium browser: the wait for its extension to connect, for the first link.
    var connecting: Task<[BridgeSession], Error>?
}

/// A link a replaced instance hands to the one that replaces it: to open there or, if it may have opened, to report.
struct Handed: Codable {
    let browser: String
    let url: String
    let uncertain: Bool
}

/// The link router: receives links from other apps and hands each one to its browser's extension.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let resources: AppResources
    private var lanes: [String: Lane] = [:]
    /// The connection to Safari's extension; a new one replaces it if its listener fails.
    private var safari: Task<SafariBridge, any Error>?
    private var watchers: [any DispatchSourceProtocol] = []
    private var alerts: [NSAlert] = []
    /// An installer replaced this version: it takes no more links, and ends once it has handed on what it held.
    private var retiring = false
    private var handedOver = false

    init(resources: AppResources) { self.resources = resources }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(applicationTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        watchers.append(onReplacement { await self.retire() })
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--take-over"), arguments.indices.contains(index + 1) {
            takeOver(URL(filePath: arguments[index + 1]))
        }
        terminateIfUnused()
    }

    /// A browser quit: its links that haven't reached it end now, so a relaunch can't open them by surprise. The one it
    /// may already have ends with its connection.
    @objc private func applicationTerminated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        guard let browser = resources.browsers.first(where: { $0.bundleID == app?.bundleIdentifier }) else { return }
        if let lane = lanes[browser.id], !lane.links.isEmpty {
            let quit = failure("\(browser.name) quit before Link Reuse could open the link.")
            let unsent = Array(lane.links.dropFirst())
            if !unsent.isEmpty { report(quit, for: unsent, uncertain: false) }
            lane.links.removeSubrange(1...)
            lane.connecting?.cancel()
            if browser.profilePath == nil, let safari { Task { try? await safari.value.end(quit) } }
        }
        terminateIfUnused()
    }

    private func safariBridge() async throws -> SafariBridge {
        let current = safari
        if let current, let bridge = try? await current.value, await !bridge.ended { return bridge }
        let making: Task<SafariBridge, any Error>
        if let newer = safari, newer != current { making = newer }
        else {
            making = Task { try await SafariBridge(version: resources.extensionVersion) }
            safari = making
        }
        do { return try await making.value }
        catch {
            if safari == making { safari = nil }
            throw error
        }
    }

    private func running(_ browser: BrowserConfiguration) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleID).first
    }

    /// Ends this instance once nothing needs it: no link waiting, no message open and no supported browser running; or,
    /// once replaced, when what it held is handed on and its messages are read.
    private func terminateIfUnused() {
        guard alerts.isEmpty else { return }
        let unused = retiring ? handedOver :
            lanes.values.allSatisfy(\.links.isEmpty) && !resources.browsers.contains(where: { running($0) != nil })
        if unused { NSApp.terminate(nil) }
    }

    /// Brings the browser forward, starting it if it isn't running.
    private func show(_ browser: BrowserConfiguration) async throws {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleID) else {
            throw CocoaError(.fileNoSuchFile)
        }
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: .init())
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if url == BridgeMessage.safariStarted {
                // Safari's extension (re)started: send the address, so each of its contexts connects before a link.
                if !retiring { Task { try? await safariBridge().announce() } }
            } else if let request = OpenRequest(url, browsers: resources.browsers) {
                accept(request)
            } else {
                alert("Couldn’t open a link", "Link Reuse received an address it doesn’t understand.")
            }
        }
    }

    /// Queues a link behind its browser's earlier ones.
    private func accept(_ request: OpenRequest) {
        guard !retiring else {
            return report(failure("Link Reuse was being updated. Open the link again."), for: [request], uncertain: false)
        }
        let lane = lanes[request.browser.id] ?? Lane()
        lanes[request.browser.id] = lane
        guard lane.links.count < 16 else {
            return report(failure("Too many links are waiting for \(request.browser.name)."), for: [request], uncertain: false)
        }
        lane.links.append(request)
        if lane.running == nil { lane.running = Task { await run(lane) } }
    }

    private func run(_ lane: Lane) async {
        while !retiring, let request = lane.links.first {
            do { try await open(request, in: lane) }
            catch { if !retiring { report(error, for: [request], uncertain: lane.passing.passed) } }
            if retiring { break }
            lane.links.removeFirst()
            lane.passing = Passing()
        }
        lane.running = nil
        terminateIfUnused()
    }

    private func open(_ request: OpenRequest, in lane: Lane) async throws {
        let browser = request.browser, url = request.url.absoluteString, passing = lane.passing
        if browser.profilePath == nil {
            // Safari's extension stalls while Safari is in the background, so bring it forward (launching it if
            // needed) before the request. When it is already in front, skip the activation round trip.
            if running(browser)?.isActive != true { try await show(browser) }
            _ = try await safariBridge().open(url) { passing.pass() }
        } else {
            var sessions = try MacBridge.sessions(browser: browser.bundleID)
            if sessions.isEmpty {
                // Not connected yet (usually a browser that is closed or still starting): hold the link until its
                // extension connects, however long the browser takes, or until the browser quits.
                guard resources.registered(in: browser) else { throw notRegistered(in: browser) }
                guard browser.hasExtension(resources.extensionID) else { throw notLoaded(in: browser) }
                let connecting = Task.detached { try await MacBridge.connectedSessions(browser: browser.bundleID) }
                lane.connecting = connecting
                defer {
                    connecting.cancel()
                    lane.connecting = nil
                }
                try await show(browser)
                do { sessions = try await connecting.value }
                catch is CancellationError { throw failure("\(browser.name) quit before Link Reuse could connect to it.") }
            }
            guard let session = sessions.first else { throw notLoaded(in: browser) }
            // The extension focuses the matching window, which brings the browser forward.
            _ = try await Task.detached { try MacBridge.send(url, session: session) { passing.pass() } }.value
        }
    }

    private func notLoaded(in browser: BrowserConfiguration) -> NSError {
        failure("Link Reuse isn’t loaded in \(browser.name). On its extensions page, turn on Developer mode, choose " +
                "Load unpacked and select ~/Applications/Link Reuse.app/Contents/Resources/extension.")
    }

    private func notRegistered(in browser: BrowserConfiguration) -> NSError {
        failure("\(browser.name) can’t start Link Reuse: it isn’t registered there. Run “~/Applications/Link Reuse.app/" +
                "Contents/MacOS/LinkReuse” --install, then open the link again.")
    }

    /// An installer replaced this version: each link it holds goes to one new instance of the installed app, in order.
    /// A link not yet passed to its browser opens there; one that may have been is reported there, never opened twice.
    private func retire() {
        guard !retiring else { return }
        retiring = true
        var handed: [Handed] = []
        for lane in lanes.values {
            lane.connecting?.cancel()
            for (index, request) in lane.links.enumerated() {
                handed.append(Handed(browser: request.browser.id, url: request.url.absoluteString,
                                     uncertain: index == 0 && !lane.passing.handOver()))
            }
            lane.links.removeAll()
        }
        let safari = safari
        Task {
            // Safari's extension connects to the new instance at once.
            if let safari { try? await safari.value.replaced() }
            await handOver(handed)
        }
    }

    /// Starts the successor with the links in a private file, and ends once it has taken them (it removes the file) or
    /// can't (it ends first, or never starts): then the links are listed for the user, never passed on again.
    private func handOver(_ handed: [Handed]) async {
        guard !handed.isEmpty else { return settle(nil, handed) }
        let file = MacBridge.directory.appending(path: UUID().uuidString + ".handover")
        do {
            try MacBridge.prepare()
            try JSONEncoder().encode(handed).write(to: file)
            let descriptor = Darwin.open(file.path, O_EVTONLY)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let taken = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: .delete, queue: .main)
            taken.setEventHandler { MainActor.assumeIsolated { self.settle(file, handed) } }
            taken.setCancelHandler { close(descriptor) }
            taken.activate()
            watchers.append(taken)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            configuration.activates = false
            configuration.addsToRecentItems = false
            configuration.arguments = ["--take-over", file.path]
            let successor = try await NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration)
            let pid = successor.processIdentifier
            let ended = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
            ended.setEventHandler { MainActor.assumeIsolated { self.settle(file, handed) } }
            ended.activate()
            watchers.append(ended)
            // Signal 0 sends nothing: it asks whether the successor still exists, in case it ended before the watch.
            if kill(pid, 0) != 0 { settle(file, handed) }
        } catch { settle(file, handed) }
    }

    private func settle(_ file: URL?, _ handed: [Handed]) {
        guard !handedOver else { return }
        handedOver = true
        if let file, FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.removeItem(at: file)
            alert("Link Reuse was updated while links were waiting",
                  "The new version couldn’t take them. Check whether these opened before opening them again:\n" +
                  handed.map(\.url).joined(separator: "\n"))
        }
        terminateIfUnused()
    }

    /// Takes the links a replaced instance handed over, then removes their file, which tells it they are taken.
    private func takeOver(_ file: URL) {
        guard file.deletingLastPathComponent().path == MacBridge.directory.path, file.pathExtension == "handover" else { return }
        defer { try? FileManager.default.removeItem(at: file) }
        guard let data = try? Data(contentsOf: file), let handed = try? JSONDecoder().decode([Handed].self, from: data) else {
            return alert("Link Reuse was updated while links were waiting", "It couldn’t take them over. Check whether they opened.")
        }
        for item in handed {
            guard let browser = resources.browsers.first(where: { $0.id == item.browser }), isWebLink(item.url),
                  let url = URL(string: item.url) else {
                alert("Couldn’t open a link", "Link Reuse was updated while \(item.url) waited, and can no longer open it.")
                continue
            }
            let request = OpenRequest(browser: browser, url: url)
            if item.uncertain { report(failure("Link Reuse was updated while opening it."), for: [request], uncertain: true) }
            else { accept(request) }
        }
    }

    private func report(_ error: Error, for requests: [OpenRequest], uncertain: Bool) {
        guard let browser = requests.first?.browser else { return }
        alert(requests.count == 1 ? "Couldn’t open the link in \(browser.name)" :
                "Couldn’t open \(requests.count) links in \(browser.name)",
              error.localizedDescription + (uncertain ? " Check whether the link opened before trying again." : ""))
    }

    /// Shows a message without holding anything up. The app, otherwise invisible, shows itself while one is open.
    private func alert(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        let button = alert.addButton(withTitle: "OK")
        button.target = self
        button.action = #selector(dismiss(_:))
        alerts.append(alert)
        NSApp.setActivationPolicy(.accessory)
        alert.layout()
        alert.window.center()
        alert.window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    @objc private func dismiss(_ sender: NSButton) {
        alerts.removeAll { $0.window == sender.window }
        sender.window?.orderOut(nil)
        if alerts.isEmpty { NSApp.setActivationPolicy(.prohibited) }
        terminateIfUnused()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// Runs a command-line mode to completion. AppKit itself must start from synchronous top-level code: inside an async
/// main the main queue never drains, and NSWorkspace then reports no running applications.
func runCommand(failure: String? = nil, _ body: @escaping @Sendable () async throws -> Void) -> Never {
    Task {
        do { try await body(); exit(0) }
        catch { fputs((failure ?? error.localizedDescription) + "\n", stderr); exit(1) }
    }
    dispatchMain()
}

/// An installer replacing this version signals each process still running it with SIGUSR1: each hands over what it
/// holds, then ends. SIGTERM keeps its default meaning (logout, shutdown): end now.
func onReplacement(_ handOver: @escaping @Sendable () async -> Void) -> any DispatchSourceSignal {
    signal(SIGUSR1, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGUSR1)
    source.setEventHandler { Task { await handOver() } }
    source.activate()
    return source
}

let arguments = CommandLine.arguments

// Started by a Chromium browser as its native messaging host.
if arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true {
    runCommand(failure: "Link Reuse browser bridge stopped; no URL data was logged.") {
        try await NativeHost.run(resources: AppResources())
    }
}
if arguments.contains("--self-test") {
    for value in ["https://example.test/", "http://localhost:1234/"] { precondition(isWebLink(value)) }
    for value in ["file:///tmp/test", "javascript:alert(1)"] { precondition(!isWebLink(value)) }
    print("Native web-link validation checks passed")
    exit(0)
}
if arguments.contains("--install") {
    runCommand {
        try AppResources().installNativeMessaging()
        print("Registered the Link Reuse native bridge for supported browsers. " +
              "Load the bundled extension in each browser profile.")
    }
}
if arguments.contains("--safari-status") {
    runCommand {
        let enabled = try await SafariBridge.extensionEnabled()
        print(enabled ? "Safari extension is enabled." : "Safari extension is installed but not enabled.")
    }
}

do {
    let delegate = AppDelegate(resources: try AppResources())
    NSApplication.shared.delegate = delegate
    withExtendedLifetime(delegate) { NSApplication.shared.run() }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
