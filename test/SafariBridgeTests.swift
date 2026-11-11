import Foundation
import Network

actor SafariDelivery {
    private var messages: [BridgeMessage] = []
    private var reader: CheckedContinuation<BridgeMessage, Never>?
    private(set) var count = 0
    func send(_ value: BridgeMessage) {
        count += 1
        if let reader { self.reader = nil; reader.resume(returning: value) }
        else { messages.append(value) }
    }
    func next() async -> BridgeMessage {
        if !messages.isEmpty { return messages.removeFirst() }
        return await withCheckedContinuation { reader = $0 }
    }
}

@main
@MainActor
struct SafariBridgeTests {
    static let origin = "safari-web-extension://00000000-0000-4000-8000-000000000001"

    static func send(_ message: BridgeMessage, to socket: NetworkConnection<WebSocket>) async throws {
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else { preconditionFailure() }
        try await socket.send(text)
    }

    static func receive(_ socket: NetworkConnection<WebSocket>) async throws -> BridgeMessage {
        let value = try await socket.receive()
        return try JSONDecoder().decode(BridgeMessage.self, from: value.content)
    }

    static func connect(_ descriptor: BridgeMessage, origin: String = origin, token: String? = nil, profile: String = UUID().uuidString, version: String = "3.2.4") async throws -> NetworkConnection<WebSocket> {
        guard let endpoint = descriptor.endpoint, let url = URL(string: endpoint) else { preconditionFailure() }
        let socket = NetworkConnection(to: .url(url)) {
            WebSocket { TCP() }.additionalHeaders([("Origin", origin)])
        }
        try await send(BridgeMessage(type: "hello", result: "active", extensionVersion: version, profile: profile, token: token ?? descriptor.token), to: socket)
        return socket
    }

