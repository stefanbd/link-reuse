import Foundation

func urlKey(_ value: String) -> String? {
    guard var parts = URLComponents(string: value),
          let scheme = parts.scheme?.lowercased(),
          ["http", "https"].contains(scheme),
          let host = parts.host, !host.isEmpty else { return nil }
    parts.scheme = scheme
    parts.host = host.lowercased()
    if (scheme == "http" && parts.port == 80) || (scheme == "https" && parts.port == 443) {
        parts.port = nil
    }
    if parts.percentEncodedPath.isEmpty { parts.percentEncodedPath = "/" }
    return parts.string
}

func mapsPlaceKey(_ value: String) -> String? {
    guard let key = urlKey(value), let parts = URLComponents(string: key),
          ["google.com", "www.google.com", "maps.google.com"].contains(parts.host),
          parts.port == nil, parts.user == nil, parts.password == nil,
          parts.path.hasPrefix("/maps/place/") else { return nil }
    let path = parts.percentEncodedPath.lowercased()
    // Restrict identity to the place-details block, excluding the photo identifier.
    let identifiers = Set(path.matches(of: #/!4m[0-9]+!3m[0-9]+!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?:!|$)/#)
        .map { String($0.1) })
    guard identifiers.count == 1, let identifier = identifiers.first else { return nil }
    return "google-maps-place:" + identifier
}

func resourceKeys(_ url: String, relationships: [String: Set<String>]) -> Set<String> {
    guard let key = urlKey(url) else { return [] }
    var visited: Set<String> = []
    var pending = [key]
    var keys: Set<String> = []
    while let current = pending.popLast(), visited.count < 32 {
        guard visited.insert(current).inserted else { continue }
        keys.insert(current)
        if let place = mapsPlaceKey(current) { keys.insert(place) }
        pending.append(contentsOf: (relationships[current] ?? []).compactMap(urlKey))
    }
    return keys
}

func matchingResourceURL(_ requested: String, openURLs: [String], relationships: [String: Set<String>], preferredURL: String? = nil) -> String? {
    guard let key = urlKey(requested) else { return nil }
    let wanted = resourceKeys(requested, relationships: relationships)
    if let preferredURL, openURLs.contains(preferredURL),
       !wanted.isDisjoint(with: resourceKeys(preferredURL, relationships: relationships)) { return preferredURL }
    if let exact = openURLs.first(where: { urlKey($0) == key }) { return exact }
    return openURLs.first { !wanted.isDisjoint(with: resourceKeys($0, relationships: relationships)) }
}
