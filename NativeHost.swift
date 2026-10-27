import AppKit
import Darwin

struct NativeRequest: Decodable {
    let type: String
    let id: Int?
    let generation: String?
    let records: [LearningRecord]?
    let liveURLs: [String]?
}

struct NativeReply: Encodable {
    let ready = true
    let ack: Int?
    let generation: String
    let browser: String
    let records: Int
    let bytes: Int
}

enum NativeHost {
    static let extensionOrigin = "chrome-extension://cjnlaniabigfgcpjhbjkfaghpeeomlbf/"

    static func run(policy: LearningPolicy) throws {
        guard CommandLine.arguments.dropFirst().first == extensionOrigin,
              let parent = NSRunningApplication(processIdentifier: getppid()),
              let browser = parent.bundleIdentifier, supportedBrowsers.contains(browser),
              let started = parent.launchDate?.timeIntervalSince1970 else { throw POSIXError(.EPERM) }
        signal(SIGPIPE, SIG_IGN)
        let store = LearningStore(browserID: browser, policy: policy)
        let owner = LearningSession(id: UUID().uuidString, pid: getpid(), browserPID: parent.processIdentifier,
                                    browserStarted: started, records: [])
        defer { try? store.removeSession(owner.id) }
        var imported = false
        while let data = try readFrame(from: .standardInput) {
            let request = try JSONDecoder().decode(NativeRequest.self, from: data)
            var snapshot: LearningSnapshot
            switch request.type {
            case "hello", "status": snapshot = try store.status()
            case "clear":
                snapshot = try store.clear()
                let (_, files) = try legacyRecords(browser: browser, policy: policy, adding: [])
                for file in files { try? FileManager.default.removeItem(at: file) }
                imported = true
            case "snapshot":
                let records = request.records ?? []
                let urls = request.liveURLs ?? []
                guard records.count <= policy.maxBatchRecords,
                      urls.reduce(0, { $0 + $1.utf8.count + 3 }) <= policy.maxSnapshotBytes,
                      let generation = request.generation else { throw POSIXError(.EINVAL) }
                var additions = records
                var legacy: [URL] = []
                if !imported {
                    (additions, legacy) = try legacyRecords(browser: browser, policy: policy, adding: additions)
                }
                snapshot = try store.update(owner: owner, generation: generation, records: additions, liveURLs: urls)
                if generation == snapshot.generation {
                    for file in legacy { try? FileManager.default.removeItem(at: file) }
                    imported = true
                }
            default: throw POSIXError(.EINVAL)
            }
            let reply = NativeReply(ack: request.id, generation: snapshot.generation, browser: browser,
                                    records: snapshot.sessions.reduce(0, { $0 + $1.records.count }),
                                    bytes: (try JSONEncoder().encode(snapshot)).count)
            try writeFrame(JSONEncoder().encode(reply), to: .standardOutput)
        }
    }

    static func readFrame(from input: FileHandle) throws -> Data? {
        guard let header = try readExactly(4, from: input, allowEOF: true) else { return nil }
        let length = header.enumerated().reduce(UInt32(0)) { $0 | (UInt32($1.element) << (8 * $1.offset)) }
        guard length > 0 && length <= 1_048_576 else { throw POSIXError(.EMSGSIZE) }
        return try readExactly(Int(length), from: input, allowEOF: false)
    }

    private static func readExactly(_ count: Int, from input: FileHandle, allowEOF: Bool) throws -> Data? {
        var data = Data()
        while data.count < count {
            guard let next = try input.read(upToCount: count - data.count), !next.isEmpty else {
                if allowEOF && data.isEmpty { return nil }
                throw POSIXError(.EIO)
            }
            data.append(next)
        }
        return data
    }

    static func writeFrame(_ data: Data, to output: FileHandle) throws {
        var length = UInt32(data.count).littleEndian
        try output.write(contentsOf: withUnsafeBytes(of: &length) { Data($0) } + data)
    }

    private static func legacyRecords(browser: String, policy: LearningPolicy, adding records: [LearningRecord]) throws -> ([LearningRecord], [URL]) {
        let directory = URL.applicationSupportDirectory.appending(path: "Link Reuse/Aliases/\(browser)")
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        var result = records
        for file in files where file.pathExtension == "json" {
            guard result.count < policy.maxRecords,
                  (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? Int.max <= policy.maxCacheBytes,
                  let data = try? Data(contentsOf: file),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            for (field, kind) in [("aliases", "redirect"), ("canonicals", "canonical")] {
                for (source, destination) in object[field] as? [String: String] ?? [:] where result.count < policy.maxRecords {
                    result.append(LearningRecord(kind: kind, source: source, destination: destination))
                }
            }
        }
        return (result, files.filter { ["json", "lock"].contains($0.pathExtension) })
    }
}
