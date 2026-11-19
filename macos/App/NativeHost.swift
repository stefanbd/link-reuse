import AppKit
import Darwin

enum NativeHost {
    static func run(resources: AppResources) async throws {
        guard CommandLine.arguments.dropFirst().first == resources.extensionOrigin,
              let parent = NSRunningApplication(processIdentifier: getppid()),
              let browser = parent.bundleIdentifier,
              resources.browsers.contains(where: { $0.bundleID == browser }) else { throw POSIXError(.EPERM) }
        signal(SIGPIPE, SIG_IGN)
        guard let frame = try Wire.readFrame(from: .standardInput) else { return }
        let hello = try JSONDecoder().decode(BridgeMessage.self, from: frame)
        guard hello.type == "hello" else { throw POSIXError(.EINVAL) }
        let exchange = BridgeExchange { message in
            try Wire.writeFrame(JSONEncoder().encode(message), to: .standardOutput)
        }
        // Always the version this app bundles: an extension of another version loads it, and this connection, which
        // routes nothing, ends with it.
        try await exchange.send(BridgeMessage(type: "ready", extensionVersion: resources.extensionVersion))
        guard hello.extensionVersion == resources.extensionVersion else {
            while try Wire.readFrame(from: .standardInput) != nil {}
            return
        }
        try MacBridge.prepare()
        guard let started = MacBridge.processStarted(getpid()) else { throw POSIXError(.EPERM) }
        // Links go to the profile focused last; connecting isn't focus.
        var session = BridgeSession(id: UUID().uuidString, browser: browser, pid: getpid(), started: started,
                                    activeAt: hello.focused == true ? Date.timeIntervalSinceReferenceDate : 0)
        let server = try MacBridge.descriptor(path: session.socket, listen: true)
        let listener = Thread { serve(server, exchange: exchange) }
        listener.start()
        let replaced = onReplacement { [session] in
            try? await exchange.send(BridgeMessage(type: "replaced"))
            session.remove()
            exit(0)
        }
        defer {
            replaced.cancel()
            listener.cancel()
            _ = shutdown(server, SHUT_RDWR)
            close(server)
            session.remove()
        }
        try session.save()
        while let data = try Wire.readFrame(from: .standardInput) {
            let message = try JSONDecoder().decode(BridgeMessage.self, from: data)
            switch message.type {
            case "result": await exchange.receive(message)
            case "authorize-create":
                guard let id = message.id else { throw POSIXError(.EINVAL) }
                let granted = await exchange.authorizeCreation(id, profile: nil)
                try await exchange.send(BridgeMessage(type: "create-authorized", id: id,
                    error: granted ? nil : "The external request is no longer available."))
            case "activity":
                // Best effort: if the write fails, the last focus stands.
                session.activeAt = Date.timeIntervalSinceReferenceDate
                try? session.save()
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
