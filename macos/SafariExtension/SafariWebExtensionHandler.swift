import AppKit
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
        if message["type"] as? String == "diagnostic", let reason = message["result"] as? String,
           BridgeMessage.diagnosticReasons.contains(reason),
           let rawCode = message["error"] as? String, let code = Int(rawCode), (0...4999).contains(code) {
            log.notice("Safari browser ended: \(reason, privacy: .public) \(code)")
            context.completeRequest(returningItems: [Self.receipt()])
        } else if message["type"] as? String == "hello" {
            log.notice("Safari startup version: \(version, privacy: .public)")
            // Opening the app's address starts it if it isn't running, so it is connected before the first link. The
            // request ends once the address is handed over, so this process can't end before it is.
            let quiet = NSWorkspace.OpenConfiguration()
            quiet.activates = false
            quiet.addsToRecentItems = false
            nonisolated(unsafe) let context = context
            NSWorkspace.shared.open(BridgeMessage.safariStarted, configuration: quiet) { _, _ in
                context.completeRequest(returningItems: [Self.receipt()])
            }
        } else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
        }
    }

    private static func receipt() -> NSExtensionItem {
        let item = NSExtensionItem()
        item.userInfo = [SFExtensionMessageKey: ["type": "receipt"]]
        return item
    }
}
