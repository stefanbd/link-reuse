import AppKit
import Darwin

enum NativeHost {
    actor Exchange {
        private var pending: [String: CheckedContinuation<BridgeMessage, Error>] = [:]

        func send(_ message: BridgeMessage) throws { try NativeHost.writeFrame(JSONEncoder().encode(message), to: .standardOutput) }

        func request(_ url: String) async throws -> BridgeMessage {
            guard pending.count < 16 else { throw POSIXError(.EBUSY) }
            let id = UUID().uuidString
            let timer = Task {
                do { try await Task.sleep(for: .seconds(10)); expire(id) } catch {}
            }
            defer { timer.cancel() }
            return try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                do { try send(BridgeMessage(type: "open", id: id, url: url)) }
                catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
            }
        }

        func receive(_ message: BridgeMessage) {
            if let id = message.id { pending.removeValue(forKey: id)?.resume(returning: message) }
        }
        func expire(_ id: String) { pending.removeValue(forKey: id)?.resume(throwing: POSIXError(.ETIMEDOUT)) }
        func finish() { for continuation in pending.values { continuation.resume(throwing: POSIXError(.EPIPE)) }; pending.removeAll() }
    }

    static func run(resources: AppResources) async throws {
        guard CommandLine.arguments.dropFirst().first == resources.extensionOrigin,
              let parent = NSRunningApplication(processIdentifier: getppid()),
              let browser = parent.bundleIdentifier, resources.browsers.contains(where: { $0.bundleID == browser }) else { throw POSIXError(.EPERM) }
        signal(SIGPIPE, SIG_IGN)
        guard let hello = try readFrame(from: .standardInput), try JSONDecoder().decode(BridgeMessage.self, from: hello).type == "hello" else { throw POSIXError(.EINVAL) }
        try MacBridge.prepare()
        guard let started = MacBridge.processStarted(getpid()) else { throw POSIXError(.EPERM) }
        var session = BridgeSession(id: UUID().uuidString, browser: browser, pid: getpid(), started: started, activeAt: Date.timeIntervalSinceReferenceDate)
        let server = try MacBridge.descriptor(path: session.socket, listen: true)
        let exchange = Exchange()
        let listener = Thread { serve(server, exchange: exchange) }
        listener.start()
        defer {
            listener.cancel()
            _ = shutdown(server, SHUT_RDWR)
            close(server)
            try? FileManager.default.removeItem(at: session.socket)
            try? FileManager.default.removeItem(at: session.file)
        }
        try await exchange.send(BridgeMessage(type: "ready", extensionVersion: resources.extensionVersion))
        try session.save()
        while let data = try readFrame(from: .standardInput) {
            let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
            switch request.type {
            case "result": await exchange.receive(request)
            case "activity": session.activeAt = Date.timeIntervalSinceReferenceDate; try session.save()
            default: throw POSIXError(.EINVAL)
            }
        }
        await exchange.finish()
    }

    static func serve(_ server: Int32, exchange: Exchange) {
        while !Thread.current.isCancelled {
            let client = accept(server, nil, nil)
            guard client >= 0 else { return }
            MacBridge.configure(client)
            let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            do {
                guard let data = try readFrame(from: stream) else { throw POSIXError(.EIO) }
                let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
                guard request.type == "open", let url = request.url, isWebLink(url) else { throw POSIXError(.EINVAL) }
                Task {
                    do {
                        let reply = try await exchange.request(url)
                        try writeFrame(JSONEncoder().encode(reply), to: stream)
                    } catch {}
                    try? stream.close()
                }
            } catch { try? stream.close() }
        }
    }

    static func readFrame(from input: FileHandle) throws -> Data? {
        guard let header = try readExactly(4, from: input, allowEOF: true) else { return nil }
        let length = header.enumerated().reduce(UInt32(0)) { $0 | (UInt32($1.element) << (8 * $1.offset)) }
        guard length > 0 && length <= 1_048_576 else { throw POSIXError(.EMSGSIZE) }
        return try readExactly(Int(length), from: input, allowEOF: false)
    }

    private static func readExactly(_ count: Int, from input: FileHandle, allowEOF: Bool) throws -> Data? {
        var data = Data()
        while data.count < count {
            guard let next = try input.read(upToCount: count - data.count), !next.isEmpty else {
                if allowEOF && data.isEmpty { return nil }
                throw POSIXError(.EIO)
            }
            data.append(next)
        }
        return data
    }

    static func writeFrame(_ data: Data, to output: FileHandle) throws {
        var length = UInt32(data.count).littleEndian
        try output.write(contentsOf: withUnsafeBytes(of: &length) { Data($0) } + data)
    }

}
