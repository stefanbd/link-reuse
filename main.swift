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
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(browserTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        terminateIfUnused()
    }

    @objc private func browserTerminated(_ notification: Notification) { terminateIfUnused() }

    private func terminateIfUnused() {
        let running = resources.browsers.contains { !NSRunningApplication.runningApplications(withBundleIdentifier: $0.bundleID).isEmpty }
        if shouldExitRouter(busy: processing, browserRunning: running) { NSApp.terminate(nil) }
    }

    private func open(_ request: OpenRequest) async throws {
        if request.browser.profilePath == nil {
            if let running = NSRunningApplication.runningApplications(withBundleIdentifier: request.browser.bundleID).first {
                running.activate()
            } else {
                guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.browser.bundleID) else { throw CocoaError(.fileNoSuchFile) }
                _ = try await NSWorkspace.shared.openApplication(at: app, configuration: .init())
            }
            if safari == nil { safari = try await SafariBridge(version: resources.extensionVersion) }
            _ = try await safari?.open(request.url.absoluteString)
            return
        }
        var sessions = try MacBridge.sessions(browser: request.browser.bundleID)
        if sessions.isEmpty {
            guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.browser.bundleID) else { throw CocoaError(.fileNoSuchFile) }
            _ = try await NSWorkspace.shared.openApplication(at: app, configuration: .init())
            for _ in 0..<40 where sessions.isEmpty {
                try await Task.sleep(for: .milliseconds(100))
                sessions = try MacBridge.sessions(browser: request.browser.bundleID)
            }
        }
        guard let session = sessions.first else {
            throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Load the extension from Link Reuse.app/Contents/Resources/extension, open its popup to connect, then try again."])
        }
        _ = try await Task.detached { try MacBridge.send(request.url.absoluteString, session: session) }.value
        NSRunningApplication.runningApplications(withBundleIdentifier: request.browser.bundleID).first?.activate()
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

@MainActor
func main() async throws {
    if CommandLine.arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true {
        do { try await NativeHost.run(resources: AppResources()) }
        catch { fputs("Link Reuse browser bridge stopped; no URL data was logged.\n", stderr); exit(1) }
        return
    }
    if CommandLine.arguments.contains("--self-test") {
        for value in ["https://example.test/", "http://localhost:1234/"] { precondition(isWebLink(value)) }
        for value in ["file:///tmp/test", "javascript:alert(1)"] { precondition(!isWebLink(value)) }
        print("Native web-link validation checks passed")
        return
    }
    if CommandLine.arguments.contains("--install") {
        try AppResources().installNativeMessaging()
        print("Registered the Link Reuse native bridge for supported browsers. Load the bundled extension in each browser profile.")
        return
    }
    if CommandLine.arguments.contains("--safari-status") {
        let state = try await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: SafariBridge.extensionIdentifier)
        print(state.isEnabled ? "Safari extension is enabled." : "Safari extension is installed but not enabled.")
        return
    }
    let application = NSApplication.shared
    let delegate = AppDelegate(resources: try AppResources())
    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}

do { try await main() }
catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
