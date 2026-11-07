import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any], message["type"] as? String == "hello",
              let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
            context.cancelRequest(withError: CocoaError(.coderInvalidValue))
            return
        }
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["type": "ready", "extensionVersion": version]]
        context.completeRequest(returningItems: [response])
    }
}
