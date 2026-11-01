import AppKit

private final class IrisRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum IrisHTTP {
    private static let redirects = IrisRedirectPolicy()
    private static let session = URLSession(configuration: .ephemeral, delegate: redirects, delegateQueue: nil)
    private static var lastSessionToken: String?
    private static let tokenLock = NSLock()
    private static func authenticated(_ original: URLRequest) -> URLRequest {
        guard let url = original.url, url.scheme == "http", url.host == "127.0.0.1",
              url.port == 3002, url.user == nil, url.password == nil else { preconditionFailure("IRIS local URL required") }
        var request = original
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/IRIS/local-session-token")
        if let token = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            tokenLock.lock()
            let changed = lastSessionToken != token
            lastSessionToken = token
            tokenLock.unlock()
            if changed && url.path != "/api/access/launch" {
                DispatchQueue.main.async {
                    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/IRIS.app")
                    if let id = Bundle(url: app)?.bundleIdentifier,
                       !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty,
                       let root = URL(string: "http://127.0.0.1:3002/") { openInIris(root) }
                }
            }
        }
        return request
    }
    static func dataTask(with url: URL, completionHandler: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void = { _, _, _ in }) -> URLSessionDataTask {
        dataTask(with: URLRequest(url: url), completionHandler: completionHandler)
    }
    static func dataTask(with request: URLRequest, completionHandler: @escaping @Sendable (Data?, URLResponse?, Error?) -> Void = { _, _, _ in }) -> URLSessionDataTask {
        session.dataTask(with: authenticated(request), completionHandler: completionHandler)
    }
    static func launch(_ target: URL, completion: @escaping (URL?) -> Void) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3002/api/access/launch")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let destination = target.path + (target.query.map { "?" + $0 } ?? "")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["path": destination.isEmpty ? "/" : destination])
        dataTask(with: request) { data, _, _ in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let url = (body?["url"] as? String).flatMap(URL.init(string:))
            DispatchQueue.main.async { completion(url) }
        }.resume()
    }
}
