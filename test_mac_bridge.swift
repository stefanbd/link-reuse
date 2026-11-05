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
            guard let data = try NativeHost.readFrame(from: stream) else { throw POSIXError(.EIO) }
            let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
            precondition(request.type == "open" && request.url == "https://example.test/item?x=one&y=two")
            try NativeHost.writeFrame(JSONEncoder().encode(BridgeMessage(type: "result", result: "focused")), to: stream)
        }
        let response = try await Task.detached { try MacBridge.send("https://example.test/item?x=one&y=two", session: session) }.value
        precondition(response == "focused")
        try await server.value
        let socketAttributes = try FileManager.default.attributesOfItem(atPath: session.socket.path)
        precondition((socketAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)

        let pipe = Pipe()
        try NativeHost.writeFrame(Data("test".utf8), to: pipe.fileHandleForWriting)
        try pipe.fileHandleForWriting.close()
        check(try NativeHost.readFrame(from: pipe.fileHandleForReading) == Data("test".utf8))
        check(try NativeHost.readFrame(from: pipe.fileHandleForReading) == nil)
        let oversized = Pipe()
        try oversized.fileHandleForWriting.write(contentsOf: Data([1, 0, 16, 0]))
        try oversized.fileHandleForWriting.close()
        do { _ = try NativeHost.readFrame(from: oversized.fileHandleForReading); preconditionFailure("Oversized frame accepted") }
        catch let error as POSIXError { precondition(error.code == .EMSGSIZE) }
        precondition(!shouldExitRouter(busy: true, browserRunning: false))
        precondition(!shouldExitRouter(busy: false, browserRunning: true))
        precondition(shouldExitRouter(busy: false, browserRunning: false))
        print("macOS IPC round trip, live-session selection, private permissions, bounded framing and lifecycle checks passed")
    }
}
