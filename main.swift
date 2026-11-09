import AppKit
import SafariServices

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let resources: AppResources
    private var pending: [OpenRequest] = []
    private var processing = false
    private var safari: SafariBridge?

    init(resources: AppResources) { self.resources = resources }

    func applicationDidFinishLaunching(_ notification: Notification) {
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(safariReady(_:)), name: BridgeMessage.safariReady, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(applicationTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        terminateIfUnused()
    }

    @objc private func applicationTerminated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        if resources.browsers.contains(where: { $0.bundleID == app?.bundleIdentifier }) { terminateIfUnused() }
    }

    /// The extension (re)started: re-establish the warm channel now rather than on the next link.
    @objc private func safariReady(_ notification: Notification) {
        guard let safari else { return }
        Task { try? await safari.extensionReady() }
    }

    private func running(_ browser: BrowserConfiguration) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleID).first
    }

    private func terminateIfUnused() {
        if shouldExitRouter(busy: processing, browserRunning: resources.browsers.contains { running($0) != nil }) { NSApp.terminate(nil) }
    }

    private func launch(_ browser: BrowserConfiguration) async throws {
        guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleID) else { throw CocoaError(.fileNoSuchFile) }
        _ = try await NSWorkspace.shared.openApplication(at: app, configuration: .init())
    }

    private func open(_ request: OpenRequest) async throws {
        let browser = request.browser, url = request.url.absoluteString
        if browser.profilePath == nil {
            // Bring Safari forward (launching it if needed) before the request. With Safari left in the background,
            // its main thread and therefore the extension stalled for 10 s in testing. Already in front, it needs no
            // activation round trip competing with the extension for Safari's main thread.
            if running(browser)?.isActive != true { try await launch(browser) }
            if safari == nil { safari = try await SafariBridge(version: resources.extensionVersion) }
            _ = try await safari?.open(url)
        } else {
            var sessions = try MacBridge.sessions(browser: browser.bundleID)
            if sessions.isEmpty {
                try await launch(browser)
                for _ in 0..<40 where sessions.isEmpty {
                    try await Task.sleep(for: .milliseconds(100))
                    sessions = try MacBridge.sessions(browser: browser.bundleID)
                }
            }
            guard let session = sessions.first else {
                throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    "Load the extension from Link Reuse.app/Contents/Resources/extension, open its popup to connect, then try again."])
            }
            // The extension focuses the matching window, which brings the browser forward.
            _ = try await Task.detached { try MacBridge.send(url, session: session) }.value
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        pending.append(contentsOf: urls.compactMap { OpenRequest($0, browsers: resources.browsers) })
        guard !processing else { return }
        processing = true
        Task {
            while !pending.isEmpty {
                let request = pending.removeFirst()
                do { try await open(request) }
                catch {
                    if CommandLine.arguments.contains("--diagnostic") {
                        let failure = error as NSError
                        fputs("Link Reuse request failed: \(failure.domain) \(failure.code)\n", stderr)
                        continue
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
            }
            processing = false
            terminateIfUnused()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

/// Runs a command-line mode to completion. Only these modes are async: AppKit must start from synchronous
/// top-level code, because inside an async main the main queue never drains and NSWorkspace reports no
/// running applications (which made the router quit whenever any app quit).
func runCommand(failure: String? = nil, _ body: @escaping @Sendable () async throws -> Void) -> Never {
    Task {
        do { try await body(); exit(0) }
        catch { fputs((failure ?? error.localizedDescription) + "\n", stderr); exit(1) }
    }
    dispatchMain()
}

let arguments = CommandLine.arguments
if arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true {
    runCommand(failure: "Link Reuse browser bridge stopped; no URL data was logged.") { try await NativeHost.run(resources: AppResources()) }
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
        print("Registered the Link Reuse native bridge for supported browsers. Load the bundled extension in each browser profile.")
    }
}
if arguments.contains("--safari-status") {
    runCommand {
        let state = try await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: SafariBridge.extensionIdentifier)
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
