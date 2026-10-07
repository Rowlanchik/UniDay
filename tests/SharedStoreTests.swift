import Foundation

@main
struct SharedStoreTests {
    static func main() throws {
        let testRoot = FileManager.default.temporaryDirectory.appendingPathComponent("UniDay-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: testRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: testRoot) }
        let noGroup = SharedGroupResolution(identifier: nil, container: nil, diagnostics: ["groupAvailable": false])
        let storeRoot = testRoot.appendingPathComponent("normal")
        let store = try SharedStore(rootURL: storeRoot, groupResolution: noGroup)
        let notes = "/documents/My-profile/lesson-notes.json"
        let calendar = "/documents/UniDay-Personal/profile.json"
        try store.apply([
            ["op": "writeText", "path": notes, "value": "{\"a\":\"Private note\"}"],
            ["op": "writeText", "path": calendar, "value": "{\"calendarURL\":\"https://example.test/private.ics\",\"stops\":[1,2]}"],
            ["op": "writeText", "path": "/documents/My-profile/packing.json", "value": "{\"books\":[\"book\"]}"],
            ["op": "writeText", "path": "/documents/My-profile/packing-checks.json", "value": "{\"2026-10-07\":[\"book\"]}"],
            ["op": "writeImage", "path": "/documents/My-profile/widget.png", "dataURL": "data:image/png;base64,AA==", "width": 1, "height": 1],
            ["op": "writeImage", "path": "/documents/My-profile/default-dimensions.png", "dataURL": "data:image/png;base64,AA=="]
        ])
        let before = try store.exportBackup()
        let reinstalled = try SharedStore(rootURL: storeRoot, groupResolution: noGroup)
        check(try reinstalled.exportBackupState() == store.exportBackupState(), "Version update/reinitialization must preserve every file")
        let defaultImage = (reinstalled.readState()["files"] as? [String: Any])?["/documents/My-profile/default-dimensions.png"] as? [String: Any] ?? [:]
        check((defaultImage["width"] as? NSNumber)?.intValue == 0 && (defaultImage["height"] as? NSNumber)?.intValue == 0,
              "Images without dimensions must atomically persist numeric zero defaults")
        let countBefore = (reinstalled.readState()["files"] as? [String: Any])?.count
        do {
            try reinstalled.apply([
                ["op": "writeText", "path": "/documents/temporary.json", "value": "partial"],
                ["op": "writeText", "path": "/documents/../../outside", "value": "must fail"]
            ])
            fatalError("Traversal accepted")
        } catch {}
        check((reinstalled.readState()["files"] as? [String: Any])?.count == countBefore, "Invalid batch must not partially commit")
        try reinstalled.apply([["op": "remove", "path": "/documents/My-profile"]])
        try reinstalled.importBackup(before)
        check(try reinstalled.exportBackupState() == store.exportBackupState(ignoringRevision: true), "Backup must restore calendar/stops/notes/checks/images")
        check(FileManager.default.fileExists(atPath: storeRoot.appendingPathComponent("before-last-import.json").path), "Import must preserve prior local data")

        let migrationRoot = testRoot.appendingPathComponent("migration")
        try FileManager.default.createDirectory(at: migrationRoot, withIntermediateDirectories: true)
        let versionZero: [String: Any] = ["files": [notes: ["kind": "text", "value": "legacy"]],
                                          "directories": ["/documents"], "unknownFuturePreference": "preserve"]
        try SharedStore.write(versionZero, to: migrationRoot.appendingPathComponent("state-v1.json"))
        let migrated = try SharedStore(rootURL: migrationRoot, groupResolution: noGroup)
        check((migrated.readState()["schemaVersion"] as? NSNumber)?.intValue == 1, "v0 must migrate to v1")
        check(migrated.readState()["unknownFuturePreference"] as? String == "preserve", "Migration must retain unknown fields")
        let futureRoot = testRoot.appendingPathComponent("future")
        try FileManager.default.createDirectory(at: futureRoot, withIntermediateDirectories: true)
        let futureURL = futureRoot.appendingPathComponent("state-v1.json")
        try SharedStore.write(["schemaVersion": 999, "files": [:], "directories": ["/documents"]], to: futureURL)
        let original = try Data(contentsOf: futureURL)
        do { _ = try SharedStore(rootURL: futureRoot, groupResolution: noGroup); fatalError("Future format accepted") } catch {}
        check(try Data(contentsOf: futureURL) == original, "Unsupported future data must be preserved unchanged")

        let sharedRoot = testRoot.appendingPathComponent("shared")
        try FileManager.default.createDirectory(at: sharedRoot, withIntermediateDirectories: true)
        let fakeGroup = SharedGroupResolution(identifier: "group.test.UniDay.ACCOUNT_A", container: sharedRoot, diagnostics: ["groupAvailable": true])
        let mirrored = try SharedStore(rootURL: testRoot.appendingPathComponent("mirror-app"), groupResolution: fakeGroup)
        try mirrored.apply([["op": "writeText", "path": notes, "value": "app-owned"]])
        try mirrored.publishWidget(["plans": [:], "snapshot": ["state": ["profile": ["calendarURL": "private"]]]])
        let mirror = try SharedStore.object(Data(contentsOf: sharedRoot.appendingPathComponent(SharedStore.snapshotName)))
        check((mirror["appRevision"] as? NSNumber)?.intValue == 1, "Mirror must carry the app revision")
        try SharedStore.write(["snapshot": ["state": ["files": [:]]]], to: sharedRoot.appendingPathComponent(SharedStore.widgetCacheName))
        check((mirrored.readState()["files"] as? [String: Any])?[notes] != nil, "Extension cache must never overwrite app state")
        let crop = "/documents/UniDay-Personal/widget-wallpaper-small.png"
        let source = "/documents/UniDay-Personal/widget-source-small-1-1.png"
        let orphan = "/documents/UniDay-Personal/widget-wallpaper-small-2-2.png"
        try mirrored.apply([crop, source, orphan].map { ["op": "writeImage", "path": $0,
                                                       "dataURL": "data:image/png;base64,AA==", "width": 1, "height": 1] })
        let profile: [String: Any] = ["appearance": ["wallpaperBackgrounds": ["small": ["file": "widget-wallpaper-small.png", "source": "widget-source-small-1-1.png"]]]]
        try mirrored.publishWidget(["snapshot": ["html": "<html>private notes</html>",
                                                   "state": ["profile": profile, "dataFolder": "UniDay-Personal"],
                                                   "plans": ["small": ["groups": [], "background": ["mode": "wallpaper", "image": ["dataURL": "data:image/png;base64,AA=="]]]]]])
        let compact = try SharedStore.object(Data(contentsOf: sharedRoot.appendingPathComponent(SharedStore.snapshotName)))
        let compactFiles = (compact["state"] as? [String: Any])?["files"] as? [String: Any] ?? [:]
        check(compactFiles[crop] != nil && compactFiles[source] == nil && compactFiles[orphan] == nil,
              "Widget mirror must keep current crop and exclude screenshot sources/orphans")
        check(compactFiles[notes] != nil, "Widget text/cache state must remain exact")
        let compactBackground = (((compact["plans"] as? [String: Any])?["small"] as? [String: Any])?["background"] as? [String: Any]) ?? [:]
        check(compactBackground["imagePath"] as? String == crop && compactBackground["image"] == nil,
              "Widget plan must reference one crop instead of duplicate bytes")
        let privateHTML = try mirrored.latestHTML()
        check(compact["html"] == nil && privateHTML == "<html>private notes</html>",
              "HTML must stay private while cached Shortcuts preserve it")
        let fullFiles = mirrored.readState()["files"] as? [String: Any] ?? [:]
        check(fullFiles[source] != nil && fullFiles[orphan] != nil, "Wallpaper editing history must remain in app state/full backup")
        let independent = try SharedStore.object(mirrored.widgetSetupExport())
        let independentFiles = (independent["state"] as? [String: Any])?["files"] as? [String: Any] ?? [:]
        check(independent["html"] == nil && independentFiles[crop] != nil && independentFiles[source] == nil,
              "Independent widget setup must use the same compact image selection")
        print("SharedStore: persistence, complete backup, atomic batches, traversal, v0 migration, future-format preservation, mirror isolation and compact wallpaper selection passed")
    }

    static func check(_ result: Bool, _ message: String) {
        if !result { fatalError(message) }
    }
}

private extension SharedStore {
    func exportBackupState(ignoringRevision: Bool = true) throws -> Data {
        var content = readState()
        if ignoringRevision { content.removeValue(forKey: "revision"); content.removeValue(forKey: "updatedAt") }
        return try JSONSerialization.data(withJSONObject: content, options: [.sortedKeys])
    }
}
