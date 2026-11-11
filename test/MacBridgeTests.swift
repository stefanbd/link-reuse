import Foundation
import Darwin

func check(_ value: Bool) { precondition(value) }

@main
struct MacBridgeTests {
    static func main() async throws {
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

        // A live host that isn't the installed one (left from a replaced version) is ended, so its browser reconnects.
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
        stale.waitUntilExit()
        precondition(stale.terminationReason == .uncaughtSignal && stale.terminationStatus == SIGTERM)
        check(!FileManager.default.fileExists(atPath: replaced.file.path))

        print("macOS IPC round trip, live-session selection, private permissions, bounded framing, " +
              "extension detection, connection-wait and replaced-host checks passed")
    }
}