    static func main() async throws {
        let deliveries = SafariDelivery()
        let bridge = try await SafariBridge(version: "3.2.4") { await deliveries.send($0) }
        let opening = Task { try await bridge.open("https://example.test/item") }
        let descriptor = await deliveries.next()
        precondition(descriptor.type == "connect" && descriptor.url == nil && descriptor.id == nil)
        guard let endpoint = descriptor.endpoint, let parsed = URL(string: endpoint) else { preconditionFailure() }
        precondition(parsed.host == "127.0.0.1" && parsed.port != nil)

        let outdated = try await connect(descriptor, version: "3.2.3")
        let update = try await receive(outdated)
        precondition(update.extensionVersion == "3.2.4")
        try await bridge.extensionReady()
        let retriedBootstrap = await deliveries.next()
        precondition(retriedBootstrap.endpoint == descriptor.endpoint && retriedBootstrap.token == descriptor.token)

        let profile = UUID().uuidString
        let socket = try await connect(descriptor, profile: profile)
        let ready = try await receive(socket)
        precondition(ready.type == "ready" && ready.extensionVersion == "3.2.4" && ready.profile != nil)
        precondition(ready.profile != profile)
        let first = try await receive(socket)
        precondition(first.type == "open" && first.url == "https://example.test/item")
        try await send(BridgeMessage(type: "result", id: first.id, result: "focused"), to: socket)
        let initialResult = try await opening.value
        precondition(initialResult == "focused")

        try await socket.ping(Data([1]))
        let pong = try await socket.receive()
        precondition(pong.metadata.opcode == .pong)

        for index in 0..<3 {
            let routing = Task { try await bridge.open("https://example.test/warm/\(index)") }
            let request = try await receive(socket)
            precondition(request.type == "open" && request.id != first.id)
            try await send(BridgeMessage(type: "result", id: request.id, result: "focused"), to: socket)
            let result = try await routing.value
            precondition(result == "focused")
        }
        let wakes = await deliveries.count
        precondition(wakes == 2)

        do {
            let bad = try await connect(descriptor, origin: "https://example.test", token: "")
            _ = try await receive(bad)
            preconditionFailure("Unauthenticated website accepted")
        } catch {}
        do {
            let bad = try await connect(descriptor, token: Data(repeating: 0, count: 32).base64EncodedString())
            _ = try await receive(bad)
            preconditionFailure("Incorrect authentication accepted")
        } catch {}

        let interrupted = Task { try await bridge.open("https://example.test/interrupted") }
        let interruptedMessage = try await receive(socket)
        try await socket.close(code: .protocolCode(.goingAway))
        let recoveryDescriptor = await deliveries.next()
        let recoveredSocket = try await connect(recoveryDescriptor)
        _ = try await receive(recoveredSocket)
        let replay = try await receive(recoveredSocket)
        precondition(replay.id == interruptedMessage.id)
        try await send(BridgeMessage(type: "result", id: replay.id, result: "focused"), to: recoveredSocket)
        let recoveredResult = try await interrupted.value
        precondition(recoveredResult == "focused")

        let uncertain = Task { try await bridge.open("https://example.test/uncertain") }
        let creation = try await receive(recoveredSocket)
        try await send(BridgeMessage(type: "authorize-create", id: creation.id), to: recoveredSocket)
        let authorization = try await receive(recoveredSocket)
        precondition(authorization.type == "create-authorized" && authorization.id == creation.id && authorization.error == nil)
        try await recoveredSocket.close(code: .protocolCode(.goingAway))
        do { _ = try await uncertain.value; preconditionFailure("Authorized creation was replayed") }
        catch let error as POSIXError { precondition(error.code == .EPIPE) }
        for _ in 0..<18 {
            let replacement = try await connect(descriptor)
            let response = try await receive(replacement)
            precondition(response.type == "ready")
            try await replacement.close(code: .protocolCode(.goingAway))
        }
        await bridge.stop()

        // A (re)started extension is connected right away instead of on the next link, and only once.
        let idleDeliveries = SafariDelivery()
        let idle = try await SafariBridge(version: "3.2.4") { await idleDeliveries.send($0) }
        try await idle.extensionReady()
        let idleDescriptor = await idleDeliveries.next()
        precondition(idleDescriptor.type == "connect" && idleDescriptor.endpoint != nil && idleDescriptor.id == nil)
        let idleSocket = try await connect(idleDescriptor)
        let idleReady = try await receive(idleSocket)
        precondition(idleReady.type == "ready")
        try await Task.sleep(for: .milliseconds(200))
        try await idle.extensionReady()
        let idleWakes = await idleDeliveries.count
        precondition(idleWakes == 1)
        // An installer replacing the app: the connected extension hears so first.
        await idle.replaced()
        let replaced = try await receive(idleSocket)
        precondition(replaced.type == "replaced")
        await idle.stop()

        // Connections that never authenticate can't keep the extension out: at capacity the oldest makes room.
        let crowdedDeliveries = SafariDelivery()
        let crowded = try await SafariBridge(version: "3.2.4") { await crowdedDeliveries.send($0) }
        try await crowded.extensionReady()
        let crowdedDescriptor = await crowdedDeliveries.next()
        guard let crowdedURL = crowdedDescriptor.endpoint.flatMap({ URL(string: $0) }) else { preconditionFailure() }
        var silent: [NetworkConnection<WebSocket>] = []
        for _ in 0..<16 {
            let socket = NetworkConnection(to: .url(crowdedURL)) {
                WebSocket { TCP() }.additionalHeaders([("Origin", origin)])
            }
            try await socket.ping(Data([1]))
            let accepted = try await socket.receive()
            precondition(accepted.metadata.opcode == .pong)
            silent.append(socket)
        }
        let admitted = try await connect(crowdedDescriptor)
        let admittedReady = try await receive(admitted)
        precondition(admittedReady.type == "ready")
        do { _ = try await receive(silent[0]); preconditionFailure("The oldest silent connection kept its place") } catch {}

        // Safari quitting ends the links still waiting for it.
        let quitting = Task { try await crowded.open("https://example.test/quit") }
        let undelivered = try await receive(admitted)
        precondition(undelivered.type == "open")
        await crowded.end(POSIXError(.ECANCELED))
        do { _ = try await quitting.value; preconditionFailure("A link outlived Safari") }
        catch let error as POSIXError { precondition(error.code == .ECANCELED) }
        await crowded.stop()
        print("Safari loopback-only WebSocket, token authentication, one-time bootstrap, warm reuse, disconnect handling, " +
              "room for the extension, app replacement and Safari quitting passed")
    }
}
