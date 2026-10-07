import Foundation

/// All user content stays in the application container. The extension only reads an
/// atomic mirror and writes a separate cache; it never replaces the app's database.
final class SharedStore {
    static let schemaVersion = 1
    static let snapshotName = "UniDay-widget-v1.json"
    static let widgetCacheName = "UniDay-widget-cache-v1.json"
    private let lock = NSRecursiveLock()
    private let root: URL
    private let stateURL: URL
    let group: SharedGroupResolution
    private var state: [String: Any]
    private var lastMirrorError: String?

    init(rootURL: URL? = nil, groupResolution: SharedGroupResolution? = nil) throws {
        if let rootURL = rootURL { root = rootURL }
        else {
            let support = try FileManager.default.url(for: .applicationSupportDirectory,
                                                      in: .userDomainMask,
                                                      appropriateFor: nil, create: true)
            root = support.appendingPathComponent("UniDay", isDirectory: true)
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        stateURL = root.appendingPathComponent("state-v1.json")
        group = groupResolution ?? SharedGroupResolver.resolve()
        if FileManager.default.fileExists(atPath: stateURL.path) {
            let bytes = try Data(contentsOf: stateURL)
            // A damaged database is preserved and reported, never silently reset.
            let original = try Self.object(bytes)
            state = try Self.migrate(original)
            if (original["schemaVersion"] as? NSNumber)?.intValue != Self.schemaVersion {
                try Self.write(state, to: stateURL)
            }
        } else {
            state = Self.emptyState()
            try Self.write(state, to: stateURL)
        }
    }

    func readState() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    func apply(_ operations: [[String: Any]]) throws {
        lock.lock(); defer { lock.unlock() }
        var next = state
        var files = next["files"] as? [String: Any] ?? [:]
        var directories = Set(next["directories"] as? [String] ?? ["/documents"])
        for operation in operations {
            guard let op = operation["op"] as? String,
                  let rawPath = operation["path"] as? String else {
                throw StoreError.invalid("Операция хранения не содержит op/path.")
            }
            let path = try Self.virtualPath(rawPath)
            switch op {
            case "writeText", "writeString":
                guard let value = operation["value"] as? String else {
                    throw StoreError.invalid("Текстовый файл содержит неверное значение.")
                }
                files[path] = ["kind": "text", "value": value]
                Self.addParents(path, to: &directories)
            case "writeImage":
                guard let value = operation["dataURL"] as? String,
                      value.hasPrefix("data:image/"), value.contains(";base64,") else {
                    throw StoreError.invalid("Изображение должно быть локальным data URL.")
                }
                files[path] = ["kind": "image", "dataURL": value,
                               "width": operation["width"] as? NSNumber ?? 0,
                               "height": operation["height"] as? NSNumber ?? 0]
                Self.addParents(path, to: &directories)
            case "mkdir":
                directories.insert(path)
                Self.addParents(path + "/_", to: &directories)
            case "remove":
                guard path != "/documents" else { throw StoreError.invalid("Нельзя удалить корень данных.") }
                files = files.filter { $0.key != path && !$0.key.hasPrefix(path + "/") }
                directories = Set(directories.filter { $0 != path && !$0.hasPrefix(path + "/") })
            default:
                throw StoreError.invalid("Неизвестная операция хранения: \(op)")
            }
        }
        next["files"] = files
        next["directories"] = directories.sorted()
        next["revision"] = ((next["revision"] as? NSNumber)?.intValue ?? 0) + 1
        next["updatedAt"] = Self.timestamp()
        try Self.write(next, to: stateURL)
        state = next
    }

    func publishWidget(_ payload: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        var snapshot = Self.normalizedWidgetPayload(payload)
        var seedState = snapshot["state"] as? [String: Any] ?? [:]
        seedState["files"] = state["files"] ?? [:]
        seedState["directories"] = state["directories"] ?? ["/documents"]
        seedState["appRevision"] = state["revision"] ?? 0
        if seedState["profile"] == nil { seedState["profile"] = payload["profile"] }
        snapshot["state"] = seedState
        snapshot["schemaVersion"] = 1
        snapshot["appRevision"] = state["revision"] ?? 0
        snapshot["generatedAt"] = snapshot["generatedAt"] ?? Self.timestamp()
        snapshot["diagnostics"] = diagnostics()
        // Private mirror provides app preview/export even when signing drops App Groups.
        try Self.write(snapshot, to: root.appendingPathComponent(Self.snapshotName))
        guard let sharedRoot = group.container else { return }
        do {
            let mirror = Self.compactWidgetSnapshot(snapshot)
            try Self.write(mirror, to: sharedRoot.appendingPathComponent(Self.snapshotName))
            lastMirrorError = nil
        } catch {
            lastMirrorError = error.localizedDescription
            throw error
        }
    }

    func widgetSetupExport() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        let snapshot = Self.compactWidgetSnapshot(try Self.object(Data(contentsOf: root.appendingPathComponent(Self.snapshotName))))
        return try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
    }

