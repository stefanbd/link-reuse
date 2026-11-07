import Foundation
import Darwin

actor SafariDelivery {
    private var message: BridgeMessage?
    private var reader: CheckedContinuation<BridgeMessage, Never>?
    func send(_ value: BridgeMessage) {
        if let reader { self.reader = nil; reader.resume(returning: value) }
        else { message = value }
    }
    func next() async -> BridgeMessage {
        if let message { self.message = nil; return message }
        return await withCheckedContinuation { reader = $0 }
    }
}

@main
struct SafariBridgeTests {
    @MainActor
    static func main() async throws {
        let directory = URL(filePath: "/tmp/lrs-" + UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let deliveries = SafariDelivery()
        var bridge: SafariBridge? = try SafariBridge(directory: directory) { await deliveries.send($0) }
        do { _ = try SafariBridge(directory: directory); preconditionFailure("Live connection replaced") }
        catch let error as POSIXError { precondition(error.code == .EBUSY) }
        let routing = Task { try await bridge?.open("https://example.test/item") }
        let message = await deliveries.next()
        guard let id = message.id else { preconditionFailure() }
        let claim = try SafariIPC.exchange(BridgeMessage(type: "claim", id: id, profile: "default"), directory: directory)
        precondition(claim.result == "accepted")
        let other = UUID().uuidString
        let duplicate = try SafariIPC.exchange(BridgeMessage(type: "claim", id: id, profile: other), directory: directory)
        precondition(duplicate.result == "ignored")
        let wrong = try SafariIPC.exchange(BridgeMessage(type: "result", id: id, result: "focused", profile: other), directory: directory)
        precondition(wrong.result == "ignored")
        let correct = try SafariIPC.exchange(BridgeMessage(type: "result", id: id, result: "focused", profile: "default"), directory: directory)
        precondition(correct.result == "accepted")
        let result = try await routing.value
        precondition(result == "focused")
        let late = try SafariIPC.exchange(BridgeMessage(type: "result", id: id, result: "focused", profile: "default"), directory: directory)
        precondition(late.result == "ignored")
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        precondition(files == ["r.sock"])
        let permissions = try FileManager.default.attributesOfItem(atPath: directory.appending(path: "r.sock").path)
        precondition((permissions[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        precondition(!SafariIPC.validate(BridgeMessage(type: "claim", id: "invalid", profile: "default")))
        precondition(!SafariIPC.validate(BridgeMessage(type: "result", id: id, result: "focused", profile: "invalid")))
        bridge = nil
        precondition(!FileManager.default.fileExists(atPath: directory.appending(path: "r.sock").path))
        print("Safari request/result socket, single-profile claim, peer permissions, late replies, live listener protection and cleanup passed")
    }
}
