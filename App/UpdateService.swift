import Foundation

struct SourceRelease: Decodable {
    let version: String
    let buildVersion: String?
    let localizedDescription: String?
    let downloadURL: String
    let date: String
    let minOSVersion: String?
}
private struct SourceApp: Decodable { let bundleIdentifier: String; let versions: [SourceRelease] }
private struct Source: Decodable { let apps: [SourceApp] }

enum UpdateService {
    static let originalBundleID = "io.github.rowlanchik09.UniDay"
    static var sourceURL: URL { URL(string: Bundle.main.object(forInfoDictionaryKey: "UniDaySourceURL") as? String ?? "https://rowlanchik.github.io/UniDay/source.json")! }
    static var currentVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    static var currentBuild: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }
    static func compare(_ left: String, _ right: String) -> ComparisonResult {
        left.compare(right, options: .numeric)
    }
    static func isNew(_ release: SourceRelease) -> Bool {
        let c = compare(release.version, currentVersion)
        return c == .orderedDescending || (c == .orderedSame && compare(release.buildVersion ?? "0", currentBuild) == .orderedDescending)
    }
    static func latest() async throws -> SourceRelease? {
        var request = URLRequest(url: sourceURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count < 2_000_000 else { throw URLError(.badServerResponse) }
        let source = try JSONDecoder().decode(Source.self, from: data)
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let osText = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        return source.apps.first { $0.bundleIdentifier == originalBundleID }?.versions.first {
            $0.minOSVersion == nil || compare(osText, $0.minOSVersion!) != .orderedAscending
        }
    }
    static var altStoreURL: URL {
        var parts = URLComponents(); parts.scheme = "altstore-classic"; parts.host = "viewApp"
        parts.queryItems = [URLQueryItem(name: "bundleID", value: originalBundleID)]
        return parts.url!
    }
}
