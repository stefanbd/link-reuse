import SafariServices
import OSLog

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        do {
            guard let item = context.inputItems.first as? NSExtensionItem,
                  let value = item.userInfo?[SFExtensionMessageKey] else { throw CocoaError(.coderInvalidValue) }
            let data = try JSONSerialization.data(withJSONObject: value)
            var message = try JSONDecoder().decode(BridgeMessage.self, from: data)
            message.profile = (item.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
            let reply: BridgeMessage
            switch message.type {
            case "hello":
                let manifest = Bundle.main.resourceURL?.appending(path: "manifest.json")
                guard let manifest, let version = (try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])?["version"] as? String else { throw CocoaError(.fileReadCorruptFile) }
                var requests: [BridgeMessage] = []
                do {
                    requests = try SafariIPC.exchange(BridgeMessage(type: "pending", profile: message.profile), directory: SafariIPC.directory()).requests ?? []
                } catch let error as POSIXError where error.code == .ENOENT || error.code == .ECONNREFUSED {}
                reply = BridgeMessage(type: "ready", extensionVersion: version, profile: message.profile, requests: requests)
            case "activity": reply = BridgeMessage(type: "receipt")
            case "claim", "result":
                guard SafariIPC.validate(message) else { throw CocoaError(.coderInvalidValue) }
                Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari transport: \(message.type, privacy: .public)")
                reply = try SafariIPC.exchange(message, directory: SafariIPC.directory())
            default: throw CocoaError(.coderInvalidValue)
            }
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: try JSONSerialization.jsonObject(with: JSONEncoder().encode(reply))]
            context.completeRequest(returningItems: [response])
        } catch {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").error("Safari native handler error: \((error as NSError).domain, privacy: .public) \((error as NSError).code)")
            context.cancelRequest(withError: NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: "The Link Reuse native connection is unavailable."]))
        }
    }
}
