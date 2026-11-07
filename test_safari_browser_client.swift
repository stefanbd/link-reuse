import Foundation

@main
struct SafariBrowserClientTests {
    static func main() async throws {
        let process = Process(), input = Pipe()
        process.executableURL = URL(filePath: "/usr/bin/env")
        process.arguments = ["node", "--input-type=module", "-e", #"""
import readline from 'node:readline';
import { channel } from 'node:diagnostics_channel';
let rawSocket, pinged = false;
channel('undici:client:connected').subscribe(message => { rawSocket = message.socket; });
const line = await new Promise(resolve => readline.createInterface({ input: process.stdin }).once('line', resolve));
const descriptor = JSON.parse(line);
const socket = new WebSocket(descriptor.endpoint);
socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: descriptor.token, extensionVersion: '3.2.4' }));
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.type === 'open') {
    socket.send(JSON.stringify({ type: 'result', id: message.id, result: 'focused' }));
    if (!pinged) {
      pinged = true;
      setTimeout(() => {
        if (!rawSocket) process.exit(1);
        rawSocket.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0]));
      }, 100);
    }
  }
};
socket.onclose = event => process.exit(event.code === 1000 ? 0 : 1);
socket.onerror = () => process.exit(1);
setTimeout(() => process.exit(1), 20000).unref();
"""#]
        process.standardInput = input
        try process.run()
        defer { if process.isRunning { process.terminate() } }
        let bridge = try await SafariBridge(version: "3.2.4") { message in
            try input.fileHandleForWriting.write(contentsOf: JSONEncoder().encode(message) + Data([10]))
        }
        for index in 0..<4 {
            if index > 0 { try await Task.sleep(for: .seconds(2)) }
            let result = try await bridge.open("https://example.test/item")
            precondition(result == "focused")
        }
        await bridge.stop()
        print("Standard browser WebSocket authentication, empty control frame and repeated requests passed")
    }
}
