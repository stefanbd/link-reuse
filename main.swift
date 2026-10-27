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

    init() throws {
        guard let browserID = Bundle.main.object(forInfoDictionaryKey: "ReuseBrowserBundleID") as? String,
              let name = Bundle.main.object(forInfoDictionaryKey: "ReuseBrowserName") as? String,
              let scriptURL = Bundle.main.url(forResource: "Browser", withExtension: "scpt") else {
            throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: "The app bundle is incomplete."])
        }
        bundleID = browserID
        browserName = name
        policy = try LearningPolicy.load()
        learning = LearningStore(browserID: browserID, policy: policy)
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

    func recordFailure(_ error: Error) {
        logger.error("routing failed; code=\((error as NSError).code, privacy: .public)")
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
    private let router: BrowserRouter
    private var pending: [URL] = []
    private var processing = false
    private var preferred = false
    private var handledLink = false
    private var lastUse = ContinuousClock.now
    private var exitTask: Task<Void, Never>?

    init(router: BrowserRouter) { self.router = router }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let workspace = NSWorkspace.shared
        preferred = workspace.frontmostApplication?.bundleIdentifier == router.bundleID
        workspace.notificationCenter.addObserver(self, selector: #selector(workspaceChanged(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        workspace.notificationCenter.addObserver(self, selector: #selector(workspaceChanged(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        scheduleExit()
    }

    @objc private func workspaceChanged(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              let id = app.bundleIdentifier, supportedBrowsers.contains(id) else { return }
        if notification.name == NSWorkspace.didActivateApplicationNotification {
            if preferred || id == router.bundleID { lastUse = .now }
            preferred = id == router.bundleID
        }
        if notification.name == NSWorkspace.didTerminateApplicationNotification && id == router.bundleID { handledLink = true }
        scheduleExit()
    }

    private func scheduleExit() {
        exitTask?.cancel()
        let elapsed = lastUse.duration(to: .now).components
        let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
        guard let delay = helperExitDelay(preferred: preferred, browserRunning: router.isRunning, handledLink: handledLink,
                                         busy: processing, idleFor: seconds, idleLimit: router.policy.helperIdleSeconds) else { return }
        exitTask = Task {
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard !processing else { return }
            NSApp.terminate(nil)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        pending.append(contentsOf: urls.filter { urlKey($0.absoluteString) != nil })
        lastUse = .now
        handledLink = true
        preferred = true
        exitTask?.cancel()
        guard !processing else { return }
        processing = true
        Task {
            while !pending.isEmpty {
                let url = pending.removeFirst()
                do {
                    if router.policy.allows(url.absoluteString) && router.isRunning {
                        if try !router.reuse(url) { try await router.openDirectly([url]) }
                    } else {
                        try await router.openDirectly([url])
                    }
                } catch {
                    router.recordFailure(error)
                    let alert = NSAlert()
                    alert.messageText = "Couldn’t reuse a \(router.browserName) tab"
                    alert.informativeText = error.localizedDescription
                    alert.addButton(withTitle: "Open Link Anyway")
                    alert.addButton(withTitle: "Cancel")
                    NSApp.activate()
                    if alert.runModal() == .alertFirstButtonReturn {
                        do { try await router.openDirectly([url]) }
                        catch { NSAlert(error: error).runModal() }
                    }
                }
            }
            processing = false
            scheduleExit()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@MainActor
func main() throws {
    if CommandLine.arguments.dropFirst().first?.hasPrefix("chrome-extension://") == true {
        do { try NativeHost.run(policy: LearningPolicy.load()) }
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
    let router = try BrowserRouter()
    if CommandLine.arguments.contains("--benchmark") {
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
    let delegate = AppDelegate(router: router)
    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
}

do { try main() }
catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
