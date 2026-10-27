import Foundation
import JavaScriptCore

@main
struct OpenRequestTests {
    static func main() throws {
        let source = URL(filePath: FileManager.default.currentDirectoryPath)
        let browsers = try JSONDecoder().decode([BrowserConfiguration].self,
            from: Data(contentsOf: source.appending(path: "browsers.json")))
        let template = try String(contentsOf: source.appending(path: "openin-rewrite.js"), encoding: .utf8)
        let values = ["https://example.test/", "https://example.test/a?x=1&x=2#photos", "https://example.test/?q=a+b%26c",
                      "http://example.test:8080/a%2Fb?percent=%25", "https://example.test/é?q=日本語", "https://user:pass@example.test/?token=test"]
        var checks = 0
        for browser in browsers {
            for value in values {
                let context = JSContext()!
                context.setObject(["href": value], forKeyedSubscript: "url" as NSString)
                context.evaluateScript(template.replacingOccurrences(of: "{{browser}}", with: browser.id))
                precondition(context.exception == nil)
                let encoded = context.evaluateScript("url.href")!.toString()!
                let request = OpenRequest(URL(string: encoded)!, browsers: browsers)
                precondition(request?.browser == browser && request?.url == URL(string: value))
                checks += 1
            }
        }
        let rejected = ["https://example.test", "linkreuse://open/Unknown?url=https%3A%2F%2Fexample.test",
                        "linkreuse://open/Arc?url=javascript%3Aalert(1)", "linkreuse://open/Arc?url=file%3A%2F%2F%2Ftmp%2Fx",
                        "linkreuse://open/Arc?url=https%3A%2F%2Fexample.test&url=https%3A%2F%2Fother.test",
                        "linkreuse://open/Arc?url=https%3A%2F%2Fexample.test#extra",
                        "linkreuse://user@open/Arc?url=https%3A%2F%2Fexample.test",
                        "linkreuse://open:99/Arc?url=https%3A%2F%2Fexample.test"]
        for value in rejected { precondition(OpenRequest(URL(string: value)!, browsers: browsers) == nil); checks += 1 }
        print("\(checks) OpenIn JavaScript round-trip and request validation checks passed")
    }
}
