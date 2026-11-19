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

        let reconnecting = Task { try await exchange.request("https://example.test/reconnecting") }
        let reconnectingMessage = await deliveries.next()
        guard let reconnectingID = reconnectingMessage.id else { preconditionFailure() }
        check(await exchange.claim(reconnectingID, profile: "disconnected"))
        await exchange.disconnected(profile: "disconnected")
        let unclaimed = await exchange.unclaimed()
        precondition(unclaimed.map(\.id) == [reconnectingID])
        check(!(await exchange.authorizeCreation(reconnectingID, profile: "disconnected")))
        check(await exchange.claim(reconnectingID, profile: "replacement"))
        check(await exchange.receive(BridgeMessage(type: "result", id: reconnectingID, result: "focused", profile: "replacement")))
        let recovered = try await reconnecting.value
        precondition(recovered.result == "focused")

        let authorized = Task { try await exchange.request("https://example.test/authorized") }
        let authorizedMessage = await deliveries.next()
        guard let authorizedID = authorizedMessage.id else { preconditionFailure() }
        check(await exchange.claim(authorizedID, profile: "creator"))
        check(!(await exchange.authorizeCreation(authorizedID, profile: "other")))
        check(await exchange.authorizeCreation(authorizedID, profile: "creator"))
        check(!(await exchange.authorizeCreation(authorizedID, profile: "creator")))
        await exchange.disconnected(profile: "creator")
        check((await exchange.unclaimed()).isEmpty)
        do { _ = try await authorized.value; preconditionFailure("Uncertain creation was replayed") }
        catch { check(lost(error)) }

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
            catch { check(lost(error)) }
        }

        // An update replacing the app: a request the extension may be acting on (it has the go-ahead) finishes; the
        // others are given back untouched, the extension is refused the go-ahead for them, and no new one is taken.
        let retiring = BridgeExchange { await deliveries.send($0) }
        let acting = Task { try await retiring.request("https://example.test/acting") }
        guard let actingID = await deliveries.next().id else { preconditionFailure() }
        check(await retiring.claim(actingID, profile: "creator"))
        check(await retiring.authorizeCreation(actingID, profile: "creator"))
        let held = Task { try await retiring.request("https://example.test/held") }
        guard let heldID = await deliveries.next().id else { preconditionFailure() }
        check(await retiring.claim(heldID, profile: "creator"))
        let free = Task { try await retiring.request("https://example.test/unclaimed") }
        _ = await deliveries.next()
        await retiring.retire()
        for task in [held, free] {
            do { _ = try await task.value; preconditionFailure("A request stayed after retirement") } catch is Withdrawn {}
        }
        check(!(await retiring.authorizeCreation(heldID, profile: "creator")))
        check(await retiring.receive(BridgeMessage(type: "result", id: actingID, result: "opened", profile: "creator")))
        let acted = try await acting.value
        precondition(acted.result == "opened")
        do { _ = try await retiring.request("https://example.test/late"); preconditionFailure() } catch is Withdrawn {}
        print("Shared native acknowledgements, profile claims, late replies, lost connections, transport failure, " +
              "16-request bound and retirement passed")
    }

    static func check(_ value: Bool) { precondition(value) }
    static func lost(_ error: any Error) -> Bool { error.localizedDescription == connectionLost().localizedDescription }
}
