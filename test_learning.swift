import Foundation

func check(_ value: Bool, _ message: String = "") { precondition(value, message) }

@main
struct LearningTests {
    static func main() throws {
        let source = URL(filePath: FileManager.default.currentDirectoryPath)
        let policy = try LearningPolicy.load(from: source.appending(path: "extension/learning-policy.json"))
        struct Vector: Decodable { let url: String; let allowed: Bool }
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: source.appending(path: "privacy-vectors.json")))
        for vector in vectors { check(policy.allows(vector.url) == vector.allowed, vector.url) }
        check(!policy.allows("https://example.test/" + String(repeating: "x", count: 4096)))

        let temporary = FileManager.default.temporaryDirectory.appending(path: "link-reuse-unit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let browser = "company.thebrowser.Browser"
        var live = Set(["one", "two"])
        let store = LearningStore(browserID: browser, policy: policy, root: temporary, sessionIsLive: { live.contains($0.id) })
        let owner = LearningSession(id: "one", pid: 1, browserPID: 1, browserStarted: 1, records: [])
        let other = LearningSession(id: "two", pid: 2, browserPID: 1, browserStarted: 1, records: [])
        let short = "https://shop.test/short"
        let product = "https://shop.test/products/42"
        let reviews = product + "/reviews"
        let alias = LearningRecord(kind: "redirect", source: short, destination: product)
        let canonical = LearningRecord(kind: "canonical", source: reviews, destination: product)
        let generation = try store.status().generation
        var snapshot = try store.update(owner: owner, generation: generation, records: [alias], liveURLs: [product])
        check(snapshot.sessions[0].records.count == 1)
        snapshot = try store.update(owner: owner, generation: generation, records: [canonical], liveURLs: [reviews])
        check(snapshot.sessions[0].records.count == 2)
        check(matchingResourceURL(short, openURLs: [reviews], relationships: try store.relationships()) == reviews)
        snapshot = try store.update(owner: owner, generation: generation, records: [], liveURLs: [])
        check(snapshot.sessions[0].records.isEmpty)

        _ = try store.update(owner: owner, generation: generation, records: [alias], liveURLs: [product])
        _ = try store.update(owner: other, generation: generation, records: [alias], liveURLs: [product])
        let cleared = try store.clear()
        check(cleared.generation != generation)
        check(cleared.sessions.allSatisfy { $0.records.isEmpty })
        snapshot = try store.update(owner: other, generation: generation, records: [alias], liveURLs: [product])
        check(snapshot.sessions.allSatisfy { $0.records.isEmpty })
        snapshot = try store.update(owner: owner, generation: cleared.generation, records: [alias], liveURLs: [product])
        check(snapshot.sessions.first { $0.id == "one" }?.records.count == 1)
        live.remove("one")
        check(try store.status().sessions.allSatisfy { $0.id != "one" })

        snapshot = try store.update(owner: other, generation: cleared.generation,
            records: [LearningRecord(kind: "redirect", source: "https://shop.test/?token=secret", destination: product)], liveURLs: [product])
        check(snapshot.sessions.allSatisfy { $0.records.isEmpty })
        let file = store.directory.appending(path: "cache.json")
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        check(permissions?.intValue == 0o600)
        check(!(try String(contentsOf: file, encoding: .utf8)).contains("secret"))

        var tinyJSON = try JSONSerialization.jsonObject(with: Data(contentsOf: source.appending(path: "extension/learning-policy.json"))) as! [String: Any]
        tinyJSON["maxCacheBytes"] = 2048
        tinyJSON["maxRecords"] = 4
        let tiny = try JSONDecoder().decode(LearningPolicy.self, from: JSONSerialization.data(withJSONObject: tinyJSON))
        let bounded = LearningStore(browserID: browser, policy: tiny, root: temporary.appending(path: "bounded"), sessionIsLive: { _ in true })
        let boundedGeneration = try bounded.status().generation
        let additions = (0..<40).map { LearningRecord(kind: "redirect", source: "https://shop.test/\($0)/" + String(repeating: "a", count: 500), destination: product) }
        snapshot = try bounded.update(owner: owner, generation: boundedGeneration, records: additions, liveURLs: [product])
        check(snapshot.sessions.flatMap(\.records).count <= 4)
        check(try Data(contentsOf: bounded.directory.appending(path: "cache.json")).count <= 2048)
        check(snapshot.sessions[0].records.last?.source == additions.last?.source)

        check(!shouldExitRouter(busy: true, browserRunning: false))
        check(!shouldExitRouter(busy: true, browserRunning: true))
        check(!shouldExitRouter(busy: false, browserRunning: true))
        check(shouldExitRouter(busy: false, browserRunning: false))

        let pipe = Pipe()
        try NativeHost.writeFrame(Data("test".utf8), to: pipe.fileHandleForWriting)
        try pipe.fileHandleForWriting.close()
        check(try NativeHost.readFrame(from: pipe.fileHandleForReading) == Data("test".utf8))
        check(try NativeHost.readFrame(from: pipe.fileHandleForReading) == nil)
        let shortPipe = Pipe()
        try shortPipe.fileHandleForWriting.write(contentsOf: Data([1, 2]))
        try shortPipe.fileHandleForWriting.close()
        do { _ = try NativeHost.readFrame(from: shortPipe.fileHandleForReading); preconditionFailure("Truncated frame accepted") }
        catch {}
        let oversized = Pipe()
        try oversized.fileHandleForWriting.write(contentsOf: Data([1, 0, 16, 0]))
        try oversized.fileHandleForWriting.close()
        do { _ = try NativeHost.readFrame(from: oversized.fileHandleForReading); preconditionFailure("Oversized frame accepted") }
        catch let error as POSIXError { check(error.code == .EMSGSIZE) }
        print("Native policy, live-tab retention, clear/replay protection, byte/count limits, file permissions, lifecycle, and framing checks passed")
    }
}
