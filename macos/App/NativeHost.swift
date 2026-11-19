import AppKit
import Darwin
import os

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
        let session = BridgeSession(id: UUID().uuidString, browser: browser, pid: getpid(), started: started,
                                    activeAt: hello.focused == true ? Date.timeIntervalSinceReferenceDate : 0)
        let server = try MacBridge.descriptor(path: session.socket, listen: true)
        // The session the app finds this host by, while it takes links.
        let published = OSAllocatedUnfairLock<BridgeSession?>(initialState: session)
        /// The app can no longer find or reach this host. Answers whether it still could.
        @Sendable func withdraw() -> Bool {
            guard let session = published.withLock({ value in defer { value = nil }; return value }) else { return false }
            session.remove()
            close(server)
            return true
        }
        // The app's connections still owed an answer, and the listener while it accepts them.
        let serving = DispatchGroup()
        serving.enter()
        Thread.detachNewThread {
            serve(server, exchange: exchange, serving: serving)
            // A listener that fails while the app can still find this host would leave it a connection it can't reach.
            if withdraw() { exit(1) }
            serving.leave()
        }
        /// Takes no more links: the ones without the go-ahead go back to the app untouched, and once every answer has
        /// reached the app this returns. A link the extension may be acting on finishes first, unless its connection is
        /// gone (`ended`): then the app hears so.
        @Sendable func stop(ended: Bool) async {
            _ = withdraw()
            await exchange.retire()
            if ended { await exchange.finish() }
            await withCheckedContinuation { done in serving.notify(queue: .global()) { done.resume() } }
        }
        // An update is replacing this host: once it has stopped, the extension hears to connect to the new one.
        let replaced = onReplacement {
            await stop(ended: false)
            try? await exchange.send(BridgeMessage(type: "replaced"))
            exit(0)
        }
        defer { replaced.cancel() }
        try session.save()
        do {
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
                    published.withLock {
                        $0?.activeAt = Date.timeIntervalSinceReferenceDate
                        try? $0?.save()
                    }
                default: throw POSIXError(.EINVAL)
                }
            }
        } catch {
            await stop(ended: true)
            throw error
        }
        await stop(ended: true)
    }

    static func serve(_ server: Int32, exchange: BridgeExchange, serving: DispatchGroup) {
        while true {
            let client = accept(server, nil, nil)
            guard client >= 0 else { return }
            serving.enter()
            MacBridge.configure(client)
            let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            // Each client on its own thread, so one that never sends can't hold up the next.
            Thread.detachNewThread {
                guard let data = try? Wire.readFrame(from: stream),
                      let request = try? JSONDecoder().decode(BridgeMessage.self, from: data),
                      request.type == "open", let url = request.url, isWebLink(url) else {
                    try? stream.close()
                    return serving.leave()
                }
                Task {
                    let reply: BridgeMessage
                    do { reply = try await exchange.request(url) }
                    catch is Withdrawn { reply = BridgeMessage(type: "withdrawn") }
                    catch { reply = BridgeMessage(type: "result", error: error.localizedDescription) }
                    try? Wire.writeFrame(JSONEncoder().encode(reply), to: stream)
                    try? stream.close()
                    serving.leave()
                }
            }
        }
    }
}
