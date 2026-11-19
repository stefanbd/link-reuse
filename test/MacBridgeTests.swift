import Foundation
import Darwin

func check(_ value: Bool) { precondition(value) }

@main
struct MacBridgeTests {
    static func main() async throws {
        // A second copy of this executable, standing in for another profile's host: it runs until its input ends.
        if CommandLine.arguments.contains("--wait") {
            _ = FileHandle.standardInput.readDataToEndOfFile()
            exit(0)
        }
        // A second copy standing in for the new version an update hands links to: it takes them in order.
        if CommandLine.arguments.contains(Successor.argument) {
            if ProcessInfo.processInfo.environment["LINK_REUSE_TEST_UNREADY"] != nil { exit(0) }
            var next = 1
            Successor.receive { message in
                if message.url == "https://example.test/vanish" { exit(0) }
                precondition(message.url == "https://example.test/\(next)")
                next += 1
            }
            exit(0)
        }
        try MacBridge.prepare()
        guard let started = MacBridge.processStarted(getpid()) else { throw POSIXError(.EPERM) }
        let session = BridgeSession(id: UUID().uuidString, browser: "test.link-reuse", pid: getpid(), started: started, activeAt: 1)
        let newer = BridgeSession(id: UUID().uuidString, browser: "test.link-reuse", pid: getpid(), started: started, activeAt: 2)
        defer {
            for file in [session.socket, session.file, newer.file] { try? FileManager.default.removeItem(at: file) }
        }
        try session.save()
        try newer.save()
        let host = URL(filePath: CommandLine.arguments[0])
        let live = try MacBridge.sessions(browser: session.browser, host: host)
        precondition(live.map(\.id) == [newer.id, session.id])
        check(try MacBridge.sessions(browser: "other", host: host).isEmpty)
        let attributes = try FileManager.default.attributesOfItem(atPath: session.file.path)
        precondition((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        check(!(try String(contentsOf: session.file, encoding: .utf8)).contains("https://"))

        let descriptor = try MacBridge.descriptor(path: session.socket, listen: true)
        defer { close(descriptor) }
        let server = Task.detached {
            let client = accept(descriptor, nil, nil)
            precondition(client >= 0)
            MacBridge.configure(client)
            let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            defer { try? stream.close() }
            guard let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EIO) }
            let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
            precondition(request.type == "open" && request.url == "https://example.test/item?x=one&y=two")
            try Wire.writeFrame(JSONEncoder().encode(BridgeMessage(type: "result", result: "focused")), to: stream)
        }
        let response = try await Task.detached { try MacBridge.send("https://example.test/item?x=one&y=two", session: session) }.value
        precondition(response == "focused")
        try await server.value
        // A host an update is replacing gives the link back untouched; one that ends without answering may have opened it;
        // one never reached never got it.
        func peer(answering answer: BridgeMessage?) -> Task<Void, Error> {
            Task.detached {
                let client = accept(descriptor, nil, nil)
                precondition(client >= 0)
                let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
                defer { try? stream.close() }
                _ = try Wire.readFrame(from: stream)
                if let answer { try Wire.writeFrame(JSONEncoder().encode(answer), to: stream) }
            }
        }
        let withdrawing = peer(answering: BridgeMessage(type: "withdrawn"))
        do { _ = try await Task.detached { try MacBridge.send("https://example.test/item", session: session) }.value
             preconditionFailure("A withdrawn link was reported done") } catch is Withdrawn {}
        try await withdrawing.value
        let ending = peer(answering: nil)
        do { _ = try await Task.detached { try MacBridge.send("https://example.test/item", session: session) }.value
             preconditionFailure("A lost answer was reported done") }
        catch { check(error.localizedDescription == connectionLost().localizedDescription) }
        try await ending.value
        do { _ = try MacBridge.send("https://example.test/item", session: newer); preconditionFailure("An unreachable host took a link") }
        catch is Withdrawn {}
        let socketAttributes = try FileManager.default.attributesOfItem(atPath: session.socket.path)
        precondition((socketAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)

        let pipe = Pipe()
        try Wire.writeFrame(Data("test".utf8), to: pipe.fileHandleForWriting)
        try pipe.fileHandleForWriting.close()
        check(try Wire.readFrame(from: pipe.fileHandleForReading) == Data("test".utf8))
        check(try Wire.readFrame(from: pipe.fileHandleForReading) == nil)
        let oversized = Pipe()
        try oversized.fileHandleForWriting.write(contentsOf: Data([1, 0, 16, 0]))
        try oversized.fileHandleForWriting.close()
        do { _ = try Wire.readFrame(from: oversized.fileHandleForReading); preconditionFailure("Oversized frame accepted") }
        catch let error as POSIXError { precondition(error.code == .EMSGSIZE) }
        // A browser's extension counts only when a profile has it installed and enabled.
        let support = FileManager.default.temporaryDirectory.appending(path: "link-reuse-profiles-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: support) }
        let browser = BrowserConfiguration(id: "Test", name: "Test", bundleID: "test.browser", appPath: "/Applications/Test.app",
                                           profilePath: "Test/User Data")
        func profile(_ entry: [String: Any]?) throws {
            let folder = support.appending(path: "Test/User Data/Default")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let settings: [String: Any] = entry.map { ["extension-id": $0] } ?? [:]
            try JSONSerialization.data(withJSONObject: ["extensions": ["settings": settings]])
                .write(to: folder.appending(path: "Preferences"))
        }
        check(!browser.hasExtension("extension-id", applicationSupport: support))
        for (entry, enabled) in [(nil, false), ([:], true), (["disable_reasons": []], true), (["disable_reasons": [1]], false),
                                 (["disable_reasons": 0], true), (["disable_reasons": 4], false), (["state": 0], false)] as [([String: Any]?, Bool)] {
            try profile(entry)
            check(browser.hasExtension("extension-id", applicationSupport: support) == enabled)
        }
        let safari = BrowserConfiguration(id: "Safari", name: "Safari", bundleID: "com.apple.Safari", appPath: "/Applications/Safari.app",
                                          profilePath: nil)
        check(!safari.hasExtension("extension-id", applicationSupport: support))

        // Waiting for a starting browser: it ends when a session file appears, or when cancelled (the browser quit).
        let starting = BridgeSession(id: UUID().uuidString, browser: "test.starting", pid: getpid(), started: started, activeAt: 3)
        defer { try? FileManager.default.removeItem(at: starting.file) }
        let waiting = Task.detached { try await MacBridge.connectedSessions(browser: starting.browser, host: host) }
        try await Task.sleep(for: .milliseconds(50))
        try starting.save()
        let connected = try await waiting.value
        precondition(connected.map(\.id) == [starting.id])
        let abandoned = Task.detached { try await MacBridge.connectedSessions(browser: "test.never", host: host) }
        abandoned.cancel()
        do { _ = try await abandoned.value; preconditionFailure("A cancelled wait returned") } catch is CancellationError {}

        // Discovery never ends a process: a live host that isn't the installed one (a replaced version, which the installer
        // ends) is left alone with its files; a session whose process is gone is removed.
        let stale = Process()
        stale.executableURL = URL(filePath: "/bin/sleep")
        stale.arguments = ["30"]
        try stale.run()
        guard let staleStarted = MacBridge.processStarted(stale.processIdentifier) else { throw POSIXError(.ESRCH) }
        let replaced = BridgeSession(id: UUID().uuidString, browser: "test.replaced", pid: stale.processIdentifier,
                                     started: staleStarted, activeAt: 4)
        defer { try? FileManager.default.removeItem(at: replaced.file) }
        try replaced.save()
        check(try MacBridge.sessions(browser: replaced.browser, host: host).isEmpty)
        check(stale.isRunning && FileManager.default.fileExists(atPath: replaced.file.path))
        stale.terminate()
        stale.waitUntilExit()
        check(try MacBridge.sessions(browser: replaced.browser, host: host).isEmpty)
        check(!FileManager.default.fileExists(atPath: replaced.file.path))

        // Links go to the profile focused last; connecting isn't focus, and between profiles never focused, the host that
        // started first wins.
        let twin = Process(), input = Pipe()
        twin.executableURL = URL(filePath: CommandLine.arguments[0])
        twin.arguments = ["--wait"]
        twin.standardInput = input
        try twin.run()
        defer { try? input.fileHandleForWriting.close() }
        guard let twinStarted = MacBridge.processStarted(twin.processIdentifier) else { throw POSIXError(.ESRCH) }
        let mine = BridgeSession(id: UUID().uuidString, browser: "test.tie", pid: getpid(), started: started, activeAt: 0)
        var theirs = BridgeSession(id: UUID().uuidString, browser: "test.tie", pid: twin.processIdentifier,
                                   started: twinStarted, activeAt: 0)
        defer { for file in [mine.file, theirs.file] { try? FileManager.default.removeItem(at: file) } }
        try mine.save()
        try theirs.save()
        check(try MacBridge.sessions(browser: "test.tie", host: host).map(\.id) == [mine.id, theirs.id])
        theirs.activeAt = 5
        try theirs.save()
        check(try MacBridge.sessions(browser: "test.tie", host: host).map(\.id) == [theirs.id, mine.id])

        // A Chromium browser can start the host only if its registration names this one.
        let resourceFolder = support.appending(path: "Resources")
        try FileManager.default.createDirectory(at: resourceFolder.appending(path: "extension"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["browsers": [["id": "Test", "name": "Test", "bundleID": "test.browser",
            "appPath": "/Applications/Test.app", "profilePath": "Test/User Data"]], "extensionOrigin": "chrome-extension://abc/"])
            .write(to: resourceFolder.appending(path: "configuration.json"))
        try Data(#"{"version":"3.2.4"}"#.utf8).write(to: resourceFolder.appending(path: "extension/manifest.json"))
        let resources = try AppResources(directory: resourceFolder)
        check(!resources.registered(in: browser, applicationSupport: support))
        try resources.installNativeMessaging(applicationSupport: support)
        check(resources.registered(in: browser, applicationSupport: support))
        let registration = support.appending(path: "Test/User Data/NativeMessagingHosts/me.dichev.link_reuse.json")
        try Data(#"{"name":"me.dichev.link_reuse","path":"/elsewhere"}"#.utf8).write(to: registration)
        check(!resources.registered(in: browser, applicationSupport: support))
        check(!resources.registered(in: safari, applicationSupport: support))

        // Handing links to the new version: each is taken in order; one it ends while taking may have opened; once it
        // has ended, or the hand-over is closed, nothing more is taken; and a new version that never gets ready takes none.
        let executable = URL(filePath: CommandLine.arguments[0])
        func link(_ path: String) -> BridgeMessage { BridgeMessage(type: "open", url: "https://example.test/" + path) }
        func refused(_ successor: Successor, _ message: BridgeMessage, _ expected: NSError) async {
            do { try await successor.hand(message); preconditionFailure("A link was taken") }
            catch { check(error.localizedDescription == expected.localizedDescription) }
        }
        let successor = try Successor(executable)
        for index in 1...3 { try await successor.hand(link("\(index)")) }
        await refused(successor, link("vanish"), Successor.uncertain())
        await refused(successor, link("4"), Successor.notTaken())
        let closing = try Successor(executable)
        try await closing.hand(link("1"))
        closing.close()
        await refused(closing, link("2"), Successor.notTaken())
        setenv("LINK_REUSE_TEST_UNREADY", "1", 1)
        let unready = try Successor(executable)
        unsetenv("LINK_REUSE_TEST_UNREADY")
        await refused(unready, link("1"), Successor.notTaken())

        print("macOS IPC round trip, withdrawn and lost links, hand-over to a new version, live-session selection and focus order, private permissions, " +
              "bounded framing, extension and registration detection, connection-wait and replaced-host checks passed")
    }
}
