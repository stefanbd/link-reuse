import Foundation

struct BrowserConfiguration: Codable, Equatable {
    let id: String
    let name: String
    let bundleID: String
    let appPath: String
    let profilePath: String
    let script: String
}

struct AppResources {
    let directory: URL
    let browsers: [BrowserConfiguration]
    let extensionOrigin: String
    let policy: LearningPolicy

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
        policy = try LearningPolicy.load(from: directory.appending(path: "extension/learning-policy.json"))
    }
}
