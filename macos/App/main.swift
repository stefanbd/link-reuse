import AppKit

/// One browser's links, opened one at a time in the order they came; the first is the one being opened. A browser
/// that is slow to connect holds up only its own links.
@MainActor
final class Lane {
    let browser: BrowserConfiguration
    var links: [OpenRequest] = []
    var running: Task<Void, Never>?
    /// For a Chromium browser: the wait for its extension to connect, for the first link.
    var connecting: Task<[BridgeSession], Error>?
    /// While the version this one replaces still hands this browser's links over: none opens yet, and the handed-over
    /// ones (the first `inherited`) go ahead of links that came here directly.
    var held = false
    var inherited = 0

    init(_ browser: BrowserConfiguration) { self.browser = browser }
}

/// The link router: receives links from other apps and hands each one to its browser's extension.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// `serving` until an installer replaces this version. Then `retiring`: it passes no link on, the links its browsers
    /// may already be acting on finish, and every untouched one goes to the new version. Then `retired`: it ends once its
    /// messages are read.
    private enum Phase { case serving, retiring, retired }

    private let resources: AppResources
    private var lanes: [String: Lane] = [:]
    /// The connection to Safari's extension; a new one replaces it if its listener fails.
    private var safari: Task<SafariBridge, any Error>?
    private var replacement: (any DispatchSourceSignal)?
    private var alerts: [NSAlert] = []
    private var phase = Phase.serving
    /// Once retiring: the new version, which takes the untouched links.
    private var successor: Result<Successor, any Error>?
    /// While the version this one replaces hands its links over.
    private var takingOver = false

    init(resources: AppResources) {
        self.resources = resources
        super.init()
        // Started by the version this one replaces: no link opens before it is done with that browser, not even one
        // that reaches this version first.
        takingOver = CommandLine.arguments.contains(Successor.argument)
        if takingOver { for browser in resources.browsers { lane(for: browser).held = true } }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(applicationTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        replacement = onReplacement { await self.retire() }
        if takingOver { takeOver() }
        terminateIfUnused()
    }

    /// A browser quit: its links that haven't reached it end now, so a relaunch can't open them by surprise. The one it
    /// may already have ends with its connection.
    @objc private func applicationTerminated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        guard let browser = resources.browsers.first(where: { $0.bundleID == app?.bundleIdentifier }) else { return }
        if let lane = lanes[browser.id], !lane.links.isEmpty {
            let quit = failure("\(browser.name) quit before Link Reuse could open the link.")
            let sent = lane.running == nil ? 0 : 1
            let unsent = Array(lane.links.dropFirst(sent))
            if !unsent.isEmpty { report(quit, for: unsent) }
            lane.links.removeSubrange(sent...)
            lane.inherited = min(lane.inherited, lane.links.count)
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
            // One started now would miss the retirement.
            guard phase == .serving else { throw Withdrawn() }
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

    /// Ends this instance once nothing needs it: no message open, and no link waiting, hand-over under way or supported
    /// browser running; or, once retired, when its messages are read.
    private func terminateIfUnused() {
        guard alerts.isEmpty else { return }
        let unused = switch phase {
        case .serving: !takingOver && lanes.values.allSatisfy(\.links.isEmpty) &&
            !resources.browsers.contains(where: { running($0) != nil })
        case .retiring: false
        case .retired: true
        }
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
        for url in urls { receive(url) }
    }

    /// An address from another app, or one the version this one replaces handed over (`inherited`).
    private func receive(_ url: URL, inherited: Bool = false) {
        if url == BridgeMessage.safariStarted {
            // Safari's extension (re)started: send the address, so each of its contexts connects before a link. Retiring,
            // the new version does; taking over, it does once the old version is done with Safari.
            switch phase {
            case .serving:
                if !lanes.values.contains(where: { $0.held && $0.browser.profilePath == nil }) {
                    Task { try? await safariBridge().announce() }
                }
            case .retiring: Task { try? await toSuccessor(BridgeMessage(type: "open", url: url.absoluteString)) }
            case .retired: break
            }
        } else if let request = OpenRequest(url, browsers: resources.browsers) {
            accept(request, inherited: inherited)
        } else {
            alert("Couldn’t open a link", "Link Reuse received an address it doesn’t understand.")
        }
    }

    /// Queues a link behind its browser's earlier ones; a handed-over one goes ahead of those that came here directly.
    private func accept(_ request: OpenRequest, inherited: Bool = false) {
        guard phase != .retired else {
            return report(failure("Link Reuse was being updated. Open the link again."), for: [request])
        }
        let lane = lane(for: request.browser)
        guard lane.links.count < 16 else {
            return report(failure("Too many links are waiting for \(request.browser.name)."), for: [request])
        }
        if inherited, lane.held {
            lane.links.insert(request, at: lane.inherited)
            lane.inherited += 1
        } else {
            lane.links.append(request)
        }
        start(lane)
    }

    private func lane(for browser: BrowserConfiguration) -> Lane {
        if let lane = lanes[browser.id] { return lane }
        let lane = Lane(browser)
        lanes[browser.id] = lane
        return lane
    }

    private func start(_ lane: Lane) {
        if !lane.held, lane.running == nil { lane.running = Task { await run(lane) } }
    }

    private func run(_ lane: Lane) async {
        repeat {
            while let request = lane.links.first {
                do { try await open(request, in: lane) }
                // A helper an update replaced gave it back untouched: its new helper takes it.
                catch is Withdrawn where phase == .serving { continue }
                catch is Withdrawn { await handOver(request) }
                catch { report(error, for: [request]) }
                lane.links.removeFirst()
            }
            // Retiring, with none of this browser's links left here: the new version may open its links now.
            if phase == .retiring { try? await toSuccessor(BridgeMessage(type: "release", id: lane.browser.id)) }
        } while !lane.links.isEmpty
        lane.running = nil
        finishIfDone()
        terminateIfUnused()
    }

    /// Passes a link on to its browser. Once an update replaces this version it passes nothing on, so it checks again
    /// after each wait; the link then goes to the new version untouched.
    private func open(_ request: OpenRequest, in lane: Lane) async throws {
        guard phase == .serving else { throw Withdrawn() }
        let browser = request.browser, url = request.url.absoluteString
        if browser.profilePath == nil {
            // Safari's extension stalls while Safari is in the background, so bring it forward (launching it if
            // needed) before the request. When it is already in front, skip the activation round trip.
            if running(browser)?.isActive != true {
                try await show(browser)
                guard phase == .serving else { throw Withdrawn() }
            }
            _ = try await safariBridge().open(url)
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
                catch is CancellationError {
                    // The browser quit, or an update took the link back.
                    guard running(browser) != nil else {
                        throw failure("\(browser.name) quit before Link Reuse could connect to it.")
                    }
                    throw Withdrawn()
                }
            }
            guard phase == .serving else { throw Withdrawn() }
            guard let session = sessions.first else { throw notLoaded(in: browser) }
            // The extension focuses the matching window, which brings the browser forward.
            _ = try await Task.detached { try MacBridge.send(url, session: session) }.value
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

    /// An installer replaced this version: it passes no more links on, and starts the new version. Each browser's links
    /// go to it in order once the link in flight there has finished (and, if this version is itself still taking over,
    /// once the one before is done with that browser); then the new version may open them.
    private func retire() {
        guard phase == .serving else { return }
        phase = .retiring
        successor = Result {
            guard let executable = Bundle.main.executableURL else { throw CocoaError(.fileNoSuchFile) }
            return try Successor(executable)
        }
        if let safari { Task { try? await safari.value.retire() } }
        for browser in resources.browsers {
            let lane = lane(for: browser)
            lane.connecting?.cancel()
            start(lane)
        }
    }

    /// Gives an untouched link to the new version; it stays this version's until the new one has taken it.
    private func handOver(_ request: OpenRequest) async {
        do { try await toSuccessor(BridgeMessage(type: "open", url: request.envelope.absoluteString)) }
        catch { report(error, for: [request]) }
    }

    private func toSuccessor(_ message: BridgeMessage) async throws {
        guard case .success(let next)? = successor else { throw Successor.notTaken() }
        try await next.hand(message)
    }

    /// Retiring, once every browser's links are handed over: the hand-over ends, so the new version opens all it took,
    /// and this one ends once its messages are read.
    private func finishIfDone() {
        guard phase == .retiring, !takingOver, lanes.values.allSatisfy({ $0.running == nil && !$0.held }) else { return }
        phase = .retired
        if case .success(let next)? = successor { next.close() }
    }

    /// Started by the version this one replaces, with a private connection as standard input and output: each link it
    /// hands over joins its browser's lane ahead of links that came here directly, and is answered `taken`. A browser's
    /// links open once the old version is done with that browser, and all of them once the connection ends.
    private func takeOver() {
        Thread.detachNewThread {
            Successor.receive { message in DispatchQueue.main.sync { MainActor.assumeIsolated { self.handed(message) } } }
            DispatchQueue.main.async { MainActor.assumeIsolated { self.tookOver() } }
        }
    }

    private func handed(_ message: BridgeMessage) {
        if message.type == "release" {
            if let lane = lanes[message.id ?? ""] { release(lane) }
        } else if let url = message.url.flatMap(URL.init(string:)) {
            receive(url, inherited: true)
        } else {
            alert("Couldn’t open a link", "Link Reuse received an address it doesn’t understand.")
        }
    }

    private func tookOver() {
        takingOver = false
        for lane in lanes.values { release(lane) }
        finishIfDone()
        terminateIfUnused()
    }

    /// The version this one replaces is done with a browser: its links open now, the handed-over ones first. Safari's
    /// extension is sent this version's address, so it moves over at once.
    private func release(_ lane: Lane) {
        guard lane.held else { return }
        lane.held = false
        lane.inherited = 0
        if phase == .serving, lane.browser.profilePath == nil, running(lane.browser) != nil {
            Task { try? await safariBridge().announce() }
        }
        start(lane)
    }

    private func report(_ error: Error, for requests: [OpenRequest]) {
        guard let browser = requests.first?.browser else { return }
        alert(requests.count == 1 ? "Problem opening the link in \(browser.name)" :
                "Problem opening \(requests.count) links in \(browser.name)", error.localizedDescription)
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
