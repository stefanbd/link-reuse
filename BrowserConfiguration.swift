import Foundation

struct BrowserConfiguration: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let bundleID: String
    let appPath: String
    let profilePath: String?
}

struct AppResources {
    let directory: URL
    let browsers: [BrowserConfiguration]
    let extensionOrigin: String
    let extensionVersion: String

    static var directory: URL {
        URL(filePath: CommandLine.arguments[0]).deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Resources")
    }

    static var recorderURL: URL {
        directory.deletingLastPathComponent().appending(path: "Helpers/LinkReuseHost")
    }

    init(directory: URL = Self.directory) throws {
        struct Configuration: Decodable {
            let browsers: [BrowserConfiguration]
            let extensionOrigin: String
        }
        let configuration = try JSONDecoder().decode(Configuration.self,
            from: Data(contentsOf: directory.appending(path: "configuration.json")))
        self.directory = directory
        browsers = configuration.browsers
        extensionOrigin = configuration.extensionOrigin
        struct Manifest: Decodable { let version: String }
        extensionVersion = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: directory.appending(path: "extension/manifest.json"))).version
    }

    func installNativeMessaging() throws {
        for browser in browsers {
            guard let profilePath = browser.profilePath else { continue }
            let folder = URL.applicationSupportDirectory.appending(path: profilePath).appending(path: "NativeMessagingHosts")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appending(path: "me.dichev.link_reuse.json")
            let manifest = ["name": "me.dichev.link_reuse", "description": "Route links through the shared Link Reuse extension.",
                            "path": Self.recorderURL.path, "type": "stdio", "allowed_origins": [extensionOrigin]] as [String: Any]
            try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys]).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }
}
