import Foundation
import Darwin

enum SafariIPC {
    static let extensionIdentifier = "me.dichev.LinkReuse.Safari"

    static func directory() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "LinkReuseAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw POSIXError(.EPERM) }
        let directory = container.appending(path: "Bridge", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw POSIXError(.EPERM) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        return directory
    }

    static func exchange(_ message: BridgeMessage, directory: URL) throws -> BridgeMessage {
        let descriptor = try MacBridge.descriptor(path: directory.appending(path: "r.sock"), listen: false)
        let stream = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? stream.close() }
        try Wire.writeFrame(JSONEncoder().encode(message), to: stream)
        guard let data = try Wire.readFrame(from: stream) else { throw POSIXError(.EIO) }
        return try JSONDecoder().decode(BridgeMessage.self, from: data)
    }

    static func validate(_ message: BridgeMessage) -> Bool {
        guard let profile = message.profile, profile == "default" || UUID(uuidString: profile) != nil else { return false }
        if message.type == "pending" { return true }
        guard let id = message.id, UUID(uuidString: id) != nil else { return false }
        return message.type == "claim" || (message.type == "result" &&
            (["focused", "opened"].contains(message.result ?? "") || message.error != nil))
    }
}
