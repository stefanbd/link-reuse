import Foundation

struct BridgeMessage: Codable, Sendable {
    static let safariReady = Notification.Name("me.dichev.LinkReuse.Safari.ready")
    /// URL-free webpage-link events the Safari extension may log; anything else is rejected.
    static let traceEvents: Set<String> = ["page-focused", "page-moved", "page-opened", "page-failed",
        "page-skip-disabled", "page-skip-prevented", "page-skip-other",
        "page-skip-button", "page-skip-anchor", "page-skip-target"]
    /// Reasons the Safari extension may report when its connection ends; anything else is rejected.
    static let diagnosticReasons: Set<String> = [
        "core", "version", "queue", "message", "socket-error", "socket-close", "unavailable", "bootstrap"]
    var type: String
    var id: String? = nil
    var url: String? = nil
    var result: String? = nil
    var error: String? = nil
    var extensionVersion: String? = nil
    var profile: String? = nil
    var endpoint: String? = nil
    var token: String? = nil
    var deadline: Double? = nil
}
