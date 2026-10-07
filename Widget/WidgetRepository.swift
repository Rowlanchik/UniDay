import Foundation

struct WidgetDocument {
    var object: [String: Any]
    var plans: [String: WidgetPlan]
    var generatedAt: Date
    var refreshAfter: Date
    var diagnostics: [String: Any]

    init(_ object: [String: Any], diagnostics: [String: Any] = [:]) throws {
        guard ((object["schemaVersion"] as? NSNumber)?.intValue ?? 1) <= 1 else {
            throw StoreError.invalid("Виджет требует более новую версию UniDay.")
        }
        self.object = object
        self.generatedAt = UniDayDate.parse(object["generatedAt"] as? String) ?? Date.distantPast
        self.refreshAfter = UniDayDate.parse(object["refreshAfter"] as? String) ?? Date().addingTimeInterval(15 * 60)
        self.diagnostics = diagnostics
        let planObjects = object["plans"] as? [String: Any] ?? [:]
        let state = object["state"] as? [String: Any] ?? [:]
        let files = state["files"] as? [String: Any] ?? [:]
        var decoded: [String: WidgetPlan] = [:]
        for (family, value) in planObjects {
            guard ["small", "medium", "large"].contains(family) else { continue }
            let bytes = try JSONSerialization.data(withJSONObject: value)
            var plan = try JSONDecoder().decode(WidgetPlan.self, from: bytes)
            if let path = plan.background?.imagePath, let image = files[path] as? [String: Any] {
                plan.background?.image = WidgetImage(dataURL: image["dataURL"] as? String,
                                                    width: (image["width"] as? NSNumber)?.doubleValue,
                                                    height: (image["height"] as? NSNumber)?.doubleValue)
            }
            decoded[family] = plan
        }
        plans = decoded
    }
}

/// The widget cache is intentionally separate from the app database and mirror.
/// A newer app revision always wins, even if an old background task finishes later.
final class WidgetRepository {
    let group = SharedGroupResolver.resolve()
    private let privateRoot: URL

    init() throws {
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true)
        privateRoot = cache.appendingPathComponent("UniDayWidget", isDirectory: true)
        try FileManager.default.createDirectory(at: privateRoot, withIntermediateDirectories: true)
    }

    func load(setup: String?, diagnosticMode: Bool = false) throws -> WidgetDocument? {
        var app: [String: Any]?
        if let groupRoot = group.container {
            app = try? SharedStore.object(Data(contentsOf: groupRoot.appendingPathComponent(SharedStore.snapshotName)))
        }
        // This is an explicit independent profile when the installed signature has
        // no App Group. It isn't synchronized with later changes in the app.
        if app == nil, let setup = setup?.trimmingCharacters(in: .whitespacesAndNewlines), !setup.isEmpty {
            let data = Data(setup.utf8)
            guard data.count <= 12 * 1024 * 1024 else { throw StoreError.invalid("Настройка виджета превышает 12 МБ.") }
            app = SharedStore.normalizedWidgetPayload(try SharedStore.object(data))
            if app?["plans"] == nil { throw StoreError.invalid("В настройке виджета отсутствуют планы UniDay.") }
        }
        guard var selected = app else { return nil }
        let baseRevision = selected["appRevision"] as? NSNumber ?? 0
        let profileKey = Self.profileKey(selected)
        let cacheURL = privateRoot.appendingPathComponent(SharedStore.widgetCacheName)
        if let cache = try? SharedStore.object(Data(contentsOf: cacheURL)),
           cache["baseRevision"] as? NSNumber == baseRevision,
           cache["profileKey"] as? String == profileKey,
           let cached = cache["snapshot"] as? [String: Any],
           (UniDayDate.parse(cached["generatedAt"] as? String) ?? .distantPast) >
                (UniDayDate.parse(selected["generatedAt"] as? String) ?? .distantPast) {
            selected = cached
        }
        var diagnostics = group.diagnostics
        diagnostics["profileMode"] = group.container != nil ? "shared-app-group" : "independent-pasted-export"
        diagnostics["appRevision"] = baseRevision
        diagnostics["diagnosticMode"] = diagnosticMode
        return try WidgetDocument(selected, diagnostics: diagnostics)
    }

    func save(_ object: [String: Any], basedOn seed: [String: Any]) throws {
        let envelope: [String: Any] = [
            "baseRevision": seed["appRevision"] as? NSNumber ?? 0,
            "profileKey": Self.profileKey(seed), "snapshot": SharedStore.compactWidgetSnapshot(object)
        ]
        // Only this extension owns the file; the host app never consumes it as user state.
        try SharedStore.write(envelope, to: privateRoot.appendingPathComponent(SharedStore.widgetCacheName))
    }

    private static func profileKey(_ snapshot: [String: Any]) -> String {
        let state = snapshot["state"] as? [String: Any] ?? [:]
        let profile = state["profile"] as? [String: Any] ?? snapshot["profile"] as? [String: Any] ?? [:]
        // Exact profile JSON is a deterministic local cache key. It is not logged
        // or sent over the network and differentiates independently configured widgets.
        let data = (try? JSONSerialization.data(withJSONObject: profile, options: [.sortedKeys])) ?? Data()
        return data.base64EncodedString()
    }
}
