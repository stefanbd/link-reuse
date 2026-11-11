import AppKit
import Darwin

enum NativeHost {
    static func run(resources: AppResources) async throws {
        guard CommandLine.arguments.dropFirst().first == resources.extensionOrigin,
              let parent = NSRunningApplication(processIdentifier: getppid()),
              let browser = parent.bundleIdentifier,
              resources.browsers.contains(where: { $0.bundleID == browser }) else { throw POSIXError(.EPERM) }
        signal(SIGPIPE, SIG_IGN)
        guard let hello = try Wire.readFrame(from: .standardInput),
              try JSONDecoder().decode(BridgeMessage.self, from: hello).type == "hello" else {
            throw POSIXError(.EINVAL)
        }
        try MacBridge.prepare()
        guard let started = MacBridge.processStarted(getpid()) else { throw POSIXError(.EPERM) }
        let now = Date.timeIntervalSinceReferenceDate
        var session = BridgeSession(id: UUID().uuidString, browser: browser, pid: getpid(), started: started, activeAt: now)
        let server = try MacBridge.descriptor(path: session.socket, listen: true)
        let exchange = BridgeExchange { message in
            try Wire.writeFrame(JSONEncoder().encode(message), to: .standardOutput)
        }
        let listener = Thread { serve(server, exchange: exchange) }
        listener.start()
        let replaced = onTermination { [session] in
            try? await exchange.send(BridgeMessage(type: "replaced"))
            session.remove()
        }
        defer {
            replaced.cancel()
            listener.cancel()
            _ = shutdown(server, SHUT_RDWR)
            close(server)
            session.remove()
        }
        try await exchange.send(BridgeMessage(type: "ready", extensionVersion: resources.extensionVersion))
        try session.save()
        while let data = try Wire.readFrame(from: .standardInput) {
            let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
            switch request.type {
            case "result": await exchange.receive(request)
            case "activity": session.activeAt = Date.timeIntervalSinceReferenceDate; try session.save()
            default: throw POSIXError(.EINVAL)
            }
        }
        await exchange.finish()
    }

    static func serve(_ server: Int32, exchange: BridgeExchange) {
        while !Thread.current.isCancelled {
            let client = accept(server, nil, nil)
            guard client >= 0 else { return }
            MacBridge.configure(client)
            let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            // Each client on its own thread, so one that never sends can't hold up the next.
            Thread.detachNewThread {
                do {
                    guard let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EIO) }
                    let request = try JSONDecoder().decode(BridgeMessage.self, from: data)
                    guard request.type == "open", let url = request.url, isWebLink(url) else { throw POSIXError(.EINVAL) }
                    Task {
                        do {
                            let reply = try await exchange.request(url)
                            try Wire.writeFrame(JSONEncoder().encode(reply), to: stream)
                        } catch {}
                        try? stream.close()
                    }
                } catch { try? stream.close() }
            }
        }
    }


}
