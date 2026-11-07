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

    static func connect(_ descriptor: BridgeMessage, origin: String = origin, token: String? = nil, profile: String = UUID().uuidString) async throws -> NetworkConnection<WebSocket> {
        guard let endpoint = descriptor.endpoint, let url = URL(string: endpoint) else { preconditionFailure() }
        let socket = NetworkConnection(to: .url(url)) {
            WebSocket { TCP() }.additionalHeaders([("Origin", origin)]).subprotocols(["link-reuse"])
        }
        try await send(BridgeMessage(type: "hello", result: "active", profile: profile, token: token ?? descriptor.token), to: socket)
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

        for index in 0..<3 {
            let routing = Task { try await bridge.open("https://example.test/warm/\(index)") }
            let request = try await receive(socket)
            precondition(request.type == "open" && request.id != first.id)
            try await send(BridgeMessage(type: "result", id: request.id, result: "focused"), to: socket)
            let result = try await routing.value
            precondition(result == "focused")
        }
        let wakes = await deliveries.count
        precondition(wakes == 1)

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

        for _ in 0..<18 {
            let replacement = try await connect(descriptor)
            let response = try await receive(replacement)
            precondition(response.type == "ready")
            try await replacement.close(code: .protocolCode(.goingAway))
        }

        let interrupted = Task { try await bridge.open("https://example.test/interrupted") }
        _ = try await receive(socket)
        try await socket.close(code: .protocolCode(.goingAway))
        do { _ = try await interrupted.value; preconditionFailure("Disconnected request survived") }
        catch let error as POSIXError { precondition(error.code == .EPIPE) }
        await bridge.stop()
        print("Safari loopback-only WebSocket, token authentication, one-time bootstrap, warm reuse and disconnect handling passed")
    }
}
