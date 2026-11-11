import AppKit
import SafariServices

/// The link router: receives links from other apps and hands each one to the browser's extension, one at a time.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let resources: AppResources
    private var pending: [OpenRequest] = []
    private var processing = false
    private var safari: SafariBridge?
    /// A browser being started for a link, and the wait for its extension to connect.
    private var starting: (bundleID: String, wait: Task<[BridgeSession], Error>)?

    init(resources: AppResources) { self.resources = resources }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(safariReady(_:)), name: BridgeMessage.safariReady, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(applicationTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        terminateIfUnused()
    }

    @objc private func applicationTerminated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if starting?.bundleID == app?.bundleIdentifier { starting?.wait.cancel() }
        if let safari, let browser = resources.browsers.first(where: { $0.bundleID == app?.bundleIdentifier }),
           browser.profilePath == nil {
            let quit = failure("\(browser.name) quit before Link Reuse could open the link.")
            Task { await safari.end(quit) }
        }
        if resources.browsers.contains(where: { $0.bundleID == app?.bundleIdentifier }) { terminateIfUnused() }
    }

    /// The Safari extension (re)started: reconnect now rather than on the next link.
    @objc private func safariReady(_ notification: Notification) {
        guard let safari else { return }
        Task { try? await safari.extensionReady() }
    }

    private func running(_ browser: BrowserConfiguration) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleID).first
    }

    /// The router stays while a supported browser runs or a link is in progress.
    private func terminateIfUnused() {
        let browserRunning = resources.browsers.contains { running($0) != nil }
        if shouldExitRouter(busy: processing, browserRunning: browserRunning) { NSApp.terminate(nil) }
    }

    private func launch(_ browser: BrowserConfiguration) async throws {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleID) else {
            throw CocoaError(.fileNoSuchFile)
        }
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: .init())
    }

    private func open(_ request: OpenRequest) async throws {
        let browser = request.browser, url = request.url.absoluteString
        if browser.profilePath == nil {
            // Safari's extension stalls while Safari is in the background, so bring it forward (launching it if
            // needed) before the request. When it is already in front, skip the activation round trip.
            if running(browser)?.isActive != true { try await launch(browser) }
            if safari == nil { safari = try await SafariBridge(version: resources.extensionVersion) }
            // Not connected yet: a disabled extension would never take the link, so say so rather than wait.
            if await safari?.connected != true {
                let state = try await SFSafariExtensionManager.stateOfSafariExtension(
                    withIdentifier: SafariBridge.extensionIdentifier)
                guard state.isEnabled else {
                    throw failure("Link Reuse isn’t enabled in Safari. Turn it on in Safari Settings → Extensions.")
                }
            }
            _ = try await safari?.open(url)
        } else {
            var sessions = try MacBridge.sessions(browser: browser.bundleID)
            if sessions.isEmpty {
                // Not connected yet (usually a browser that is closed or still starting): hold the link until its
                // extension connects, however long the browser takes, or until the browser quits.
                guard browser.hasExtension(resources.extensionID) else { throw failure(notLoadedIn: browser) }
                let wait = Task.detached { try await MacBridge.connectedSessions(browser: browser.bundleID) }
                starting = (browser.bundleID, wait)
                defer { starting = nil }
                try await launch(browser)
                do { sessions = try await wait.value }
                catch is CancellationError { throw failure("\(browser.name) quit before Link Reuse could connect to it.") }
            }
            guard let session = sessions.first else { throw failure(notLoadedIn: browser) }
            // The extension focuses the matching window, which brings the browser forward.
            _ = try await Task.detached { try MacBridge.send(url, session: session) }.value
        }
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func failure(notLoadedIn browser: BrowserConfiguration) -> NSError {
        failure("Link Reuse isn’t loaded in \(browser.name). On its extensions page, turn on Developer mode, choose " +
                "Load unpacked and select ~/Applications/Link Reuse.app/Contents/Resources/extension.")
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        pending.append(contentsOf: urls.compactMap { OpenRequest($0, browsers: resources.browsers) })
        guard !processing else { return }
        processing = true
        Task {
            while !pending.isEmpty {
                let request = pending.removeFirst()
                do { try await open(request) }
                catch { report(error, for: request) }
            }
            processing = false
            terminateIfUnused()
        }
    }

    /// Shows a failure (the app is otherwise invisible). Nothing retries: the link may have opened after all.
    private func report(_ error: Error, for request: OpenRequest) {
        if CommandLine.arguments.contains("--diagnostic") {
            let failure = error as NSError
            fputs("Link Reuse request failed: \(failure.domain) \(failure.code)\n", stderr)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        defer { NSApp.setActivationPolicy(.prohibited) }
        let alert = NSAlert()
        alert.messageText = "Couldn’t open the link in \(request.browser.name)"
        alert.informativeText = error.localizedDescription + " Check whether the link opened before trying again."
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
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
        let id = SafariBridge.extensionIdentifier
        let state = try await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: id)
        print(state.isEnabled ? "Safari extension is enabled." : "Safari extension is installed but not enabled.")
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
