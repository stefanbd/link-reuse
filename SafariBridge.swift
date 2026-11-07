import AppKit
import SafariServices
import Darwin

@MainActor
final class SafariBridge {
    private let descriptor: Int32
    private let path: URL
    private let exchange: BridgeExchange

    init(directory: URL, deliver: @escaping @Sendable (BridgeMessage) async throws -> Void = { try await SafariBridge.dispatch($0) }) throws {
        path = directory.appending(path: "r.sock")
        if FileManager.default.fileExists(atPath: path.path) {
            do {
                let existing = try MacBridge.descriptor(path: path, listen: false)
                close(existing)
                throw POSIXError(.EBUSY)
            } catch let error as POSIXError where error.code == .ECONNREFUSED || error.code == .ENOENT {
                try FileManager.default.removeItem(at: path)
            }
        }
        descriptor = try MacBridge.descriptor(path: path, listen: true)
        let exchange = BridgeExchange(deliver: deliver)
        self.exchange = exchange
        let server = descriptor
        let listener = Thread { Self.serve(server, exchange: exchange) }
        listener.start()
    }

    deinit {
        _ = shutdown(descriptor, SHUT_RDWR)
        close(descriptor)
        try? FileManager.default.removeItem(at: path)
    }

    func open(_ url: String) async throws -> String {
        let reply = try await exchange.request(url)
        if let error = reply.error { throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
        guard let result = reply.result, ["focused", "opened"].contains(result) else { throw POSIXError(.EINVAL) }
        return result
    }

    private static func dispatch(_ message: BridgeMessage) async throws {
        let data = try JSONEncoder().encode(message)
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        try await SFSafariApplication.dispatchMessage(withName: "link-reuse", toExtensionWithIdentifier: SafariIPC.extensionIdentifier, userInfo: payload)
    }

    nonisolated private static func serve(_ server: Int32, exchange: BridgeExchange) {
        while true {
            let client = accept(server, nil, nil)
            guard client >= 0 else { return }
            MacBridge.configure(client)
            let stream = FileHandle(fileDescriptor: client, closeOnDealloc: true)
            do {
                var uid: uid_t = 0
                var gid: gid_t = 0
                guard getpeereid(client, &uid, &gid) == 0, uid == getuid(),
                      let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EPERM) }
                let message = try JSONDecoder().decode(BridgeMessage.self, from: data)
                guard SafariIPC.validate(message) else { throw POSIXError(.EINVAL) }
                Task {
                    let accepted: Bool
                    if message.type == "claim", let id = message.id, let profile = message.profile {
                        accepted = await exchange.claim(id, profile: profile)
                    } else { accepted = await exchange.receive(message) }
                    let reply = BridgeMessage(type: "receipt", id: message.id, result: accepted ? "accepted" : "ignored")
                    try? Wire.writeFrame(JSONEncoder().encode(reply), to: stream)
                    try? stream.close()
                }
            } catch { try? stream.close() }
        }
    }
}