    func latestHTML() throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try Self.object(Data(contentsOf: root.appendingPathComponent(Self.snapshotName)))["html"] as? String
    }

    func diagnostics() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var values = group.diagnostics
        values["stateSchemaVersion"] = state["schemaVersion"] ?? Self.schemaVersion
        values["appRevision"] = state["revision"] ?? 0
        values["lastMirrorError"] = (lastMirrorError as Any?) ?? NSNull()
        values["extensionWritesAppState"] = false
        return values
    }

    /// Full backup includes notes, packing lists/checks, profiles, caches and wallpaper
    /// images without assuming the legacy program's folder/file names.
    func exportBackup() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        return try JSONSerialization.data(withJSONObject: [
            "format": "UniDay-backup", "backupVersion": 1,
            "exportedAt": Self.timestamp(), "state": state
        ], options: [.prettyPrinted, .sortedKeys])
    }

    func importBackup(_ bytes: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard bytes.count <= 150 * 1024 * 1024 else { throw StoreError.invalid("Резервная копия превышает 150 МБ.") }
        let backup = try Self.object(bytes)
        guard backup["format"] as? String == "UniDay-backup",
              (backup["backupVersion"] as? NSNumber)?.intValue == 1,
              let content = backup["state"] as? [String: Any] else {
            throw StoreError.invalid("Это не поддерживаемая резервная копия UniDay.")
        }
        var restored = try Self.migrate(content)
        for (path, value) in restored["files"] as? [String: Any] ?? [:] {
            _ = try Self.virtualPath(path)
            guard let file = value as? [String: Any],
                  ["text", "image"].contains(file["kind"] as? String ?? "") else {
                throw StoreError.invalid("Неверный файл в резервной копии.")
            }
            if file["kind"] as? String == "text", !(file["value"] is String) {
                throw StoreError.invalid("Неверный текст в резервной копии.")
            }
            if file["kind"] as? String == "image",
               !(file["dataURL"] as? String ?? "").hasPrefix("data:image/") {
                throw StoreError.invalid("Неверное изображение в резервной копии.")
            }
        }
        for path in restored["directories"] as? [String] ?? [] { _ = try Self.virtualPath(path) }
        // Keep a recoverable local copy before an explicit import replaces data.
        try Self.write(state, to: root.appendingPathComponent("before-last-import.json"))
        restored["revision"] = ((state["revision"] as? NSNumber)?.intValue ?? 0) + 1
        restored["updatedAt"] = Self.timestamp()
        try Self.write(restored, to: stateURL)
        state = restored
    }

    static func normalizedWidgetPayload(_ payload: [String: Any]) -> [String: Any] {
        var result = payload["snapshot"] as? [String: Any] ?? payload
        if let plans = payload["plans"] { result["plans"] = plans }
        if let profile = payload["profile"] {
            var seed = result["state"] as? [String: Any] ?? [:]
            seed["profile"] = profile
            result["state"] = seed
        }
        return result
    }

    /// Full screenshot sources/orphan crops belong to the app's editable wallpaper
    /// history and complete backup, not to a WidgetKit memory-limited process.
    /// Text caches remain exact. Each currently configured crop is stored once and
    /// native plans refer to it by virtual path rather than duplicate base64 bytes.
    static func compactWidgetSnapshot(_ snapshot: [String: Any]) -> [String: Any] {
        var result = snapshot
        result.removeValue(forKey: "html")
        var seed = result["state"] as? [String: Any] ?? [:]
        let profile = seed["profile"] as? [String: Any] ?? [:]
        let appearance = profile["appearance"] as? [String: Any] ?? [:]
        let backgrounds = appearance["wallpaperBackgrounds"] as? [String: Any] ?? [:]
        let folder = seed["dataFolder"] as? String ?? "UniDay-Personal"
        var paths: [String: String] = [:]
        for family in ["small", "medium", "large"] {
            if let entry = backgrounds[family] as? [String: Any], let file = entry["file"] as? String,
               !file.contains("/"), !file.contains("\\"), file.hasPrefix("widget-wallpaper-") {
                paths[family] = "/documents/" + folder + "/" + file
            }
        }
        let needed = Set(paths.values)
        let files = (seed["files"] as? [String: Any] ?? [:]).filter { path, value in
            guard let file = value as? [String: Any] else { return false }
            return file["kind"] as? String != "image" || needed.contains(path)
        }
        seed["files"] = files
        result["state"] = seed
        var plans = result["plans"] as? [String: Any] ?? [:]
        for (family, path) in paths {
            guard let image = files[path] as? [String: Any], image["kind"] as? String == "image",
                  var plan = plans[family] as? [String: Any],
                  var background = plan["background"] as? [String: Any] else { continue }
            background.removeValue(forKey: "image")
            background["imagePath"] = path
            plan["background"] = background
            plans[family] = plan
        }
        result["plans"] = plans
        return result
    }

    static func object(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw StoreError.invalid("Ожидался объект JSON.")
        }
        return object
    }

    static func write(_ object: [String: Any], to url: URL) throws {
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try bytes.write(to: url, options: [.atomic])
        #if os(iOS)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                               ofItemAtPath: url.path)
        #endif
    }

    static func timestamp(_ date: Date = Date()) -> String { ISO8601DateFormatter().string(from: date) }

    private static func emptyState() -> [String: Any] {
        ["schemaVersion": schemaVersion, "revision": 0, "files": [String: Any](),
         "directories": ["/documents"], "updatedAt": timestamp()]
    }

    private static func migrate(_ object: [String: Any]) throws -> [String: Any] {
        var object = object
        let version = (object["schemaVersion"] as? NSNumber)?.intValue ?? 0
        guard version >= 0, version <= schemaVersion else {
            throw StoreError.invalid("Данные созданы более новой версией UniDay. Они сохранены; установи совместимую версию.")
        }
        // v0 -> v1 preserves every unknown field and virtual file. Legacy profile
        // migrations still run inside the original 7.9.0 code after bootstrap.
        if version == 0 {
            if object["files"] == nil { object["files"] = [String: Any]() }
            if object["directories"] == nil { object["directories"] = ["/documents"] }
            if object["revision"] == nil { object["revision"] = 0 }
            object["schemaVersion"] = 1
        }
        guard object["files"] is [String: Any], object["directories"] is [String] else {
            throw StoreError.invalid("Хранилище UniDay повреждено. Исходный файл сохранён.")
        }
        return object
    }

    private static func virtualPath(_ path: String) throws -> String {
        guard path == "/documents" || path.hasPrefix("/documents/"),
              !path.contains("\u{0}"), !path.contains("\\"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(".."),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(".") else {
            throw StoreError.invalid("Путь вне виртуального каталога UniDay.")
        }
        return path
    }

    private static func addParents(_ path: String, to directories: inout Set<String>) {
        let parts = path.split(separator: "/")
        if parts.count > 1 {
            for count in 1..<parts.count { directories.insert("/" + parts.prefix(count).joined(separator: "/")) }
        }
    }
}

enum StoreError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}
