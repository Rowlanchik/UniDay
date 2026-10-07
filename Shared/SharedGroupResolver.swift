import Foundation

struct SharedGroupResolution {
    let identifier: String?
    let container: URL?
    let diagnostics: [String: Any]
}

/// Resolves the group from the installed signature/profile, never from a hardcoded
/// Apple team. AltStore rewrites identifiers when each user signs the same IPA.
enum SharedGroupResolver {
    static func resolve(bundle: Bundle = .main) -> SharedGroupResolution {
        let signature = signedEntitlements(bundle)
        let profile = provisioningProfile(bundle)
        let profileEntitlements = profile?["Entitlements"] as? [String: Any] ?? [:]
        let signedGroups = signature?["com.apple.security.application-groups"] as? [String] ?? []
        let allowedGroups = profileEntitlements["com.apple.security.application-groups"] as? [String] ?? []
        let declared = bundle.object(forInfoDictionaryKey: "ALTAppGroups") as? [String] ?? []
        let team = signature?["com.apple.developer.team-identifier"] as? String
            ?? profileEntitlements["com.apple.developer.team-identifier"] as? String
            ?? (profile?["TeamIdentifier"] as? [String])?.first
        // Signed entitlements have precedence. A provisioning profile is an allowlist,
        // not proof of an entitlement; fallback candidates are tested with the OS.
        let candidates = (signature != nil ? signedGroups : allowedGroups).filter { group in
            !group.contains("*") && group.hasPrefix("group.") &&
                (declared.isEmpty ? group.localizedCaseInsensitiveContains("uniday") :
                    declared.contains { group == $0 || group.hasPrefix($0 + ".") })
        }.sorted()
        var failures: [String] = []
        for candidate in candidates {
            guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: candidate) else {
                failures.append(candidate + ": контейнер недоступен")
                continue
            }
            let root = base.appendingPathComponent("UniDay", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                // A local read/write probe catches a profile allowlist that does not
                // grant this installed executable access. No other app is accessed.
                let probe = root.appendingPathComponent("probe-" + UUID().uuidString + ".json")
                let token = Data(UUID().uuidString.utf8)
                try token.write(to: probe, options: [.atomic])
                let echoed = try Data(contentsOf: probe)
                try FileManager.default.removeItem(at: probe)
                guard echoed == token else { throw StoreError.invalid("Проверка App Group не совпала.") }
                return SharedGroupResolution(identifier: candidate, container: root, diagnostics: [
                    "bundleIdentifier": bundle.bundleIdentifier ?? "unknown",
                    "teamIdentifier": (team as Any?) ?? NSNull(), "groupIdentifier": candidate,
                    "groupAvailable": true, "signedAppGroups": signedGroups,
                    "profileAllowedAppGroups": allowedGroups, "declaredAppGroups": declared,
                    "entitlementSource": signature != nil ? "installed-code-signature" : "provisioning-profile-fallback",
                    "groupAccessProbe": "passed", "groupFailures": failures
                ])
            } catch { failures.append(candidate + ": " + error.localizedDescription) }
        }
        return SharedGroupResolution(identifier: nil, container: nil, diagnostics: [
            "bundleIdentifier": bundle.bundleIdentifier ?? "unknown",
            "teamIdentifier": (team as Any?) ?? NSNull(), "groupIdentifier": NSNull(),
            "groupAvailable": false, "signedAppGroups": signedGroups,
            "profileAllowedAppGroups": allowedGroups, "declaredAppGroups": declared,
            "entitlementSource": signature != nil ? "installed-code-signature" : "provisioning-profile-fallback",
            "groupAccessProbe": "unavailable", "groupFailures": failures,
            "message": "Подпись не предоставляет доступ к общей группе. Данные приложения сохранены. Виджет требует отдельный экспорт настройки."
        ])
    }

    /// Extracts the XML entitlement slot from this executable's embedded signature.
    /// DER-only signatures fall back to the embedded profile. Bounds checks are
    /// deliberate: unsigned archives, simulator executables and truncated files
    /// must safely yield nil rather than guessing entitlements.
    private static func signedEntitlements(_ bundle: Bundle) -> [String: Any]? {
        guard let url = bundle.executableURL, let data = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return nil }
        var base = 0
        if u32(data, 0, big: true) == 0xcafebabe, let count = u32(data, 4, big: true), count > 0, count < 64 {
            // A running iOS executable normally has a single thin slice. A fat
            // development file can be inspected safely by trying each architecture.
            for index in 0..<Int(count) {
                if let offset = u32(data, 8 + index * 20 + 8, big: true),
                   let value = entitlements(data, base: Int(offset)) { return value }
            }
            return nil
        }
        base = 0
        return entitlements(data, base: base)
    }

    private static func entitlements(_ data: Data, base: Int) -> [String: Any]? {
        guard let magic = u32(data, base), magic == 0xfeedfacf || magic == 0xfeedface,
              let count = u32(data, base + 16), count < 4096,
              let commandBytes = u32(data, base + 20) else { return nil }
        var cursor = base + (magic == 0xfeedfacf ? 32 : 28)
        let commandEnd = cursor + Int(commandBytes)
        guard commandEnd <= data.count else { return nil }
        for _ in 0..<Int(count) {
            guard let command = u32(data, cursor), let length = u32(data, cursor + 4),
                  length >= 8, cursor + Int(length) <= commandEnd else { return nil }
            if command == 0x1d, length >= 16,
               let offset = u32(data, cursor + 8), let size = u32(data, cursor + 12) {
                let start = base + Int(offset), end = start + Int(size)
                guard end <= data.count, end >= start,
                      u32(data, start, big: true) == 0xfade0cc0,
                      let slots = u32(data, start + 8, big: true), slots < 1024 else { return nil }
                for index in 0..<Int(slots) {
                    let entry = start + 12 + index * 8
                    guard entry + 8 <= end, let type = u32(data, entry, big: true),
                          let relative = u32(data, entry + 4, big: true) else { return nil }
                    if type == 5 {
                        let blob = start + Int(relative)
                        guard u32(data, blob, big: true) == 0xfade7171,
                              let size = u32(data, blob + 4, big: true), size >= 8,
                              blob + Int(size) <= end else { return nil }
                        let plist = data.subdata(in: (blob + 8)..<(blob + Int(size)))
                        return (try? PropertyListSerialization.propertyList(from: plist, options: [], format: nil)) as? [String: Any]
                    }
                }
            }
            cursor += Int(length)
        }
        return nil
    }

    private static func provisioningProfile(_ bundle: Bundle) -> [String: Any]? {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return nil }
        let plist = data.subdata(in: start.lowerBound..<end.upperBound)
        return (try? PropertyListSerialization.propertyList(from: plist, options: [], format: nil)) as? [String: Any]
    }

    private static func u32(_ data: Data, _ offset: Int, big: Bool = false) -> UInt32? {
        guard offset >= 0, offset <= data.count - 4 else { return nil }
        let bytes = [UInt8](data[offset..<(offset + 4)])
        if big { return bytes.reduce(0) { ($0 << 8) | UInt32($1) } }
        return UInt32(bytes[0]) | UInt32(bytes[1]) << 8 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 24
    }
}
