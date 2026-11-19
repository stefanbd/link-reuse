import Foundation
import Darwin

/// The requests waiting on the extension. Each ends with the extension's answer, or when what carries it ends: its
/// connection, or the browser. Before the extension's one-time go-ahead (`authorize-create`) a request has changed
/// nothing, so a connection that ends releases it for another; after it, a lost answer is an error, never a replay.
actor BridgeExchange {
    private struct Pending {
        let continuation: CheckedContinuation<BridgeMessage, Error>
        let message: BridgeMessage
        let arrival: UInt64
        /// Asked at the go-ahead: whether the link is still this app's to pass on.
        let pass: @Sendable () -> Bool
        var profile: String?
        /// The Safari wake the request waits on while no extension context is connected.
        var wake: UInt64?
        var granted = false
    }

    private let deliver: @Sendable (BridgeMessage) async throws -> Void
    private var pending: [String: Pending] = [:]
    private var arrivals: UInt64 = 0

    init(deliver: @escaping @Sendable (BridgeMessage) async throws -> Void) { self.deliver = deliver }

    func send(_ message: BridgeMessage) async throws { try await deliver(message) }

    func request(_ url: String, pass: @escaping @Sendable () -> Bool = { true }) async throws -> BridgeMessage {
        guard pending.count < 16 else { throw POSIXError(.EBUSY) }
        let id = UUID().uuidString
        arrivals += 1
        return try await withCheckedThrowingContinuation { continuation in
            let message = BridgeMessage(type: "open", id: id, url: url)
            pending[id] = Pending(continuation: continuation, message: message, arrival: arrivals, pass: pass)
            Task {
                do { try await send(message) }
                catch { fail(id, error: error) }
            }
        }
    }

    /// The requests no connection holds, oldest first.
    func unclaimed() -> [BridgeMessage] {
        pending.values.filter { $0.profile == nil }.sorted { $0.arrival < $1.arrival }.map(\.message)
    }

    func claim(_ id: String, profile: String) -> Bool {
        guard var request = pending[id], request.profile == nil else { return false }
        request.profile = profile
        request.wake = nil
        pending[id] = request
        return true
    }

    /// The go-ahead, given once, to the connection holding the request, and only while the link is still this app's.
    func authorizeCreation(_ id: String, profile: String?) -> Bool {
        guard var request = pending[id], request.profile == profile, !request.granted, request.pass() else { return false }
        request.granted = true
        pending[id] = request
        return true
    }

    @discardableResult
    func receive(_ message: BridgeMessage) -> Bool {
        guard message.type == "result", let id = message.id, let request = pending[id],
              request.profile == message.profile else { return false }
        pending.removeValue(forKey: id)?.continuation.resume(returning: message)
        return true
    }

    func fail(_ id: String, error: any Error) { pending.removeValue(forKey: id)?.continuation.resume(throwing: error) }

    func finish(_ error: any Error = POSIXError(.EPIPE)) {
        for request in pending.values { request.continuation.resume(throwing: error) }
        pending.removeAll()
    }

    /// A connection ended: what it held without a go-ahead is free for another; what it was allowed to act on ends.
    func disconnected(profile: String) {
        for (id, request) in pending where request.profile == profile {
            if request.granted { fail(id, error: POSIXError(.EPIPE)) }
            else { pending[id]?.profile = nil }
        }
    }

    /// Marks the free requests not yet waiting on a wake as waiting on this one; answers whether there were any.
    func waiting(on wake: UInt64) -> Bool {
        var any = false
        for (id, request) in pending where request.profile == nil && request.wake == nil {
            pending[id]?.wake = wake
            any = true
        }
        return any
    }

    /// A wake failed: the requests still waiting on it end, and no others.
    func wakeFailed(_ wake: UInt64, error: any Error) {
        for (id, request) in pending where request.profile == nil && request.wake == wake { fail(id, error: error) }
    }
}
