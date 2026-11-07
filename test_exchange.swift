import Foundation
import Darwin

actor Deliveries {
    private var queued: [BridgeMessage] = []
    private var reader: CheckedContinuation<BridgeMessage, Never>?
    func send(_ message: BridgeMessage) {
        if let reader { self.reader = nil; reader.resume(returning: message) }
        else { queued.append(message) }
    }
    func next() async -> BridgeMessage {
        if !queued.isEmpty { return queued.removeFirst() }
        return await withCheckedContinuation { reader = $0 }
    }
}

@main
struct ExchangeTests {
    static func main() async throws {
        let deliveries = Deliveries()
        let exchange = BridgeExchange { await deliveries.send($0) }
        let request = Task { try await exchange.request("https://example.test/item") }
        let message = await deliveries.next()
        guard let id = message.id else { preconditionFailure() }
        let first = await exchange.claim(id, profile: "first")
        let duplicate = await exchange.claim(id, profile: "second")
        precondition(first && !duplicate)
        let wrongProfile = await exchange.receive(BridgeMessage(type: "result", id: id, result: "focused", profile: "second"))
        precondition(!wrongProfile)
        let accepted = await exchange.receive(BridgeMessage(type: "result", id: id, result: "focused", profile: "first"))
        precondition(accepted)
        let reply = try await request.value
        precondition(reply.result == "focused")
        let late = await exchange.receive(BridgeMessage(type: "result", id: id, result: "focused", profile: "first"))
        precondition(!late)

        let chromium = Task { try await exchange.request("https://example.test/other") }
        let chromeMessage = await deliveries.next()
        let chromeAccepted = await exchange.receive(BridgeMessage(type: "result", id: chromeMessage.id, result: "opened"))
        precondition(chromeAccepted)
        let chromeReply = try await chromium.value
        precondition(chromeReply.result == "opened")

        let failing = BridgeExchange { _ in throw POSIXError(.ENOENT) }
        do { _ = try await failing.request("https://example.test/item"); preconditionFailure() }
        catch let error as POSIXError { precondition(error.code == .ENOENT) }

        var waiting: [Task<BridgeMessage, Error>] = []
        for _ in 0..<16 {
            waiting.append(Task { try await exchange.request("https://example.test/queued") })
            _ = await deliveries.next()
        }
        do { _ = try await exchange.request("https://example.test/overflow"); preconditionFailure() }
        catch let error as POSIXError { precondition(error.code == .EBUSY) }
        await exchange.finish()
        for task in waiting {
            do { _ = try await task.value; preconditionFailure() }
            catch let error as POSIXError { precondition(error.code == .EPIPE) }
        }
        print("Shared native acknowledgements, profile claims, late replies, transport failure and 16-request bound passed")
    }
}
