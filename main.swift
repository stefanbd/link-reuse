import AppKit
import Carbon
import OSLog

@MainActor
final class BrowserRouter {
    let bundleID: String
    let browserName: String
    private let script: NSAppleScript
    private let logger = Logger(subsystem: "me.dichev.LinkReuse", category: "routing")
    let policy: LearningPolicy
    private let learning: LearningStore

    init(browser: BrowserConfiguration, resources: AppResources) throws {
        bundleID = browser.bundleID
        browserName = browser.name
        policy = resources.policy
        learning = LearningStore(browserID: browser.bundleID, policy: policy)
        let scriptURL = resources.directory.appending(path: "\(browser.id).scpt")
        var error: NSDictionary?
        guard let loaded = NSAppleScript(contentsOf: scriptURL, error: &error) else {
            throw Self.scriptError(error)
        }
        script = loaded
    }

    var isRunning: Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
    }

    func call(_ handler: String, _ arguments: [NSAppleEventDescriptor] = []) throws -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(
            eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent),
            targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID),
            transactionID: AETransactionID(kAnyTransactionID)
        )
        event.setParam(NSAppleEventDescriptor(string: handler), forKeyword: AEKeyword(keyASSubroutineName))
        let list = NSAppleEventDescriptor.list()
        for (index, argument) in arguments.enumerated() { list.insert(argument, at: index + 1) }
        event.setParam(list, forKeyword: AEKeyword(keyDirectObject))
        var error: NSDictionary?
        let result = script.executeAppleEvent(event, error: &error)
        if let error { throw Self.scriptError(error) }
        return result
    }

    private static func scriptError(_ error: NSDictionary?) -> NSError {
        let code = (error?[NSAppleScript.errorNumber] as? Int) ?? -1
        let message = code == -1743
            ? "Allow this app to control the browser in System Settings → Privacy & Security → Automation."
            : "The browser did not complete the tab operation (error \(code))."
        return NSError(domain: "LinkReuse", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }

    func match(_ url: String, in snapshot: NSAppleEventDescriptor) -> String? {
        guard let key = urlKey(url) else { return nil }
        return tabURLs(in: snapshot).first { urlKey($0) == key }
    }

    private func tabURLs(in snapshot: NSAppleEventDescriptor) -> [String] {
        var urls: [String] = []
        func collect(_ item: NSAppleEventDescriptor) {
            if item.numberOfItems > 0 {
                for index in 1...item.numberOfItems {
                    if let child = item.atIndex(index) { collect(child) }
                }
            } else if let value = item.stringValue { urls.append(value) }
        }
        collect(snapshot)
        return urls
    }

    private func relatedMatch(_ url: String, in snapshot: NSAppleEventDescriptor) -> String? {
        let preferred = snapshot.atIndex(1)?.stringValue
        if let preferred, urlKey(preferred) == urlKey(url) { return preferred }
        let urls = tabURLs(in: snapshot).filter(policy.allows)
        let relationships = (try? learning.relationships()) ?? [:]
        return matchingResourceURL(url, openURLs: urls, relationships: relationships, preferredURL: preferred)
    }

    func reuse(_ url: URL) throws -> Bool {
        let start = ContinuousClock.now
        let snapshot = try call("snapshot")
        if let existingURL = relatedMatch(url.absoluteString, in: snapshot),
           try call("focustab", [NSAppleEventDescriptor(string: existingURL)]).booleanValue {
            logger.info("reused; duration=\(String(describing: start.duration(to: .now)), privacy: .public)")
            return true
        }
        logger.info("no-match; duration=\(String(describing: start.duration(to: .now)), privacy: .public)")
        return false
    }

    func openDirectly(_ urls: [URL]) async throws {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            throw NSError(domain: "LinkReuse", code: 2, userInfo: [NSLocalizedDescriptionKey: "\(browserName) is not installed."])
        }
        _ = try await NSWorkspace.shared.open(urls, withApplicationAt: appURL, configuration: .init())
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let resources: AppResources
    private var routers: [String: BrowserRouter] = [:]
    private var pending: [OpenRequest] = []
    private var processing = false

    init(resources: AppResources) { self.resources = resources }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(browserTerminated(_:)),
            name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        terminateIfUnused()
    }

    @objc private func browserTerminated(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              resources.browsers.contains(where: { $0.bundleID == app.bundleIdentifier }) else { return }
        terminateIfUnused()
    }

    private func terminateIfUnused() {
        let running = resources.browsers.contains { !NSRunningApplication.runningApplications(withBundleIdentifier: $0.bundleID).isEmpty }
        if shouldExitRouter(busy: processing, browserRunning: running) { NSApp.terminate(nil) }
    }

    private func router(for browser: BrowserConfiguration) throws -> BrowserRouter {
        if let router = routers[browser.id] { return router }
        let router = try BrowserRouter(browser: browser, resources: resources)
        routers[browser.id] = router
        return router
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        pending.append(contentsOf: urls.compactMap { OpenRequest($0, browsers: resources.browsers) })
        guard !processing else { return }
        processing = true
        Task {
            while !pending.isEmpty {
                let request = pending.removeFirst()
                do {
                    let router = try router(for: request.browser)
                    if router.policy.allows(request.url.absoluteString) && router.isRunning {
                        if try !router.reuse(request.url) { try await router.openDirectly([request.url]) }
                    } else {
                        try await router.openDirectly([request.url])
                    }
                } catch {
                    let alert = NSAlert()
                    alert.messageText = "Couldn’t reuse a \(request.browser.name) tab"
                    alert.informativeText = error.localizedDescription
                    alert.addButton(withTitle: "Open Link Anyway")
                    alert.addButton(withTitle: "Cancel")
                    NSApp.activate()
                    if alert.runModal() == .alertFirstButtonReturn {
                        do {
                            guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: request.browser.bundleID) else {
                                throw CocoaError(.fileNoSuchFile)
                            }
                            _ = try await NSWorkspace.shared.open([request.url], withApplicationAt: app, configuration: .init())
                        } catch { NSAlert(error: error).runModal() }
                    }
                }
            }
            processing = false
            terminateIfUnused()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@MainActor
func main() throws {
    if CommandLine.arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true {
        do { try NativeHost.run(resources: AppResources()) }
        catch { fputs("Link Reuse recorder stopped; no URL data was logged.\n", stderr); exit(1) }
        return
    }
    if CommandLine.arguments.contains("--self-test") {
        let cases: [(String, String, Bool)] = [
            ("https://example.com", "https://example.com/", true),
            ("HTTPS://EXAMPLE.COM:443/", "https://example.com/", true),
            ("http://example.com:80", "http://example.com/", true),
            ("https://example.com/A", "https://example.com/a", false),
            ("https://example.com/?a=1", "https://example.com/?a=2", false),
            ("https://example.com/#one", "https://example.com/#two", false),
            ("https://example.com/a", "https://example.com/a/", false),
            ("https://example.com/a%2Fb", "https://example.com/a/b", false),
            ("http://example.com/", "https://example.com/", false)
        ]
        for (lhs, rhs, equal) in cases { precondition((urlKey(lhs) == urlKey(rhs)) == equal) }
        precondition(urlKey("javascript:alert(1)") == nil)
        precondition(urlKey("file:///tmp/a") == nil)
        print("11 URL matching checks passed")
        return
    }
    let resources = try AppResources()
    if let index = CommandLine.arguments.firstIndex(of: "--benchmark") {
        guard CommandLine.arguments.indices.contains(index + 1),
              let browser = resources.browsers.first(where: { $0.id == CommandLine.arguments[index + 1] }) else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        let router = try BrowserRouter(browser: browser, resources: resources)
        guard router.isRunning else { print("Browser is not running"); return }
        var timings: [Double] = []
        for _ in 0..<20 {
            let start = ContinuousClock.now
            let snapshot = try router.call("snapshot")
            _ = router.match("https://link-reuse-benchmark.invalid/", in: snapshot)
            let duration = start.duration(to: .now).components
            timings.append(Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15)
        }
        timings.sort()
        print("20 batched lookups: median \(timings[10]) ms; maximum \(timings.last!) ms")
        return
    }
    let application = NSApplication.shared
    let delegate = AppDelegate(resources: resources)
    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}

do { try main() }
catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
