import Foundation
import Darwin


struct BridgeSession: Codable, Sendable {
    let id: String
    let browser: String
    let pid: Int32
    let started: UInt64
    var activeAt: Double

    var socket: URL { MacBridge.directory.appending(path: id + ".sock") }
    var file: URL { MacBridge.directory.appending(path: id + ".json") }

    func save() throws {
        let data = try JSONEncoder().encode(self)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

enum MacBridge {
    static var directory: URL { URL(filePath: "/tmp/link-reuse-\(getuid())", directoryHint: .isDirectory) }

    static func processStarted(_ pid: Int32) -> UInt64? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
    }

    static func prepare() throws {
        let manager = FileManager.default
        try manager.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw POSIXError(.EPERM) }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }

    static func sessions(browser: String, host: URL = AppResources.recorderURL) throws -> [BridgeSession] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        try prepare()
        let files = try FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.fileSizeKey])
        return files.compactMap { file -> BridgeSession? in
            guard file.pathExtension == "json",
                  (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? Int.max <= 4096,
                  let data = try? Data(contentsOf: file),
                  let session = try? JSONDecoder().decode(BridgeSession.self, from: data),
                  UUID(uuidString: session.id) != nil,
                  session.file.lastPathComponent == file.lastPathComponent,
                  session.browser == browser else { return nil }
            var buffer = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
            let count = proc_pidpath(session.pid, &buffer, UInt32(buffer.count))
            let path = String(decoding: buffer.prefix(max(0, Int(count))).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            var actual = stat()
            var expected = stat()
            let alive = count > 0 && processStarted(session.pid) == session.started
            guard alive, Darwin.lstat(path, &actual) == 0, Darwin.lstat(host.path, &expected) == 0,
                  actual.st_dev == expected.st_dev, actual.st_ino == expected.st_ino else {
                // A host left from a replaced version still holds its browser's connection, so that browser's extension
                // couldn't connect to the installed host: end it.
                if alive { kill(session.pid, SIGTERM) }
                try? FileManager.default.removeItem(at: session.socket)
                try? FileManager.default.removeItem(at: session.file)
                return nil
            }
            return session
        }.sorted { $0.activeAt > $1.activeAt }
    }

    /// The browser's live sessions, waiting for its extension to connect if there are none yet. The wait follows changes
    /// to the sessions folder (a session file appearing) and ends only when one connects or the task is cancelled.
    static func connectedSessions(browser: String, host: URL = AppResources.recorderURL) async throws -> [BridgeSession] {
        try prepare()
        let folder = open(directory.path, O_EVTONLY)
        guard folder >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let (changes, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: folder, eventMask: .write, queue: .global())
        source.setEventHandler { continuation.yield() }
        source.setCancelHandler { close(folder) }
        source.resume()
        defer {
            source.cancel()
            continuation.finish()
        }
        // Checked after the watch starts, so a session that connects in between is never missed.
        var live = try sessions(browser: browser, host: host)
        var iterator = changes.makeAsyncIterator()
        while live.isEmpty {
            guard await iterator.next() != nil else { throw CancellationError() }
            try Task.checkCancellation()
            live = try sessions(browser: browser, host: host)
        }
        return live
    }

    static func descriptor(path: URL, listen: Bool) throws -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        do {
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.path.utf8CString)
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    listen ? Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) :
                        Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            if listen {
                guard chmod(path.path, 0o600) == 0, Darwin.listen(descriptor, 16) == 0 else { throw POSIXError(.EIO) }
            }
            if !listen { configure(descriptor) }
            return descriptor
        } catch { close(descriptor); throw error }
    }

    /// A closed peer fails the call instead of signalling. Reads wait for the reply or the end of the connection.
    static func configure(_ descriptor: Int32) {
        var noSignal: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    }

    static func send(_ url: String, session: BridgeSession) throws -> String {
        let socket = try descriptor(path: session.socket, listen: false)
        let stream = FileHandle(fileDescriptor: socket, closeOnDealloc: true)
        defer { try? stream.close() }
        try Wire.writeFrame(JSONEncoder().encode(BridgeMessage(type: "open", url: url)), to: stream)
        guard let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EIO) }
        let reply = try JSONDecoder().decode(BridgeMessage.self, from: data)
        if let error = reply.error {
            throw NSError(domain: "LinkReuse", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
        }
        guard reply.type == "result", let result = reply.result, ["focused", "opened"].contains(result) else {
            throw POSIXError(.EINVAL)
        }
        return result
    }
}
