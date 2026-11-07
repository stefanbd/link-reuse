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
        precondition(first.type == "open" && first.url == "https://example.test/item" && first.deadline != nil)
        try await send(BridgeMessage(type: "result", id: first.id, result: "focused"), to: socket)
        let initialResult = try await opening.value
        precondition(initialResult == "focused")

        try await socket.ping(Data([1]))
        let pong = try await socket.receive()
        precondition(pong.metadata.opcode == .pong)
        try await Task.sleep(for: .seconds(12))

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
        _ = try await receive(socket)
        try await socket.close(code: .protocolCode(.goingAway))
        do { _ = try await interrupted.value; preconditionFailure("Disconnected request survived") }
        catch let error as POSIXError { precondition(error.code == .EPIPE) }
        for _ in 0..<18 {
            let replacement = try await connect(descriptor)
            let response = try await receive(replacement)
            precondition(response.type == "ready")
            try await replacement.close(code: .protocolCode(.goingAway))
        }
        await bridge.stop()
        print("Safari loopback-only WebSocket, token authentication, one-time bootstrap, warm reuse and disconnect handling passed")
    }
}
