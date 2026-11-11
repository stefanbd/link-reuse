import Foundation
import Darwin

enum Wire {
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
}
