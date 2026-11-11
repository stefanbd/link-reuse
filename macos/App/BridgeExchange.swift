import Foundation
import Darwin

/// The requests waiting on the extension. Each ends with the extension's answer, or when what carries it ends: its
/// connection, or the browser.
actor BridgeExchange {
    private struct Pending {
        let continuation: CheckedContinuation<BridgeMessage, Error>
        let message: BridgeMessage
        var profile: String?
        var creationAuthorized = false
    }

    private let deliver: @Sendable (BridgeMessage) async throws -> Void
    private var pending: [String: Pending] = [:]

    init(deliver: @escaping @Sendable (BridgeMessage) async throws -> Void) { self.deliver = deliver }

    func send(_ message: BridgeMessage) async throws { try await deliver(message) }

    func request(_ url: String) async throws -> BridgeMessage {
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

    func unclaimed() -> [BridgeMessage] { pending.values.filter { $0.profile == nil }.map(\.message) }

    func claim(_ id: String, profile: String) -> Bool {
        guard var request = pending[id], request.profile == nil else { return false }
        request.profile = profile
        pending[id] = request
        return true
    }

    func authorizeCreation(_ id: String, profile: String) -> Bool {
        guard var request = pending[id], request.profile == profile, !request.creationAuthorized else { return false }
        request.creationAuthorized = true
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

    @discardableResult
    func disconnected(profile: String) -> Bool {
        var retryable = false
        for (id, request) in pending where request.profile == profile {
            if request.creationAuthorized { fail(id, error: POSIXError(.EPIPE)) }
            else { pending[id]?.profile = nil; retryable = true }
        }
        return retryable
    }
}
