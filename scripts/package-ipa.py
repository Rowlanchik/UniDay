#!/usr/bin/env python3
"""Package a built .app, preserving its one WidgetKit extension and Unix metadata."""
from __future__ import annotations

import argparse
import os
import plistlib
import stat
import sys
import time
import zipfile
from pathlib import Path


def read_info(bundle: Path) -> dict:
    with (bundle / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    executable = info.get("CFBundleExecutable")
    if not isinstance(executable, str) or Path(executable).name != executable:
        raise ValueError(f"Invalid CFBundleExecutable in {bundle.name}")
    if not (bundle / executable).is_file():
        raise ValueError(f"Missing executable in {bundle.name}: {executable}")
    return info


def package_ipa(app: Path, output: Path) -> None:
    app = app.resolve()
    output = output.resolve()
    if not app.is_dir() or app.suffix != ".app":
        raise ValueError("--app must point to the built .app directory")
    if output == app or app in output.parents:
        raise ValueError("Output must be outside the application bundle")
    main_info = read_info(app)
    extensions = sorted((app / "PlugIns").glob("*.appex"))
    if len(extensions) != 1:
        raise ValueError("UniDay must contain exactly one preserved WidgetKit extension")
    extension_info = read_info(extensions[0])
    if extension_info.get("NSExtension", {}).get("NSExtensionPointIdentifier") != "com.apple.widgetkit-extension":
        raise ValueError("Embedded extension is not WidgetKit")
    main_id = main_info.get("CFBundleIdentifier", "")
    if not extension_info.get("CFBundleIdentifier", "").startswith(main_id + "."):
        raise ValueError("Widget bundle identifier must be beneath the application identifier")
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        if main_info.get(key) != extension_info.get(key):
            raise ValueError(f"App and widget disagree on {key}")

    executables = {app / main_info["CFBundleExecutable"], extensions[0] / extension_info["CFBundleExecutable"]}
    for plist in app.rglob("Info.plist"):
        if plist.parent.suffix == ".framework" and not plist.is_symlink():
            info = plistlib.loads(plist.read_bytes())
            name = info.get("CFBundleExecutable")
            if isinstance(name, str) and Path(name).name == name and (plist.parent / name).is_file():
                executables.add(plist.parent / name)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in [app, *sorted(app.rglob("*"))]:
                relative = Path("Payload") / app.name / path.relative_to(app)
                mode = path.lstat().st_mode
                timestamp = time.localtime(path.lstat().st_mtime)[:6]
                timestamp = (1980, 1, 1, 0, 0, 0) if timestamp[0] < 1980 else timestamp
                info = zipfile.ZipInfo(relative.as_posix() + ("/" if stat.S_ISDIR(mode) else ""), timestamp)
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                if path in executables and not stat.S_ISLNK(mode):
                    mode |= 0o111
                    if os.name != "nt":
                        path.chmod(stat.S_IMODE(mode))
                info.external_attr = (mode << 16) | (0x10 if stat.S_ISDIR(mode) else 0)
                if stat.S_ISLNK(mode):
                    target = os.readlink(path)
                    resolved_target = (path.parent / target).resolve()
                    if os.path.isabs(target) or (resolved_target != app and app not in resolved_target.parents):
                        raise ValueError(f"Symlink escapes the app: {relative}")
                    archive.writestr(info, target.encode("utf-8"))
                elif stat.S_ISDIR(mode):
                    archive.writestr(info, b"")
                elif stat.S_ISREG(mode):
                    archive.writestr(info, path.read_bytes())
                else:
                    raise ValueError(f"Unsupported file type: {relative}")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        package_ipa(args.app, args.output)
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        parser.exit(1, f"Packaging failed: {error}\n")
    print(f"IPA packaged: {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
