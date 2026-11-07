import Foundation
import Darwin

actor BridgeExchange {
    private struct Pending {
        let continuation: CheckedContinuation<BridgeMessage, Error>
        let message: BridgeMessage
        var profile: String?
    }

    private let deliver: @Sendable (BridgeMessage) async throws -> Void
    private var pending: [String: Pending] = [:]

    init(deliver: @escaping @Sendable (BridgeMessage) async throws -> Void) { self.deliver = deliver }

    func send(_ message: BridgeMessage) async throws { try await deliver(message) }

    func request(_ url: String) async throws -> BridgeMessage {
        guard pending.count < 16 else { throw POSIXError(.EBUSY) }
        let id = UUID().uuidString
        let timer = Task {
            do { try await Task.sleep(for: .seconds(10)); fail(id, error: POSIXError(.ETIMEDOUT)) } catch {}
        }
        defer { timer.cancel() }
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

    @discardableResult
    func receive(_ message: BridgeMessage) -> Bool {
        guard message.type == "result", let id = message.id, let request = pending[id],
              request.profile == message.profile else { return false }
        pending.removeValue(forKey: id)?.continuation.resume(returning: message)
        return true
    }

    func fail(_ id: String, error: any Error) { pending.removeValue(forKey: id)?.continuation.resume(throwing: error) }
    func finish() {
        for request in pending.values { request.continuation.resume(throwing: POSIXError(.EPIPE)) }
        pending.removeAll()
    }
}
