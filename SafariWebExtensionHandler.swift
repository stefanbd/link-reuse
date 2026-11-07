import SafariServices
import OSLog

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let response = NSExtensionItem()
        if message["type"] as? String == "diagnostic", let reason = message["result"] as? String,
           ["core", "version", "queue", "message", "socket-error", "socket-close", "unavailable", "bootstrap"].contains(reason),
           let rawCode = message["error"] as? String, let code = Int(rawCode), (0...4999).contains(code) {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari browser ended: \(reason, privacy: .public) \(code)")
            response.userInfo = [SFExtensionMessageKey: ["type": "receipt"]]
        } else if message["type"] as? String == "hello" {
            Logger(subsystem: "me.dichev.LinkReuse", category: "Safari").notice("Safari startup version: \(version, privacy: .public)")
            response.userInfo = [SFExtensionMessageKey: ["type": "ready", "extensionVersion": version]]
            DistributedNotificationCenter.default().postNotificationName(BridgeMessage.safariReady, object: nil, userInfo: nil, deliverImmediately: true)
        } else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        context.completeRequest(returningItems: [response])
    }
}
