import Foundation

struct LearningPolicy: Decodable, Sendable {
    let maxURLBytes: Int
    let maxCacheBytes: Int
    let maxRecords: Int
    let maxPendingRecords: Int
    let maxPendingBytes: Int
    let maxBatchRecords: Int
    let maxSnapshotBytes: Int
    let blockedQueryKeys: [String]
    let blockedQueryPrefixes: [String]
    let blockedPathSegments: [String]
    let blockedHostPrefixes: [String]

    static func load(from url: URL? = nil) throws -> Self {
        let file = url ?? AppResources.directory.appending(path: "extension/learning-policy.json")
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
    }

    func allows(_ value: String) -> Bool {
        guard value.utf8.count <= maxURLBytes, let key = urlKey(value),
              let parts = URLComponents(string: key), let host = parts.host,
              parts.user == nil, parts.password == nil,
              !blockedHostPrefixes.contains(where: { host.hasPrefix($0) }) else { return false }
        func normalized(_ value: String) -> String {
            value.lowercased().filter { $0 != "-" && $0 != "_" }
        }
        func sensitivePath(_ value: String) -> Bool {
            value.split(whereSeparator: { "/?&=#!".contains($0) }).contains { blockedPathSegments.contains(normalized(String($0))) }
        }
        if sensitivePath(parts.path) { return false }
        if let fragment = parts.fragment,
           fragment.contains("=") || fragment.contains("?") || sensitivePath(fragment) { return false }
        for item in parts.queryItems ?? [] {
            let name = normalized(item.name)
            if blockedQueryKeys.contains(name) || blockedQueryPrefixes.contains(where: { name.hasPrefix($0) }) { return false }
        }
        return true
    }
}
