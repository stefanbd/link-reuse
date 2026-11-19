import Foundation

struct BridgeMessage: Codable, Sendable {
    /// Safari's extension opens this address when it starts: the app starts if it isn't running, and connects.
    static let safariStarted = URL(string: "linkreuse://started/safari")!
    /// URL-free webpage-link events the Safari extension may log; anything else is rejected.
    static let traceEvents: Set<String> = ["page-focused", "page-moved", "page-opened", "page-failed",
        "page-skip-disabled", "page-skip-prevented", "page-skip-other",
        "page-skip-button", "page-skip-anchor", "page-skip-target"]
    /// Reasons the Safari extension may report when its connection ends; anything else is rejected.
    static let diagnosticReasons: Set<String> = [
        "core", "version", "message", "socket-error", "socket-close", "unavailable", "bootstrap", "endpoint"]
    var type: String
    var id: String? = nil
    var url: String? = nil
    var result: String? = nil
    var error: String? = nil
    var extensionVersion: String? = nil
    var profile: String? = nil
    var endpoint: String? = nil
    var token: String? = nil
    /// In the extension's greeting: whether one of its profile's windows has focus.
    var focused: Bool? = nil
}

/// An error whose description the user sees.
func failure(_ message: String) -> NSError {
    NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// A link given back untouched by a process an update is replacing: it can safely open elsewhere.
struct Withdrawn: Error {}

/// The connection ended after the extension may have acted on the link.
func connectionLost() -> NSError {
    failure("The browser connection ended while opening the link. Check whether it opened before trying again.")
}
