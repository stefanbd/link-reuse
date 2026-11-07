import Foundation
import SafariServices
import Network
import CryptoKit
import OSLog

actor SafariBridge {
    static let extensionIdentifier = "me.dichev.LinkReuse.Safari"
    private static let authenticationData = Data("Link Reuse Safari connection".utf8)

    private struct Client {
        let connection: NetworkConnection<WebSocket>
        var authenticated = false
        var activity: UInt64 = 0
    }

    private let listener: NetworkListener<WebSocket>
    private let key = SymmetricKey(size: .bits256)
    private let version: String
    private let wake: @Sendable (BridgeMessage) async throws -> Void
    private var endpoint = ""
    private var serving: Task<Void, Never>?
    private var clients: [String: Client] = [:]
    private var activity: UInt64 = 0
    private lazy var exchange = BridgeExchange { [weak self] message in
        guard let self else { throw POSIXError(.EPIPE) }
        try await self.deliver(message)
    }

    init(version: String, wake: @escaping @Sendable (BridgeMessage) async throws -> Void = SafariBridge.dispatch) async throws {
        self.version = version
        self.wake = wake
        let parameters = NWParametersBuilder.parameters {
            WebSocket { TCP() }.maximumMessageSize(1_048_576).autoReplyPing(true).subprotocols(["link-reuse"])
        }
        parameters.parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.parameters.acceptLocalOnly = true
        let listener = try NetworkListener(using: parameters)
        self.listener = listener
        let (ready, continuation) = AsyncThrowingStream<UInt16, Error>.makeStream()
        listener.onStateUpdate { listener, state in
            switch state {
            case .ready:
                if let port = listener.port { continuation.yield(port.rawValue); continuation.finish() }
            case .failed(let error): continuation.finish(throwing: error)
            case .cancelled: continuation.finish(throwing: CancellationError())
            default: break
            }
        }
        serving = Task { [weak self, listener] in
            do { try await listener.run { [weak self] connection in await self?.accept(connection) } }
            catch { await self?.finish() }
        }
        var iterator = ready.makeAsyncIterator()
        guard let port = try await iterator.next() else { throw POSIXError(.EIO) }
        endpoint = "ws://127.0.0.1:\(port)/"
    }

    deinit { serving?.cancel() }

    func stop() async {
        serving?.cancel()
        serving = nil
        await finish()
    }

    private func finish() async {
        clients.removeAll()
        await exchange.finish()
    }

    func open(_ url: String) async throws -> String {
        let reply: BridgeMessage
        do { reply = try await exchange.request(url) }
        catch {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").error("Safari transport: failed")
            throw error
        }
        if let error = reply.error { throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
        guard let result = reply.result, ["focused", "opened"].contains(result) else { throw POSIXError(.EINVAL) }
        Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari transport: completed \(result, privacy: .public)")
        return result
    }

    private func deliver(_ message: BridgeMessage) async throws {
        if let (profile, client) = clients.filter({ $0.value.authenticated }).max(by: { $0.value.activity < $1.value.activity }), let id = message.id {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari transport: channel")
            if await exchange.claim(id, profile: profile) { try await send(message, to: client.connection) }
        } else {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari transport: bootstrap")
            let token = Data(HMAC<SHA256>.authenticationCode(for: Self.authenticationData, using: key)).base64EncodedString()
            try await wake(BridgeMessage(type: "connect", endpoint: endpoint, token: token))
        }
    }

    private func accept(_ connection: NetworkConnection<WebSocket>) async {
        guard clients.count < 16 else { return }
        let identity = UUID().uuidString
        clients[identity] = Client(connection: connection)
        await serve(connection, identity: identity)
    }

    private func serve(_ connection: NetworkConnection<WebSocket>, identity: String) async {
        do {
            let hello = try await withThrowingTaskGroup(of: BridgeMessage.self) { group in
                group.addTask { try await Self.read(connection) }
                group.addTask { try await Task.sleep(for: .seconds(5)); throw POSIXError(.ETIMEDOUT) }
                defer { group.cancelAll() }
                guard let value = try await group.next() else { throw POSIXError(.EIO) }
                return value
            }
            guard hello.type == "hello", clients[identity] != nil,
                  let token = hello.token, let code = Data(base64Encoded: token),
                  HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Self.authenticationData, using: key) else { throw POSIXError(.EPERM) }
            if hello.result == "active" { activity += 1 }
            clients[identity]?.authenticated = true
            clients[identity]?.activity = hello.result == "active" ? activity : 0
            try await send(BridgeMessage(type: "ready", extensionVersion: version, profile: identity), to: connection)
            for request in await exchange.unclaimed() {
                if let id = request.id, await exchange.claim(id, profile: identity) { try await send(request, to: connection) }
            }
            while true {
                var message = try await Self.read(connection)
                switch message.type {
                case "activity":
                    activity += 1
                    clients[identity]?.activity = activity
                case "result":
                    guard let id = message.id, UUID(uuidString: id) != nil,
                          ["focused", "opened"].contains(message.result ?? "") || message.error != nil else { throw POSIXError(.EINVAL) }
                    message.profile = identity
                    _ = await exchange.receive(message)
                default: throw POSIXError(.EINVAL)
                }
            }
        } catch {}
        clients.removeValue(forKey: identity)
        await exchange.finish(profile: identity)
        if connection.state == .ready { try? await connection.close() }
    }

    private static func read(_ connection: NetworkConnection<WebSocket>) async throws -> BridgeMessage {
        let frame = try await connection.receive()
        guard frame.metadata.opcode == .text, frame.metadata.isComplete, frame.content.count <= 1_048_576 else { throw POSIXError(.EINVAL) }
        return try JSONDecoder().decode(BridgeMessage.self, from: frame.content)
    }

    private func send(_ message: BridgeMessage, to connection: NetworkConnection<WebSocket>) async throws {
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else { throw POSIXError(.EINVAL) }
        try await connection.send(text)
    }

    @MainActor private static func dispatch(_ message: BridgeMessage) async throws {
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
        try await SFSafariApplication.dispatchMessage(withName: "link-reuse", toExtensionWithIdentifier: extensionIdentifier, userInfo: payload)
    }
}
