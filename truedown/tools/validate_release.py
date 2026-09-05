"""Validate the complete TrueDown release without extracting archive paths."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import stat
import struct
import tarfile
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_package(archive):
    files = {}
    directories = set()
    seen = set()

    def add(name, mode, is_directory, data):
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts
                and "\\" not in name and ":" not in name, f"Unsafe path: {name}")
        require(name not in seen, f"Duplicate entry: {name}")
        seen.add(name)
        expected_type = stat.S_IFDIR if is_directory else stat.S_IFREG
        require(stat.S_IFMT(mode) in (0, expected_type), f"Non-regular entry: {name}")
        if is_directory:
            directories.add(path)
        else:
            require(data, f"Empty entry: {name}")
            files[name] = (mode, data)

    if archive.name.endswith(".tar.gz"):
        with tarfile.open(archive, "r:gz") as package:
            for entry in package:
                require(entry.isdir() or entry.isfile(), f"Non-regular entry: {entry.name}")
                data = package.extractfile(entry).read() if entry.isfile() else None
                add(entry.name, entry.mode, entry.isdir(), data)
    else:
        with zipfile.ZipFile(archive) as package:
            for entry in package.infolist():
                add(entry.filename, entry.external_attr >> 16, entry.is_dir(),
                    None if entry.is_dir() else package.read(entry))
    parents = {parent for name in files for parent in PurePosixPath(name).parents}
    require(directories <= parents, f"Unexpected directories in {archive.name}")
    return files


def validate_package(archive, system, arch, build):
    files = read_package(archive)
    docs = {"README.md", "THIRD_PARTY_NOTICES.md"}
    if system == "windows":
        expected = {"TrueDown.exe", "aria2c.exe", "ARIA2_COPYING", "THIRD_PARTY_NOTICES.md"}
        binary = "TrueDown.exe"
    elif system == "linux":
        prefix = f"TrueDown-linux-{arch}/"
        expected = {prefix + name for name in docs | {"TrueDown", "truedown.desktop", "truedown.svg"}}
        binary = prefix + "TrueDown"
    else:
        binary = "TrueDown.app/Contents/MacOS/TrueDown"
        expected = docs | {binary, "TrueDown.app/Contents/Info.plist",
                           "TrueDown.app/Contents/Resources/truedown.icns"}
    require(set(files) == expected, f"Unexpected package contents in {archive.name}: {set(files) ^ expected}")
    mode, data = files[binary]
    require(len(data) >= 64, f"Truncated executable: {archive.name}")
    if system == "windows":
        require(data[:2] == b"MZ", "Windows executable is not PE")
        offset = struct.unpack_from("<I", data, 60)[0]
        require(data[offset:offset + 6] == b"PE\0\0\x64\x86", "Windows executable is not amd64 PE")
    else:
        require(mode & 0o111 == 0o111, f"Executable permissions lost: {archive.name}")
        if system == "linux":
            machine = {"amd64": 62, "arm64": 183}[arch]
            require(data[:6] == b"\x7fELF\x02\x01"
                    and struct.unpack_from("<H", data, 18)[0] == machine,
                    f"Wrong ELF architecture: {archive.name}")
        else:
            cpu = {"amd64": 0x01000007, "arm64": 0x0100000C}[arch]
            require(data[:4] == b"\xcf\xfa\xed\xfe"
                    and struct.unpack_from("<I", data, 4)[0] == cpu
                    and struct.unpack_from("<I", data, 12)[0] == 2,
                    f"Wrong Mach-O architecture: {archive.name}")
            plist = plistlib.loads(files["TrueDown.app/Contents/Info.plist"][1])
            require(plist.get("CFBundleExecutable") == "TrueDown"
                    and plist.get("CFBundlePackageType") == "APPL"
                    and plist.get("CFBundleVersion") == str(build)
                    and plist.get("CFBundleIconFile") == "truedown.icns",
                    f"Invalid bundle metadata: {archive.name}")
            icon = files["TrueDown.app/Contents/Resources/truedown.icns"][1]
            require(icon[:4] == b"icns", f"Invalid bundle icon: {archive.name}")


def validate_release(directory, build):
    require(build > 0, "Release build must be positive")
    windows_name = f"TrueDown-build-{build}.zip"
    manifest_name = f"truedown-update-{build}.json"
    packages = [(windows_name, "windows", "amd64")]
    for system, extension in (("linux", "tar.gz"), ("macos", "zip")):
        for arch in ("amd64", "arm64"):
            packages.append((f"TrueDown-build-{build}-{system}-{arch}.{extension}", system, arch))
    expected = {name for name, _, _ in packages} | {manifest_name}
    require({item.name for item in directory.iterdir()} == expected,
            "Release must contain exactly five platform archives and the Windows update manifest")
    for name in expected:
        asset = directory / name
        require(not asset.is_symlink() and asset.is_file() and asset.stat().st_size > 0,
                f"Missing or invalid release asset: {name}")
    windows = directory / windows_name
    with windows.open("rb") as archive:
        digest = hashlib.file_digest(archive, "sha256").hexdigest()
    manifest = json.loads((directory / manifest_name).read_text(encoding="utf-8"))
    require(manifest == {
        "schemaVersion": 1,
        "product": "TrueDown",
        "repository": "truewayd/KDownloader",
        "version": f"truedown-build-{build}",
        "build": build,
        "asset": {"name": windows_name, "size": windows.stat().st_size, "sha256": digest},
    }, "Windows update manifest does not match the release archive and build")
    for name, system, arch in packages:
        validate_package(directory / name, system, arch, build)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--build", type=int, required=True)
    args = parser.parse_args()
    validate_release(args.directory, args.build)
    print(f"Validated all six TrueDown build {args.build} release assets")
