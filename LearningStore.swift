import AppKit
import Darwin

struct LearningRecord: Codable, Equatable {
    let kind: String
    let source: String
    let destination: String?
}

struct LearningSession: Codable {
    let id: String
    let pid: Int32
    let browserPID: Int32
    let browserStarted: Double
    var records: [LearningRecord]
}

struct LearningSnapshot: Codable {
    var version = 3
    var generation = UUID().uuidString
    var sessions: [LearningSession] = []
}

final class LearningStore {
    let directory: URL
    let policy: LearningPolicy
    private let sessionIsLive: (LearningSession) -> Bool

    init(browserID: String, policy: LearningPolicy, root: URL = URL.applicationSupportDirectory.appending(path: "Link Reuse/Live"),
         sessionIsLive: ((LearningSession) -> Bool)? = nil) {
        directory = root.appending(path: browserID)
        self.policy = policy
        self.sessionIsLive = sessionIsLive ?? { session in
            guard let browser = NSRunningApplication(processIdentifier: session.browserPID),
                  browser.bundleIdentifier == browserID,
                  browser.launchDate?.timeIntervalSince1970 == session.browserStarted else { return false }
            var buffer = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
            let length = proc_pidpath(session.pid, &buffer, UInt32(buffer.count))
            guard length > 0 else { return false }
            let executable = String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            return executable == AppResources.recorderURL.path
        }
    }

    func relationships() throws -> [String: Set<String>] { Self.graph(try status().sessions.flatMap(\.records)) }

    func update(owner: LearningSession, generation: String, records: [LearningRecord], liveURLs: [String]) throws -> LearningSnapshot {
        try transaction { snapshot in
            guard generation == snapshot.generation else { return }
            if !snapshot.sessions.contains(where: { $0.id == owner.id }) { snapshot.sessions.append(owner) }
            guard let index = snapshot.sessions.firstIndex(where: { $0.id == owner.id }) else { return }
            var current = snapshot.sessions[index].records
            for record in records {
                guard ["redirect", "canonical"].contains(record.kind), policy.allows(record.source) else { continue }
                current.removeAll { $0.kind == record.kind && $0.source == record.source }
                if let destination = record.destination, policy.allows(destination), destination != record.source {
                    current.append(record)
                }
            }
            snapshot.sessions[index].records = retained(current, liveURLs: liveURLs, graph: Self.graph(current))
        }
    }

    func status() throws -> LearningSnapshot { try transaction { _ in } }

    func clear() throws -> LearningSnapshot {
        try transaction { snapshot in
            snapshot.generation = UUID().uuidString
            for index in snapshot.sessions.indices { snapshot.sessions[index].records = [] }
        }
    }

    func removeSession(_ id: String) throws {
        _ = try transaction { $0.sessions.removeAll { $0.id == id } }
    }

    static func graph(_ records: [LearningRecord]) -> [String: Set<String>] {
        var graph: [String: Set<String>] = [:]
        for record in records {
            if let source = urlKey(record.source), let destination = record.destination.flatMap(urlKey) {
                graph[source, default: []].insert(destination)
            }
        }
        return graph
    }

    private func retained(_ records: [LearningRecord], liveURLs: [String], graph: [String: Set<String>]) -> [LearningRecord] {
        let liveKeys = liveURLs.filter(policy.allows).reduce(into: Set<String>()) { $0.formUnion(resourceKeys($1, relationships: graph)) }
        return records.filter { record in
            guard policy.allows(record.source), let destination = record.destination, policy.allows(destination) else { return false }
            return !liveKeys.isDisjoint(with: resourceKeys(destination, relationships: graph))
        }
    }

    private func transaction(_ body: (inout LearningSnapshot) throws -> Void) throws -> LearningSnapshot {
        let manager = FileManager.default
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = open(directory.appending(path: "cache.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lock >= 0 else { throw POSIXError(.EACCES) }
        defer { close(lock) }
        guard flock(lock, LOCK_EX) == 0 else { throw POSIXError(.EIO) }
        defer { flock(lock, LOCK_UN) }
        let file = directory.appending(path: "cache.json")
        let size = (try? manager.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        let original = size <= policy.maxCacheBytes ? try? Data(contentsOf: file) : nil
        var snapshot = original.flatMap { try? JSONDecoder().decode(LearningSnapshot.self, from: $0) } ?? LearningSnapshot()
        if snapshot.version != 3 { snapshot = LearningSnapshot() }
        snapshot.sessions.removeAll { !sessionIsLive($0) }
        try body(&snapshot)
        while snapshot.sessions.reduce(0, { $0 + $1.records.count }) > policy.maxRecords { evict(&snapshot) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data = try encoder.encode(snapshot)
        while data.count > policy.maxCacheBytes {
            if snapshot.sessions.allSatisfy({ $0.records.isEmpty }) { snapshot.sessions.removeFirst() }
            else { evict(&snapshot) }
            data = try encoder.encode(snapshot)
        }
        if data != original {
            let temporary = directory.appending(path: ".cache-\(UUID().uuidString)")
            guard manager.createFile(atPath: temporary.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw POSIXError(.EACCES) }
            defer { try? manager.removeItem(at: temporary) }
            try data.write(to: temporary)
            guard rename(temporary.path, file.path) == 0 else { throw POSIXError(.EIO) }
        }
        return snapshot
    }

    private func evict(_ snapshot: inout LearningSnapshot) {
        if let index = snapshot.sessions.indices.max(by: { snapshot.sessions[$0].records.count < snapshot.sessions[$1].records.count }),
           !snapshot.sessions[index].records.isEmpty { snapshot.sessions[index].records.removeFirst() }
    }
}
