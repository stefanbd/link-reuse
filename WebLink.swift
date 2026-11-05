import Foundation

func isWebLink(_ value: String) -> Bool {
    guard value.utf8.count <= 65_536, let parts = URLComponents(string: value),
          let scheme = parts.scheme?.lowercased(),
          ["http", "https"].contains(scheme),
          let host = parts.host, !host.isEmpty else { return false }
    return true
}
