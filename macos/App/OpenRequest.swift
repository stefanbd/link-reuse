import Foundation

struct OpenRequest: Equatable, Sendable {
    let browser: BrowserConfiguration
    let url: URL

    init(browser: BrowserConfiguration, url: URL) {
        self.browser = browser
        self.url = url
    }

    /// The address the link arrives by, which `init?(_:browsers:)` reads.
    var envelope: URL {
        var components = URLComponents()
        components.scheme = "linkreuse"
        components.host = "open"
        components.path = "/" + browser.id
        components.percentEncodedQuery = "url=" + url.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        return components.url!
    }

    init?(_ envelope: URL, browsers: [BrowserConfiguration]) {
        guard let components = URLComponents(url: envelope, resolvingAgainstBaseURL: false),
              components.scheme == "linkreuse", components.host == "open",
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil,
              let browser = browsers.first(where: { components.path == "/" + $0.id }),
              let items = components.queryItems, items.count == 1, items[0].name == "url",
              let value = items[0].value, isWebLink(value),
              let target = URL(string: value) else { return nil }
        self.browser = browser
        url = target
    }
}
