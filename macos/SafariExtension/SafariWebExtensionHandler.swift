import SafariServices
import OSLog

/// The Safari extension's native side: logs URL-free diagnostics and tells the app when the extension starts.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let log = Logger(subsystem: "me.dichev.LinkReuse", category: "Safari")

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let response = NSExtensionItem()
        if message["type"] as? String == "diagnostic", let reason = message["result"] as? String,
           BridgeMessage.diagnosticReasons.contains(reason),
           let rawCode = message["error"] as? String, let code = Int(rawCode), (0...4999).contains(code) {
            log.notice("Safari browser ended: \(reason, privacy: .public) \(code)")
            response.userInfo = [SFExtensionMessageKey: ["type": "receipt"]]
        } else if message["type"] as? String == "hello" {
            log.notice("Safari startup version: \(version, privacy: .public)")
            response.userInfo = [SFExtensionMessageKey: ["type": "receipt"]]
            DistributedNotificationCenter.default()
                .postNotificationName(BridgeMessage.safariReady, object: nil, userInfo: nil, deliverImmediately: true)
        } else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        context.completeRequest(returningItems: [response])
    }
}
