import Foundation
import Darwin

/// The requests waiting on the extension. Each ends with the extension's answer, or when what carries it ends: its
/// connection, or the browser. A request is held until the extension's one-time go-ahead (`authorize-create`), the only
/// step that lets it change a tab. A held request whose connection ends is released for another; after the go-ahead, a
/// lost answer is an error, never a replay.
actor BridgeExchange {
    private struct Pending {
        let continuation: CheckedContinuation<BridgeMessage, Error>
        let message: BridgeMessage
        var profile: String?
        var granted = false
    }

    private let deliver: @Sendable (BridgeMessage) async throws -> Void
    private var pending: [String: Pending] = [:]
    /// An update is replacing this process: it gives no more go-aheads.
    private var retired = false

    init(deliver: @escaping @Sendable (BridgeMessage) async throws -> Void) { self.deliver = deliver }

    func send(_ message: BridgeMessage) async throws { try await deliver(message) }

    func request(_ url: String) async throws -> BridgeMessage {
        guard !retired else { throw Withdrawn() }
        guard pending.count < 16 else { throw POSIXError(.EBUSY) }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            let message = BridgeMessage(type: "open", id: id, url: url)
            pending[id] = Pending(continuation: continuation, message: message)
            Task {
                do { try await send(message) }
                catch { fail(id, error: error) }
            }
        }
    }

    /// The requests no connection holds.
    func unclaimed() -> [BridgeMessage] { pending.values.filter { $0.profile == nil }.map(\.message) }

    func claim(_ id: String, profile: String) -> Bool {
        guard let request = pending[id], request.profile == nil else { return false }
        pending[id]?.profile = profile
        return true
    }

    /// The go-ahead, given once, to the connection holding the request.
    func authorizeCreation(_ id: String, profile: String?) -> Bool {
        guard let request = pending[id], request.profile == profile, !request.granted else { return false }
        pending[id]?.granted = true
        return true
    }

    @discardableResult
    func receive(_ message: BridgeMessage) -> Bool {
        guard message.type == "result", let id = message.id, let request = pending[id],
              request.profile == message.profile else { return false }
        end(id, with: .success(message))
        return true
    }

    func fail(_ id: String, error: any Error) { end(id, with: .failure(error)) }

    /// Ends the requests no connection holds.
    func failUnclaimed(_ error: any Error) {
        for (id, request) in pending where request.profile == nil { fail(id, error: error) }
    }

    func finish(_ error: any Error = connectionLost()) {
        for id in pending.keys { fail(id, error: error) }
    }

    /// An update is replacing this process: no go-ahead is given from now on. Each held request is given back untouched
    /// (`Withdrawn`), so it can open elsewhere; the ones with the go-ahead finish here.
    func retire() {
        retired = true
        for (id, request) in pending where !request.granted { fail(id, error: Withdrawn()) }
    }

    /// A connection ended: what it held is free for another; what it had the go-ahead for ends.
    func disconnected(profile: String) {
        for (id, request) in pending where request.profile == profile {
            if request.granted { fail(id, error: connectionLost()) }
            else { pending[id]?.profile = nil }
        }
    }

    private func end(_ id: String, with result: Result<BridgeMessage, any Error>) {
        pending.removeValue(forKey: id)?.continuation.resume(with: result)
    }
}
