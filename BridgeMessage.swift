import Foundation

struct BridgeMessage: Codable, Sendable {
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
