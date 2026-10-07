"""Distribution tests exercise IPA contents, signed permissions, history and failure paths."""
from __future__ import annotations

import importlib.util
import json
import os
import plistlib
import stat
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load("package-ipa")
source = load("update-source")


def signed_macho(entitlements):
    xml = plistlib.dumps(entitlements)
    blob = struct.pack(">II", 0xFADE7171, 8 + len(xml)) + xml
    signature = struct.pack(">III", 0xFADE0CC0, 20 + len(blob), 1) + struct.pack(">II", 5, 20) + blob
    header = struct.pack("<IIIIIIII", 0xFEEDFACF, 0x0100000C, 0, 2, 1, 16, 0, 0)
    command = struct.pack("<IIII", 0x1D, 16, 48, len(signature))
    return header + command + signature


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("UNIDAY_TEST_TMP"))
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.app = self.folder / "UniDay.app"
        self.widget = self.app / "PlugIns" / "UniDayWidget.appex"
        self.widget.mkdir(parents=True)
        self.main_info = {"CFBundleIdentifier": source.APP_ID, "CFBundleExecutable": "UniDay",
                          "CFBundleShortVersionString": "8.0.0", "CFBundleVersion": "1", "MinimumOSVersion": "17.0"}
        self.widget_info = dict(self.main_info, CFBundleIdentifier=source.APP_ID + ".Widget", CFBundleExecutable="UniDayWidget",
                                NSExtension={"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"})
        self.entitlements = {"com.apple.security.application-groups": [source.APP_GROUP]}
        self.write_bundle(self.app, self.main_info, self.entitlements)
        self.write_bundle(self.widget, self.widget_info, self.entitlements)
        self.ipa = self.folder / "UniDay-8.0.0.ipa"

    def write_bundle(self, bundle, info, entitlements):
        (bundle / "Info.plist").write_bytes(plistlib.dumps(info))
        (bundle / info["CFBundleExecutable"]).write_bytes(signed_macho(entitlements))

    def make_ipa(self):
        package.package_ipa(self.app, self.ipa)
        return self.ipa

    def publish(self, existing=None, tag="v8.0.0"):
        return source.update_source(self.make_ipa(), existing, "Rowlanchik/UniDay", tag, "Проверка виджета", "2026-10-07T10:00:00Z")

    def test_packaging_retains_widget_and_executable_permissions(self):
        self.make_ipa()
        with zipfile.ZipFile(self.ipa) as archive:
            widget_binary = "Payload/UniDay.app/PlugIns/UniDayWidget.appex/UniDayWidget"
            self.assertIn(widget_binary, archive.namelist())
            self.assertEqual(archive.read(widget_binary), signed_macho(self.entitlements))
            self.assertEqual(stat.S_IMODE(archive.getinfo(widget_binary).external_attr >> 16) & 0o111, 0o111)
            self.assertEqual(archive.getinfo(widget_binary).create_system, 3)

    def test_preserves_internal_symlink(self):
        if os.name == "nt":
            self.skipTest("Windows symlink creation requires special privileges; runs on macOS CI")
        framework = self.app / "Frameworks" / "Example.framework"
        target = framework / "Versions" / "A"
        target.mkdir(parents=True)
        (target / "Example").write_bytes(b"framework")
        (framework / "Example").symlink_to("Versions/A/Example")
        self.make_ipa()
        with zipfile.ZipFile(self.ipa) as archive:
            entry = archive.getinfo("Payload/UniDay.app/Frameworks/Example.framework/Example")
            self.assertTrue(stat.S_ISLNK(entry.external_attr >> 16))
            self.assertEqual(archive.read(entry), b"Versions/A/Example")

    def test_exact_ipa_permissions_include_extension_only_entitlement_and_privacy(self):
        widget_entitlements = dict(self.entitlements, **{"com.apple.developer.siri": True})
        self.widget_info["NSLocationWhenInUseUsageDescription"] = "Погода для выбранной точки"
        self.write_bundle(self.widget, self.widget_info, widget_entitlements)
        result = self.publish()
        permissions = result["apps"][0]["appPermissions"]
        self.assertEqual(permissions["entitlements"], ["com.apple.developer.siri", "com.apple.security.application-groups"])
        self.assertEqual(permissions["privacy"], {"NSLocationWhenInUseUsageDescription": "Погода для выбранной точки"})
        release = result["apps"][0]["versions"][0]
        self.assertEqual(release["size"], self.ipa.stat().st_size)
        self.assertEqual(release["downloadURL"], "https://github.com/Rowlanchik/UniDay/releases/download/v8.0.0/UniDay-8.0.0.ipa")
        self.assertEqual(len(release["sha256"]), 64)
        self.assertEqual(result["website"], "https://rowlanchik.github.io/UniDay")

    def test_keeps_previous_stable_and_idempotent_same_release(self):
        first = self.publish()
        first_entry = dict(first["apps"][0]["versions"][0])
        repeat = source.update_source(self.ipa, first, "Rowlanchik/UniDay", "v8.0.0", "same", "2026-10-08T10:00:00Z")
        self.assertEqual(repeat["apps"][0]["versions"], [first_entry])
        self.main_info["CFBundleShortVersionString"] = "8.0.1"
        self.widget_info["CFBundleShortVersionString"] = "8.0.1"
        self.main_info["CFBundleVersion"] = self.widget_info["CFBundleVersion"] = "2"
        self.write_bundle(self.app, self.main_info, self.entitlements)
        self.write_bundle(self.widget, self.widget_info, self.entitlements)
        self.ipa = self.folder / "UniDay-8.0.1.ipa"
        second = self.publish(first, "v8.0.1")
        self.assertEqual([entry["version"] for entry in second["apps"][0]["versions"]], ["8.0.1", "8.0.0"])
        self.assertEqual(second["apps"][0]["versions"][1], first_entry)
        self.assertEqual(first["apps"][0]["versions"], [first_entry])

    def test_refuses_replacing_published_same_version_with_different_ipa(self):
        first = self.publish()
        (self.app / "changed-resource.txt").write_text("different build bytes")
        with self.assertRaisesRegex(ValueError, "already published"):
            self.publish(first)

    def test_missing_or_removed_widget_is_rejected(self):
        self.widget.rename(self.widget.with_suffix(".removed"))
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.make_ipa()

    def test_unsigned_executable_cannot_silently_drop_app_group(self):
        (self.app / "UniDay").write_bytes(struct.pack("<IIIIIIII", 0xFEEDFACF, 0x0100000C, 0, 2, 0, 0, 0, 0))
        with self.assertRaisesRegex(ValueError, "ad-hoc entitlements"):
            self.publish()

    def test_bad_group_and_wrong_tag_are_rejected(self):
        self.write_bundle(self.widget, self.widget_info, {"com.apple.security.application-groups": ["group.other"]})
        with self.assertRaisesRegex(ValueError, "same UniDay"):
            self.publish()
        self.write_bundle(self.widget, self.widget_info, self.entitlements)
        with self.assertRaisesRegex(ValueError, "exact IPA version"):
            self.publish(tag="v8.0.2")

    def test_full_semver_and_matching_widget_build_are_required(self):
        self.main_info["CFBundleShortVersionString"] = self.widget_info["CFBundleShortVersionString"] = "8.0"
        self.write_bundle(self.app, self.main_info, self.entitlements)
        self.write_bundle(self.widget, self.widget_info, self.entitlements)
        with self.assertRaisesRegex(ValueError, "full stable"):
            self.publish(tag="v8.0")
        self.main_info["CFBundleShortVersionString"] = self.widget_info["CFBundleShortVersionString"] = "8.0.0"
        self.widget_info["CFBundleVersion"] = "2"
        self.write_bundle(self.app, self.main_info, self.entitlements)
        self.write_bundle(self.widget, self.widget_info, self.entitlements)
        with self.assertRaisesRegex(ValueError, "disagree"):
            self.make_ipa()

    def test_fat_binary_architecture_entitlements_must_match(self):
        first = signed_macho(self.entitlements)
        second = signed_macho(dict(self.entitlements, **{"com.apple.developer.siri": True}))
        first_offset = 8 + 40
        second_offset = first_offset + len(first)
        header = struct.pack(">II", 0xCAFEBABE, 2)
        header += struct.pack(">IIIII", 0x0100000C, 0, first_offset, len(first), 0)
        header += struct.pack(">IIIII", 0x0100000C, 1, second_offset, len(second), 0)
        with self.assertRaisesRegex(ValueError, "different entitlements"):
            source.macho_entitlements(header + first + second)
        matching = signed_macho(self.entitlements)
        self.assertEqual(source.macho_entitlements(header[:28] + struct.pack(">IIIII", 0x0100000C, 1, second_offset, len(matching), 0) + first + matching), self.entitlements)

    def test_temporary_artifact_links_in_previous_history_are_rejected(self):
        initial = self.publish()
        initial["apps"][0]["versions"][0]["downloadURL"] = "https://github.com/Rowlanchik/UniDay/actions/runs/123/artifacts/456"
        with self.assertRaisesRegex(ValueError, "persistent public"):
            source.update_source(self.ipa, initial, "Rowlanchik/UniDay", "v8.0.0", "test")

    def test_truncated_signature_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Truncated"):
            source.macho_entitlements(signed_macho(self.entitlements)[:-1])


if __name__ == "__main__":
    unittest.main()
