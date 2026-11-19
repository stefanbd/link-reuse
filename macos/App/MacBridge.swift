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

    func remove() {
        try? FileManager.default.removeItem(at: socket)
        try? FileManager.default.removeItem(at: file)
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

    static func sessions(browser: String, host: URL = AppResources.hostURL) throws -> [BridgeSession] {
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
            // A session whose process is gone is removed. A live one that isn't the installed host (a replaced version,
            // which the installer ends) or can't be inspected is left alone. Signal 0 sends nothing: it asks whether
            // the process exists.
            guard let started = processStarted(session.pid) else {
                if kill(session.pid, 0) != 0 && errno == ESRCH { session.remove() }
                return nil
            }
            guard started == session.started else { session.remove(); return nil }
            return runs(session.pid, host) ? session : nil
        }.sorted { $0.activeAt != $1.activeAt ? $0.activeAt > $1.activeAt : $0.started < $1.started }
    }

    /// Whether the process runs the executable at this path (the same file, not just the same name).
    static func runs(_ pid: Int32, _ executable: URL) -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
        let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0 else { return false }
        let path = String(decoding: buffer.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        var actual = stat()
        var expected = stat()
        return Darwin.lstat(path, &actual) == 0 && Darwin.lstat(executable.path, &expected) == 0 &&
            actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino
    }

    /// The browser's live sessions, waiting for its extension to connect if there are none yet. The wait follows changes
    /// to the sessions folder (a session file appearing) and ends only when one connects or the task is cancelled.
    static func connectedSessions(browser: String, host: URL = AppResources.hostURL) async throws -> [BridgeSession] {
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
            } else {
                configure(descriptor)
            }
            return descriptor
        } catch { close(descriptor); throw error }
    }

    /// A closed peer fails the call instead of signalling. Reads wait for the reply or the end of the connection.
    static func configure(_ descriptor: Int32) {
        var noSignal: Int32 = 1
        _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    }

    /// Passes a link to a browser's host. `pass` is asked right before the write: whether the link is still this app's.
    static func send(_ url: String, session: BridgeSession, pass: () -> Bool = { true }) throws -> String {
        let socket = try descriptor(path: session.socket, listen: false)
        let stream = FileHandle(fileDescriptor: socket, closeOnDealloc: true)
        defer { try? stream.close() }
        guard pass() else { throw CancellationError() }
        try Wire.writeFrame(JSONEncoder().encode(BridgeMessage(type: "open", url: url)), to: stream)
        guard let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EIO) }
        let reply = try JSONDecoder().decode(BridgeMessage.self, from: data)
        if let error = reply.error { throw failure(error) }
        guard reply.type == "result", let result = reply.result, ["focused", "opened"].contains(result) else {
            throw POSIXError(.EINVAL)
        }
        return result
    }
}
