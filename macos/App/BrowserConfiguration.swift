import Foundation

struct BrowserConfiguration: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let bundleID: String
    let appPath: String
    let profilePath: String?

    /// Whether any of this Chromium browser's profiles has the extension installed and enabled, read from the profiles'
    /// preference files (the same record the browser's extensions page shows).
    func hasExtension(_ id: String, applicationSupport: URL = .applicationSupportDirectory) -> Bool {
        guard let profilePath else { return false }
        let root = applicationSupport.appending(path: profilePath)
        let profiles = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return profiles.contains { profile in
            ["Secure Preferences", "Preferences"].contains { name in
                guard let data = try? Data(contentsOf: profile.appending(path: name)),
                      let preferences = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let extensions = preferences["extensions"] as? [String: Any],
                      let settings = extensions["settings"] as? [String: Any],
                      let entry = settings[id] as? [String: Any] else { return false }
                // Disabled: older Chromium sets state 0; newer lists disable_reasons (an array, or a non-zero mask).
                if entry["state"] as? Int == 0 { return false }
                switch entry["disable_reasons"] {
                case let reasons as [Any]: return reasons.isEmpty
                case let mask as Int: return mask == 0
                default: return true
                }
            }
        }
    }
}

struct AppResources {
    let browsers: [BrowserConfiguration]
    let extensionOrigin: String
    let extensionVersion: String

    /// The Chromium extension ID, from its origin `chrome-extension://<id>/`.
    var extensionID: String { URL(string: extensionOrigin)?.host() ?? "" }

    static var directory: URL {
        URL(filePath: CommandLine.arguments[0]).deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Resources")
    }

    /// The Chromium native messaging host: a copy of the app's binary.
    static var hostURL: URL {
        directory.deletingLastPathComponent().appending(path: "Helpers/LinkReuseHost")
    }

    init(directory: URL = Self.directory) throws {
        struct Configuration: Decodable {
            let browsers: [BrowserConfiguration]
            let extensionOrigin: String
        }
        let configuration = try JSONDecoder().decode(Configuration.self,
            from: Data(contentsOf: directory.appending(path: "configuration.json")))
        browsers = configuration.browsers
        extensionOrigin = configuration.extensionOrigin
        struct Manifest: Decodable { let version: String }
        let manifest = try Data(contentsOf: directory.appending(path: "extension/manifest.json"))
        extensionVersion = try JSONDecoder().decode(Manifest.self, from: manifest).version
    }

    func installNativeMessaging() throws {
        for browser in browsers {
            guard let profilePath = browser.profilePath else { continue }
            let folder = URL.applicationSupportDirectory.appending(path: profilePath)
                .appending(path: "NativeMessagingHosts")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appending(path: "me.dichev.link_reuse.json")
            let manifest: [String: Any] = [
                "name": "me.dichev.link_reuse", "description": "Route links through the shared Link Reuse extension.",
                "path": Self.hostURL.path, "type": "stdio", "allowed_origins": [extensionOrigin],
            ]
            try JSONSerialization.data(withJSONObject: manifest, options: [.sortedKeys])
                .write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }
}
