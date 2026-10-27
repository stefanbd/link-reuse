import Foundation

struct OpenRequest: Equatable {
    let browser: BrowserConfiguration
    let url: URL

    init?(_ envelope: URL, browsers: [BrowserConfiguration]) {
        guard let components = URLComponents(url: envelope, resolvingAgainstBaseURL: false),
              components.scheme == "linkreuse", components.host == "open",
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil,
              let browser = browsers.first(where: { components.path == "/" + $0.id }),
              let items = components.queryItems, items.count == 1, items[0].name == "url",
              let value = items[0].value, urlKey(value) != nil,
              let target = URL(string: value) else { return nil }
        self.browser = browser
        url = target
    }
}

func shouldExitRouter(busy: Bool, browserRunning: Bool) -> Bool { !busy && !browserRunning }
