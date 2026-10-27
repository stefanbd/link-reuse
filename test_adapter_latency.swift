// Read-only, interleaved Arc timings. Pass compiled adapter paths as arguments.
import AppKit
import Carbon

@main
struct Benchmark {
    static func main() throws {
        let scripts = CommandLine.arguments.dropFirst().map { NSAppleScript(contentsOf: URL(filePath: $0), error: nil)! }
        var timings = [[Double]](repeating: [], count: scripts.count)
        for _ in 0..<20 {
            for (index, script) in scripts.enumerated() {
                let event = NSAppleEventDescriptor(eventClass: AEEventClass(kASAppleScriptSuite), eventID: AEEventID(kASSubroutineEvent), targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                event.setParam(NSAppleEventDescriptor(string: "snapshot"), forKeyword: AEKeyword(keyASSubroutineName))
                let start = ContinuousClock.now
                var error: NSDictionary?
                let snapshot = script.executeAppleEvent(event, error: &error)
                if let error { throw NSError(domain: "benchmark", code: 1, userInfo: error as? [String: Any]) }
                precondition(snapshot.numberOfItems == 3)
                let duration = start.duration(to: .now).components
                timings[index].append(Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15)
            }
        }
        for (index, samples) in timings.enumerated() {
            let sorted = samples.sorted()
            print("Adapter \(index): median \(sorted[10]) ms; max \(sorted.last!) ms")
        }
    }
}
