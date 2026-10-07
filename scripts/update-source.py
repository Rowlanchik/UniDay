#!/usr/bin/env python3
"""Generate an AltStore source from the exact IPA, including Mach-O entitlements."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import plistlib
import re
import stat
import struct
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlparse

APP_ID = "io.github.rowlanchik09.UniDay"
APP_GROUP = "group.io.github.rowlanchik09.UniDay"
SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\Z")
BUILD = re.compile(r"[1-9]\d*(?:\.(?:0|[1-9]\d*)){0,2}\Z")


def checked_range(data: bytes, offset: int, length: int) -> bytes:
    if offset < 0 or length < 0 or offset + length > len(data):
        raise ValueError("Truncated Mach-O or code signature")
    return data[offset:offset + length]


def macho_entitlements(data: bytes) -> dict:
    """Read XML entitlements from LC_CODE_SIGNATURE; do not trust a source template."""
    if len(data) < 4:
        raise ValueError("Executable is not Mach-O")
    magic = struct.unpack_from(">I", data)[0]
    if magic in (0xCAFEBABE, 0xCAFEBABF, 0xBEBAFECA, 0xBFBAFECA):
        endian = ">" if magic in (0xCAFEBABE, 0xCAFEBABF) else "<"
        is64 = magic in (0xCAFEBABF, 0xBFBAFECA)
        count = struct.unpack(endian + "I", checked_range(data, 4, 4))[0]
        if count < 1 or count > 32:
            raise ValueError("Invalid FAT architecture count")
        stride = 32 if is64 else 20
        results = []
        for index in range(count):
            entry = checked_range(data, 8 + index * stride, stride)
            if is64:
                _, _, offset, size, _, _ = struct.unpack(endian + "IIQQII", entry)
            else:
                _, _, offset, size, _ = struct.unpack(endian + "IIIII", entry)
            results.append(macho_entitlements(checked_range(data, offset, size)))
        if any(result != results[0] for result in results):
            raise ValueError("Architectures have different entitlements")
        return results[0]

    variants = {b"\xcf\xfa\xed\xfe": ("<", 32), b"\xce\xfa\xed\xfe": ("<", 28),
                b"\xfe\xed\xfa\xcf": (">", 32), b"\xfe\xed\xfa\xce": (">", 28)}
    if data[:4] not in variants:
        raise ValueError("Executable is not Mach-O")
    endian, header_size = variants[data[:4]]
    count, command_bytes = struct.unpack(endian + "II", checked_range(data, 16, 8))
    checked_range(data, header_size, command_bytes)
    position = header_size
    signatures = []
    for _ in range(count):
        command, size = struct.unpack(endian + "II", checked_range(data, position, 8))
        if size < 8 or position + size > header_size + command_bytes:
            raise ValueError("Invalid Mach-O load command")
        if command == 0x1D:
            if size < 16:
                raise ValueError("Invalid LC_CODE_SIGNATURE")
            offset, length = struct.unpack(endian + "II", checked_range(data, position + 8, 8))
            signatures.append(checked_range(data, offset, length))
        position += size
    if len(signatures) != 1:
        raise ValueError("Executable lacks its one code signature; add ad-hoc entitlements before packaging")
    signature = signatures[0]
    sig_magic, sig_length, sig_count = struct.unpack(">III", checked_range(signature, 0, 12))
    if sig_magic != 0xFADE0CC0 or sig_length > len(signature) or sig_count > 64:
        raise ValueError("Invalid code-signature superblob")
    signature = checked_range(signature, 0, sig_length)
    entitlements = []
    for index in range(sig_count):
        slot, offset = struct.unpack(">II", checked_range(signature, 12 + index * 8, 8))
        blob_magic, blob_size = struct.unpack(">II", checked_range(signature, offset, 8))
        blob = checked_range(signature, offset + 8, blob_size - 8)
        if slot == 5 and blob_magic == 0xFADE7171:
            value = plistlib.loads(blob)
            if not isinstance(value, dict):
                raise ValueError("Entitlements must be a plist dictionary")
            entitlements.append(value)
    if len(entitlements) != 1:
        raise ValueError("XML entitlements absent; preserve them for AltStore (DER alone is insufficient)")
    return entitlements[0]


def inspect_ipa(ipa: Path) -> dict:
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("IPA has duplicate archive entries")
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError("Unsafe path in IPA")
        main_plists = [name for name in names if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
        if len(main_plists) != 1:
            raise ValueError("IPA must contain exactly one main .app")
        main_path = main_plists[0].rsplit("/", 1)[0]
        extension_plists = [name for name in names if re.fullmatch(re.escape(main_path) + r"/PlugIns/[^/]+\.appex/Info\.plist", name)]
        if len(extension_plists) != 1:
            raise ValueError("IPA must preserve exactly one widget extension")
        infos, entitlements = [], []
        for name in main_plists + extension_plists:
            info = plistlib.loads(archive.read(name))
            executable = info.get("CFBundleExecutable")
            if not isinstance(executable, str) or PurePosixPath(executable).name != executable:
                raise ValueError("Invalid bundle executable")
            binary_path = name.rsplit("/", 1)[0] + "/" + executable
            binary_info = archive.getinfo(binary_path)
            if stat.S_ISLNK(binary_info.external_attr >> 16):
                raise ValueError("App and widget executables cannot be symlinks")
            infos.append(info)
            entitlements.append(macho_entitlements(archive.read(binary_path)))
        main, widget = infos
        if main.get("CFBundleIdentifier") != APP_ID:
            raise ValueError("Unexpected UniDay bundle identifier (keep it stable across releases)")
        if widget.get("CFBundleIdentifier") != APP_ID + ".Widget":
            raise ValueError("Unexpected Widget bundle identifier")
        if widget.get("NSExtension", {}).get("NSExtensionPointIdentifier") != "com.apple.widgetkit-extension":
            raise ValueError("Embedded extension is not WidgetKit")
        for key in ("CFBundleShortVersionString", "CFBundleVersion"):
            if widget.get(key) != main.get(key):
                raise ValueError(f"App and widget disagree on {key}")
        version, build = main.get("CFBundleShortVersionString"), main.get("CFBundleVersion")
        if not isinstance(version, str) or not SEMVER.fullmatch(version):
            raise ValueError("CFBundleShortVersionString must be a full stable X.Y.Z version")
        if not isinstance(build, str) or not BUILD.fullmatch(build):
            raise ValueError("Invalid CFBundleVersion")
        for value in entitlements:
            if value.get("com.apple.security.application-groups") != [APP_GROUP]:
                raise ValueError("App and widget must request only the same UniDay App Group")
        permission_keys = set().union(*(value.keys() for value in entitlements))
        permission_keys -= {"application-identifier", "com.apple.developer.team-identifier"}
        if entitlements[0].get("get-task-allow") is False:
            permission_keys.discard("get-task-allow")
        privacy = {}
        for info in infos:
            for key, value in info.items():
                if key.startswith("NS") and "UsageDescription" in key:
                    if not isinstance(value, str) or not value.strip():
                        raise ValueError(f"Empty privacy description: {key}")
                    if key in privacy and privacy[key] != value:
                        raise ValueError(f"Conflicting app/widget privacy description: {key}")
                    privacy[key] = value
        os_versions = [info.get("MinimumOSVersion") for info in infos]
        if any(not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", value) for value in os_versions):
            raise ValueError("App and widget must contain valid MinimumOSVersion values")
        min_os = max(os_versions, key=lambda value: tuple(int(part) for part in value.split(".")))
        return {"version": version, "buildVersion": build, "minOSVersion": min_os,
                "appPermissions": {"entitlements": sorted(permission_keys), "privacy": dict(sorted(privacy.items()))}}


def version_key(version: dict) -> tuple:
    number, build = version.get("version"), version.get("buildVersion")
    if not isinstance(number, str) or not SEMVER.fullmatch(number):
        raise ValueError("Existing source has an invalid full version")
    if not isinstance(build, str) or not BUILD.fullmatch(build):
        raise ValueError("Existing source has an invalid buildVersion")
    build_parts = tuple(int(part) for part in build.split("."))
    return tuple(int(part) for part in number.split(".")), build_parts + (0,) * (3 - len(build_parts))


def update_source(ipa: Path, source: dict | None, repository: str, tag: str, notes: str,
                  date: str | None = None) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("--repository must be public OWNER/REPOSITORY")
    metadata = inspect_ipa(ipa)
    if tag != "v" + metadata["version"]:
        raise ValueError("Release tag must be v followed by the exact IPA version")
    if not notes.strip():
        raise ValueError("Release notes cannot be empty")
    owner, repo = repository.split("/")
    website = f"https://{owner.lower()}.github.io/{repo}"
    download = f"https://github.com/{repository}/releases/download/{quote(tag, safe='')}/{quote(ipa.name, safe='')}"
    release = {key: metadata[key] for key in ("version", "buildVersion", "minOSVersion")}
    release.update({"date": date or dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                    "localizedDescription": notes.strip(), "downloadURL": download,
                    "size": ipa.stat().st_size, "sha256": hashlib.sha256(ipa.read_bytes()).hexdigest()})
    result = copy.deepcopy(source) if source else {"name": "UniDay", "identifier": "io.github.rowlanchik09.UniDay.source",
        "subtitle": "Расписание, транспорт и виджет", "description": "Бесплатный источник UniDay. Каждый пользователь настраивает свой профиль локально.",
        "website": website, "iconURL": website + "/icon.png", "tintColor": "#487BFF", "apps": [], "news": []}
    apps = result.setdefault("apps", [])
    matches = [app for app in apps if app.get("bundleIdentifier") == APP_ID]
    if len(matches) > 1:
        raise ValueError("Source contains duplicate UniDay apps")
    if matches:
        app = matches[0]
    else:
        app = {"name": "UniDay", "bundleIdentifier": APP_ID, "developerName": "UniDay",
               "subtitle": "Ваш учебный день", "localizedDescription": "Расписание, автобусы, погода, заметки и списки вещей с виджетом рабочего стола.",
               "iconURL": website + "/icon.png", "tintColor": "#487BFF", "category": "utilities", "versions": []}
        apps.append(app)
    previous = app.setdefault("versions", [])
    pairs = set()
    for entry in previous:
        version_key(entry)
        pair = entry["version"], entry["buildVersion"]
        if pair in pairs:
            raise ValueError("Existing source has duplicate version/build entries")
        pairs.add(pair)
        url = urlparse(entry.get("downloadURL", ""))
        if url.scheme != "https" or url.netloc != "github.com" or "/releases/download/" not in url.path:
            raise ValueError("Previous stable versions must use persistent public GitHub Release URLs")
    existing = next((entry for entry in previous if (entry["version"], entry["buildVersion"]) == (release["version"], release["buildVersion"])), None)
    if existing:
        for key in ("sha256", "size", "downloadURL", "minOSVersion"):
            if existing.get(key) != release[key]:
                raise ValueError("This exact version/build was already published with different IPA metadata; increment it")
    else:
        if previous and version_key(release) <= max(version_key(entry) for entry in previous):
            raise ValueError("New release must be newer than the published source (avoids accidental downgrade)")
        previous.insert(0, release)
    app["appPermissions"] = metadata["appPermissions"]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ipa", required=True, type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--notes", required=True, type=Path)
    args = parser.parse_args()
    try:
        existing = json.loads(args.source.read_text(encoding="utf-8")) if args.source and args.source.exists() else None
        result = update_source(args.ipa, existing, args.repository, args.tag, args.notes.read_text(encoding="utf-8"))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.output)
    except (ValueError, OSError, KeyError, struct.error, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        parser.exit(1, f"Source generation failed: {error}\n")
    print(f"Source updated from exact IPA: {args.output}")


if __name__ == "__main__":
    main()
