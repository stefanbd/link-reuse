import Foundation
import SafariServices
import Network
import CryptoKit
import OSLog

actor SafariBridge {
    static let extensionIdentifier = "me.dichev.LinkReuse.Safari"
    private static let authenticationData = Data("Link Reuse Safari connection".utf8)
    private static let log = Logger(subsystem: "me.dichev.LinkReuse", category: "Safari")

    private struct Client {
        let connection: NetworkConnection<WebSocket>
        let number: UInt64
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
    private var connections: UInt64 = 0
    private var activity: UInt64 = 0
    private lazy var exchange = BridgeExchange { [weak self] message in
        guard let self else { throw POSIXError(.EPIPE) }
        try await self.deliver(message)
    }

    init(
        version: String,
        wake: @escaping @Sendable (BridgeMessage) async throws -> Void = SafariBridge.dispatch
    ) async throws {
        self.version = version
        self.wake = wake
        let parameters = NWParametersBuilder.parameters {
            WebSocket { TCP().noDelay(true) }.maximumMessageSize(1_048_576).autoReplyPing(true)
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

    /// Whether an extension context is connected and authenticated.
    var connected: Bool { clients.values.contains(where: \.authenticated) }

    /// Safari quit: the links still waiting for it end with error.
    func end(_ error: any Error) async { await exchange.finish(error) }

    /// An installer is replacing the app: each connected extension hears so, and gets ready for the new one at once.
    func replaced() async {
        for client in clients.values where client.authenticated {
            try? await send(BridgeMessage(type: "replaced"), to: client.connection)
        }
    }

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
            let failure = error as NSError
            Self.log.error("Safari transport: failed \(failure.domain, privacy: .public) \(failure.code)")
            throw error
        }
        if let error = reply.error {
            Self.log.error("Safari transport: extension operation failed")
            throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
        }
        guard let result = reply.result, ["focused", "opened"].contains(result) else { throw POSIXError(.EINVAL) }
        Self.log.notice("Safari transport: completed \(result, privacy: .public)")
        return result
    }

    private func deliver(_ message: BridgeMessage) async throws {
        // The most recently active authenticated connection (profile) gets the request.
        let newest = clients.filter { $0.value.authenticated }.max { $0.value.activity < $1.value.activity }
        if let (profile, client) = newest, let id = message.id {
            Self.log.notice("Safari transport: channel \(id, privacy: .public)")
            if await exchange.claim(id, profile: profile) {
                do {
                    try await send(message, to: client.connection)
                    Self.log.notice("Safari transport: sent")
                } catch { await disconnected(profile, connection: client.connection) }
            }
        } else {
            try await extensionReady()
        }
    }

    /// Sends the connection address when a request is waiting or no extension context is connected yet.
    func extensionReady() async throws {
        if connected, await exchange.unclaimed().isEmpty { return }
        Self.log.notice("Safari transport: bootstrap")
        let code = HMAC<SHA256>.authenticationCode(for: Self.authenticationData, using: key)
        let token = Data(code).base64EncodedString()
        try await wake(BridgeMessage(type: "connect", endpoint: endpoint, token: token))
    }

    private func accept(_ connection: NetworkConnection<WebSocket>) async {
        // At capacity the oldest connection that hasn't authenticated makes room, so idle ones can't keep Safari out.
        var evicted: NetworkConnection<WebSocket>?
        if clients.count >= 16 {
            guard let (identity, idle) = clients.filter({ !$0.value.authenticated })
                .min(by: { $0.value.number < $1.value.number }) else { return }
            clients.removeValue(forKey: identity)
            evicted = idle.connection
        }
        connections += 1
        let identity = UUID().uuidString
        clients[identity] = Client(connection: connection, number: connections)
        if let evicted { try? await evicted.close() }
        await serve(connection, identity: identity)
    }

    private func serve(_ connection: NetworkConnection<WebSocket>, identity: String) async {
        do {
            let hello = try await Self.read(connection)
            guard hello.type == "hello", clients[identity] != nil,
                  let token = hello.token, let code = Data(base64Encoded: token),
                  HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Self.authenticationData, using: key) else {
                throw POSIXError(.EPERM)
            }
            try await send(BridgeMessage(type: "ready", extensionVersion: version, profile: identity), to: connection)
            guard hello.extensionVersion == version else { throw POSIXError(.EPROTO) }
            if hello.result == "active" { activity += 1 }
            clients[identity]?.authenticated = true
            clients[identity]?.activity = hello.result == "active" ? activity : 0
            Self.log.notice("Safari transport: authenticated")
            for request in await exchange.unclaimed() {
                guard let id = request.id, await exchange.claim(id, profile: identity) else { continue }
                try await send(request, to: connection)
            }
            while true {
                var message = try await Self.read(connection)
                switch message.type {
                case "activity":
                    activity += 1
                    clients[identity]?.activity = activity
                case "trace":
                    guard let event = message.result, BridgeMessage.traceEvents.contains(event) else {
                        throw POSIXError(.EINVAL)
                    }
                    let tab = message.id.flatMap { Int($0) } ?? 0
                    Self.log.notice("Safari page link: \(event, privacy: .public) tab \(tab)")
                case "result":
                    guard let id = message.id, UUID(uuidString: id) != nil,
                          ["focused", "opened"].contains(message.result ?? "") || message.error != nil else {
                        throw POSIXError(.EINVAL)
                    }
                    message.profile = identity
                    await exchange.receive(message)
                case "authorize-create":
                    guard let id = message.id, UUID(uuidString: id) != nil else { throw POSIXError(.EINVAL) }
                    let accepted = await exchange.authorizeCreation(id, profile: identity)
                    try await send(BridgeMessage(type: "create-authorized", id: id,
                        error: accepted ? nil : "The external request is no longer available."), to: connection)
                case "diagnostic":
                    guard let reason = message.result,
                          BridgeMessage.diagnosticReasons.contains(reason),
                          let rawCode = message.error, let code = Int(rawCode), (0...4999).contains(code) else {
                        throw POSIXError(.EINVAL)
                    }
                    Self.log.notice("Safari browser ended: \(reason, privacy: .public) \(code)")
                default: throw POSIXError(.EINVAL)
                }
            }
        } catch {
            let failure = error as NSError
            Self.log.notice("Safari channel ended: \(failure.domain, privacy: .public) \(failure.code)")
        }
        await disconnected(identity, connection: connection)
    }

    private func disconnected(_ identity: String, connection: NetworkConnection<WebSocket>) async {
        guard clients.removeValue(forKey: identity) != nil else { return }
        let retryable = await exchange.disconnected(profile: identity)
        if connection.state == .ready { try? await connection.close() }
        if retryable { try? await extensionReady() }
    }

    private static func read(_ connection: NetworkConnection<WebSocket>) async throws -> BridgeMessage {
        while true {
            var result: BridgeMessage?
            try await connection.startReceive { receive in
                // Control frames can have empty payloads.
                var frame = try await receive(0, 1_048_576)
                let opcode = frame.metadata.opcode
                var payload = frame.content
                while !frame.metadata.isComplete {
                    guard payload.count < 1_048_576 else { throw POSIXError(.EMSGSIZE) }
                    frame = try await receive(1, 1_048_576 - payload.count)
                    payload.append(frame.content)
                }
                switch opcode {
                case .ping, .pong:
                    Self.log.debug("Safari control frame bytes: \(payload.count)")
                case .close:
                    let code = String(describing: frame.metadata.closeCode)
                    Self.log.notice("Safari close frame: \(code, privacy: .public)")
                    throw POSIXError(.EPIPE)
                case .text: result = try JSONDecoder().decode(BridgeMessage.self, from: payload)
                default: throw POSIXError(.EINVAL)
                }
            }
            if let result { return result }
        }
    }

    private func send(_ message: BridgeMessage, to connection: NetworkConnection<WebSocket>) async throws {
        let data = try JSONEncoder().encode(message)
        guard let text = String(data: data, encoding: .utf8) else { throw POSIXError(.EINVAL) }
        try await connection.send(text)
    }

    @MainActor private static func dispatch(_ message: BridgeMessage) async throws {
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
        try await SFSafariApplication.dispatchMessage(
            withName: "link-reuse", toExtensionWithIdentifier: extensionIdentifier, userInfo: payload)
    }
}
