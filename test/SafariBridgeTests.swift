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

    static func connect(_ descriptor: BridgeMessage, origin: String = origin, token: String? = nil, profile: String = UUID().uuidString, version: String = "3.2.4", focused: Bool = true) async throws -> NetworkConnection<WebSocket> {
        guard let endpoint = descriptor.endpoint, let url = URL(string: endpoint) else { preconditionFailure() }
        let socket = NetworkConnection(to: .url(url)) {
            WebSocket { TCP() }.additionalHeaders([("Origin", origin)])
        }
        try await send(BridgeMessage(type: "hello", extensionVersion: version, profile: profile, token: token ?? descriptor.token, focused: focused), to: socket)
        return socket
    }

    /// A wake whose first call waits until the test fails it; later calls succeed.
    actor Gate {
        private var calls = 0
        private var held: CheckedContinuation<Void, Error>?
        func pass() async throws {
            calls += 1
            if calls == 1 { try await withCheckedThrowingContinuation { held = $0 } }
        }
        func fail() { held?.resume(throwing: POSIXError(.EIO)) }
    }

    static func main() async throws {
        let deliveries = SafariDelivery()
        // Safari's answer about the extension comes only after the first link is done: a link never waits for it.
        let (asked, answer) = AsyncStream<Never>.makeStream()
        let bridge = try await SafariBridge(version: "3.2.4") { await deliveries.send($0) } enabled: {
            for await _ in asked {}
            return true
        }
        let opening = Task { try await bridge.open("https://example.test/item") }
        let descriptor = await deliveries.next()
        precondition(descriptor.type == "connect" && descriptor.url == nil && descriptor.id == nil)
        guard let endpoint = descriptor.endpoint, let parsed = URL(string: endpoint) else { preconditionFailure() }
        precondition(parsed.host == "127.0.0.1" && parsed.port != nil)

        let outdated = try await connect(descriptor, version: "3.2.3")
        let update = try await receive(outdated)
        precondition(update.extensionVersion == "3.2.4")
        // Safari's extension (re)started: the address goes out again, whether or not a link waits.
        await bridge.announce()
        let retriedBootstrap = await deliveries.next()
        precondition(retriedBootstrap.endpoint == descriptor.endpoint && retriedBootstrap.token == descriptor.token)

        let profile = UUID().uuidString
        let socket = try await connect(descriptor, profile: profile)
        let ready = try await receive(socket)
        precondition(ready.type == "ready" && ready.extensionVersion == "3.2.4" && ready.profile != nil)
        precondition(ready.profile != profile)
        let first = try await receive(socket)
        precondition(first.type == "open" && first.url == "https://example.test/item")
        try await send(BridgeMessage(type: "result", id: first.id, result: "focused"), to: socket)
        let initialResult = try await opening.value
        precondition(initialResult == "focused")
        answer.finish()

        try await socket.ping(Data([1]))
        let pong = try await socket.receive()
        precondition(pong.metadata.opcode == .pong)

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
        let interruptedMessage = try await receive(socket)
        try await socket.close(code: .protocolCode(.goingAway))
        let recoveryDescriptor = await deliveries.next()
        let recoveredSocket = try await connect(recoveryDescriptor)
        _ = try await receive(recoveredSocket)
        let replay = try await receive(recoveredSocket)
        precondition(replay.id == interruptedMessage.id)
        try await send(BridgeMessage(type: "result", id: replay.id, result: "focused"), to: recoveredSocket)
        let recoveredResult = try await interrupted.value
        precondition(recoveredResult == "focused")

        let uncertain = Task { try await bridge.open("https://example.test/uncertain") }
        let creation = try await receive(recoveredSocket)
        try await send(BridgeMessage(type: "authorize-create", id: creation.id), to: recoveredSocket)
        let authorization = try await receive(recoveredSocket)
        precondition(authorization.type == "create-authorized" && authorization.id == creation.id && authorization.error == nil)
        try await recoveredSocket.close(code: .protocolCode(.goingAway))
        do { _ = try await uncertain.value; preconditionFailure("Authorized creation was replayed") }
        catch let error as POSIXError { precondition(error.code == .EPIPE) }
        for _ in 0..<18 {
            let replacement = try await connect(descriptor)
            let response = try await receive(replacement)
            precondition(response.type == "ready")
            try await replacement.close(code: .protocolCode(.goingAway))
        }
        await bridge.stop()

        // A (re)started extension is connected right away instead of on the next link. Each start announces again, so a
        // profile that starts later connects too.
        let idleDeliveries = SafariDelivery()
        let idle = try await SafariBridge(version: "3.2.4") { await idleDeliveries.send($0) }
        await idle.announce()
        let idleDescriptor = await idleDeliveries.next()
        precondition(idleDescriptor.type == "connect" && idleDescriptor.endpoint != nil && idleDescriptor.id == nil)
        let idleSocket = try await connect(idleDescriptor, focused: false)
        let idleReady = try await receive(idleSocket)
        precondition(idleReady.type == "ready")
        await idle.announce()
        let again = await idleDeliveries.next()
        precondition(again.endpoint == idleDescriptor.endpoint && again.token == idleDescriptor.token)

        // Links go to the profile focused last; connecting isn't focus, and among profiles never focused, the first to
        // connect gets them.
        let later = try await connect(idleDescriptor, focused: false)
        _ = try await receive(later)
        let toFirst = Task { try await idle.open("https://example.test/first-connected") }
        let firstRequest = try await receive(idleSocket)
        try await send(BridgeMessage(type: "result", id: firstRequest.id, result: "focused"), to: idleSocket)
        let firstResult = try await toFirst.value
        precondition(firstResult == "focused")
        // The answer to a go-ahead for an unknown link shows the focus change before it was handled.
        try await send(BridgeMessage(type: "activity"), to: later)
        try await send(BridgeMessage(type: "authorize-create", id: UUID().uuidString), to: later)
        let barrier = try await receive(later)
        precondition(barrier.type == "create-authorized")
        let toFocused = Task { try await idle.open("https://example.test/focused") }
        let focusedRequest = try await receive(later)
        try await send(BridgeMessage(type: "result", id: focusedRequest.id, result: "focused"), to: later)
        let focusedResult = try await toFocused.value
        precondition(focusedResult == "focused")

        // The router can take a link back until the go-ahead: then the extension is refused and changes nothing.
        let withdrawn = Task { try await idle.open("https://example.test/withdrawn") { false } }
        let withdrawnRequest = try await receive(later)
        try await send(BridgeMessage(type: "authorize-create", id: withdrawnRequest.id), to: later)
        let refusal = try await receive(later)
        precondition(refusal.type == "create-authorized" && refusal.error != nil)
        try await send(BridgeMessage(type: "result", id: withdrawnRequest.id, error: refusal.error), to: later)
        do { _ = try await withdrawn.value; preconditionFailure("A withdrawn link was opened") } catch {}

        // An installer replacing the app: the connected extension hears so first.
        await idle.replaced()
        let replaced = try await receive(idleSocket)
        precondition(replaced.type == "replaced")
        await idle.stop()

        // A wake that fails late ends only the links still waiting on it: a link released since waits on a newer one.
        let gate = Gate()
        let gatedDeliveries = SafariDelivery()
        let gated = try await SafariBridge(version: "3.2.4") { message in
            await gatedDeliveries.send(message)
            try await gate.pass()
        } enabled: { true }
        let survivor = Task { try await gated.open("https://example.test/survivor") }
        let gatedDescriptor = await gatedDeliveries.next()
        let brief = try await connect(gatedDescriptor)
        _ = try await receive(brief)
        _ = try await receive(brief)
        try await brief.close(code: .protocolCode(.goingAway))
        let newer = await gatedDeliveries.next()
        await gate.fail()
        let lasting = try await connect(newer)
        _ = try await receive(lasting)
        let delivered = try await receive(lasting)
        precondition(delivered.url == "https://example.test/survivor")
        try await send(BridgeMessage(type: "result", id: delivered.id, result: "opened"), to: lasting)
        let survived = try await survivor.value
        precondition(survived == "opened")
        await gated.stop()

        // Connections that never authenticate can't keep the extension out: at capacity the oldest makes room.
        let crowdedDeliveries = SafariDelivery()
        let crowded = try await SafariBridge(version: "3.2.4") { await crowdedDeliveries.send($0) }
        await crowded.announce()
        let crowdedDescriptor = await crowdedDeliveries.next()
        guard let crowdedURL = crowdedDescriptor.endpoint.flatMap({ URL(string: $0) }) else { preconditionFailure() }
        var silent: [NetworkConnection<WebSocket>] = []
        for _ in 0..<16 {
            let socket = NetworkConnection(to: .url(crowdedURL)) {
                WebSocket { TCP() }.additionalHeaders([("Origin", origin)])
            }
            try await socket.ping(Data([1]))
            let accepted = try await socket.receive()
            precondition(accepted.metadata.opcode == .pong)
            silent.append(socket)
        }
        let admitted = try await connect(crowdedDescriptor)
        let admittedReady = try await receive(admitted)
        precondition(admittedReady.type == "ready")
        do { _ = try await receive(silent[0]); preconditionFailure("The oldest silent connection kept its place") } catch {}

        // Safari quitting ends the links still waiting for it.
        let quitting = Task { try await crowded.open("https://example.test/quit") }
        let undelivered = try await receive(admitted)
        precondition(undelivered.type == "open")
        await crowded.end(POSIXError(.ECANCELED))
        do { _ = try await quitting.value; preconditionFailure("A link outlived Safari") }
        catch let error as POSIXError { precondition(error.code == .ECANCELED) }
        await crowded.stop()

        // A disabled extension never connects: its link ends with the reason instead of waiting.
        let disabled = try await SafariBridge(version: "3.2.4") { _ in } enabled: { false }
        do {
            _ = try await disabled.open("https://example.test/disabled")
            preconditionFailure("A disabled extension took a link")
        }
        catch { precondition(error.localizedDescription.contains("isn’t enabled in Safari")) }
        await disabled.stop()
        print("Safari loopback-only WebSocket, token authentication, bootstrap and re-announcement, warm reuse, focus " +
              "selection, withdrawn go-aheads, scoped wake failures, disconnect handling, room for the extension, app " +
              "replacement, Safari quitting and a disabled extension passed")
    }
}
