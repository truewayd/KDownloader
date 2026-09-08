"""Validate the complete native release without extracting archive paths."""

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import stat
import struct
import tarfile
import zipfile


NATIVE_FILES = ("truedown-core.exe", "truedown-cli.exe",
                "THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt", "TrueDown.exe")
MAX_FILE = 256 << 20
MAX_PACKAGE = 512 << 20
READ_CHUNK = 1 << 20
MAX_HEADER = 64 << 10
MAX_ZIP_METADATA = MAX_HEADER + 22
MAX_TAR_METADATA = 1 << 20
MAX_TAR_HEADERS = 128
MAX_NAME = 1024


class MetadataReader:
    """Limit parser setup reads before ZIP's central directory is allocated."""

    def __init__(self, stream, size):
        self.stream, self.size = stream, size
        self.limit = MAX_ZIP_METADATA

    def read(self, size=-1):
        count = self.size - self.stream.tell() if size < 0 else size
        require(self.limit is None or count <= self.limit, "Oversized ZIP metadata")
        return self.stream.read(size)

    def __getattr__(self, name):
        return getattr(self.stream, name)


class BoundedTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive):
        # stdlib parses extension bodies before yielding a TarInfo to callers.
        # Check them here, before its PAX/GNU long-name handlers allocate data.
        headers = getattr(archive, "_truedown_headers", 0) + 1
        require(headers <= MAX_TAR_HEADERS, "Too many TAR headers")
        archive._truedown_headers = headers
        if self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                         tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            total = getattr(archive, "_truedown_metadata", 0) + self.size
            require(0 <= self.size <= MAX_HEADER and total <= MAX_TAR_METADATA,
                    "Oversized TAR metadata")
            archive._truedown_metadata = total
        require(self.type != tarfile.GNUTYPE_SPARSE, "Sparse TAR entries are not supported")
        return super()._proc_member(archive)

    def _proc_gnusparse_00(self, next, raw_headers):
        raise ValueError("Sparse TAR entries are not supported")

    def _proc_gnusparse_01(self, next, pax_headers):
        raise ValueError("Sparse TAR entries are not supported")

    def _proc_gnusparse_10(self, next, pax_headers, archive):
        # This format reads a separate, otherwise unbounded sparse map.
        raise ValueError("Sparse TAR entries are not supported")


@dataclass(frozen=True)
class PackageFile:
    mode: int
    size: int
    sha256: str
    header: bytes


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate manifest field: {key}")
        result[key] = value
    return result


def read_package(archive):
    files, directories, seen = {}, set(), set()
    total = 0
    require(archive.stat().st_size <= MAX_PACKAGE, "Oversized package")

    def add(name, mode, is_directory, size, read):
        nonlocal total
        require(len(name.encode("utf-8")) <= MAX_NAME, "Oversized package filename")
        path = PurePosixPath(name)
        require(name and not path.is_absolute() and ".." not in path.parts
                and "\\" not in name and ":" not in name
                and str(path) == name.rstrip("/"), f"Unsafe path: {name}")
        identity = str(path).casefold()
        require(identity not in seen, f"Duplicate entry: {name}")
        seen.add(identity)
        require(len(seen) <= 64, "Too many package entries")
        expected_type = stat.S_IFDIR if is_directory else stat.S_IFREG
        require(stat.S_IFMT(mode) in (0, expected_type), f"Non-regular entry: {name}")
        if is_directory:
            directories.add(path)
        else:
            require(0 < size <= MAX_FILE, f"Empty or oversized entry: {name}")
            total += size
            require(total <= MAX_PACKAGE, "Oversized package contents")
            digest, header, consumed = hashlib.sha256(), bytearray(), 0
            with read() as stream:
                while chunk := stream.read(min(READ_CHUNK, size - consumed + 1)):
                    consumed += len(chunk)
                    require(consumed <= size, f"Invalid entry size: {name}")
                    digest.update(chunk)
                    header.extend(chunk[:max(0, MAX_HEADER - len(header))])
            require(consumed == size, f"Invalid entry size: {name}")
            files[name] = PackageFile(mode, size, digest.hexdigest(), bytes(header))

    if archive.name.endswith(".tar.gz"):
        with tarfile.open(archive, "r:gz", tarinfo=BoundedTarInfo) as package:
            for entry in package:
                require(entry.isdir() or entry.isfile(), f"Non-regular entry: {entry.name}")
                add(entry.name, entry.mode, entry.isdir(), entry.size,
                    lambda: package.extractfile(entry))
    else:
        with archive.open("rb") as stream:
            metadata = MetadataReader(stream, archive.stat().st_size)
            with zipfile.ZipFile(metadata) as package:
                metadata.limit = None
                require(len(package.infolist()) <= 64, "Too many package entries")
                for entry in package.infolist():
                    require(entry.filename == entry.orig_filename, "Invalid ZIP filename")
                    require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                            f"Unsupported ZIP compression: {entry.filename}")
                    add(entry.filename, entry.external_attr >> 16, entry.is_dir(),
                        entry.file_size, lambda: package.open(entry))
    parents = {parent for name in files for parent in PurePosixPath(name).parents}
    require(directories <= parents, f"Unexpected directories in {archive.name}")
    return files


def validate_executable(name, entry, system, arch):
    mode, data = entry.mode, entry.header
    require(len(data) >= 64, f"Truncated executable: {name}")
    if system == "windows":
        require(data[:2] == b"MZ", f"Windows executable is not PE: {name}")
        offset = struct.unpack_from("<I", data, 60)[0]
        machine = {"amd64": 0x8664, "arm64": 0xAA64}[arch]
        require(64 <= offset <= 4096 and offset + 6 <= len(data)
                and data[offset:offset + 4] == b"PE\0\0"
                and struct.unpack_from("<H", data, offset + 4)[0] == machine,
                f"Wrong PE architecture: {name}")
        return
    require(mode & 0o111 == 0o111, f"Executable permissions lost: {name}")
    if system == "linux":
        machine = {"amd64": 62, "arm64": 183}[arch]
        require(data[:6] == b"\x7fELF\x02\x01"
                and struct.unpack_from("<H", data, 18)[0] == machine,
                f"Wrong ELF architecture: {name}")
    else:
        cpu = {"amd64": 0x01000007, "arm64": 0x0100000C}[arch]
        require(data[:4] == b"\xcf\xfa\xed\xfe"
                and struct.unpack_from("<I", data, 4)[0] == cpu
                and struct.unpack_from("<I", data, 12)[0] == 2,
                f"Wrong Mach-O architecture: {name}")


def validate_package(archive, system, arch, build):
    files = read_package(archive)
    docs = {"README.md", "THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt"}
    executables = {"TrueDown", "truedown-core", "truedown-cli"}
    if system == "windows":
        expected = docs | set(NATIVE_FILES) | {"aria2c.exe", "ARIA2_COPYING"}
        binaries = {name for name in expected if name.endswith(".exe")}
    elif system == "linux":
        prefix = f"TrueDown-linux-{arch}/"
        expected = {prefix + name for name in docs | executables | {"truedown.desktop", "truedown.svg"}}
        binaries = {prefix + name for name in executables}
    else:
        prefix = "TrueDown.app/Contents/"
        binaries = {prefix + "MacOS/" + name for name in executables}
        require(prefix + "Info.plist" in files, f"Missing bundle metadata: {archive.name}")
        metadata = files[prefix + "Info.plist"]
        require(metadata.size <= MAX_HEADER, f"Oversized bundle metadata: {archive.name}")
        plist = plistlib.loads(metadata.header)
        require(isinstance(plist, dict), f"Invalid bundle metadata: {archive.name}")
        icon_name = plist.get("CFBundleIconFile")
        require(isinstance(icon_name, str) and PurePosixPath(icon_name).name == icon_name
                and icon_name.endswith(".icns"), f"Invalid bundle icon name: {archive.name}")
        expected = docs | binaries | {prefix + "Info.plist", prefix + "Resources/" + icon_name,
                                      prefix + "_CodeSignature/CodeResources"}
        expected |= {prefix + "Resources/" + name for name in
                     ("THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt", "ARIA2_COPYING")}
        require(plist.get("CFBundleExecutable") == "TrueDown"
                and plist.get("CFBundleIdentifier") == "io.truewayd.truedown"
                and plist.get("CFBundlePackageType") == "APPL"
                and plist.get("CFBundleVersion") == str(build),
                f"Invalid bundle metadata: {archive.name}")
        icon = files.get(prefix + "Resources/" + icon_name)
        require(icon and icon.header[:4] == b"icns",
                f"Invalid bundle icon: {archive.name}")
        for name in ("THIRD_PARTY_NOTICES.md", "NATIVE_LICENSES.txt"):
            require(files.get(name) and files.get(prefix + "Resources/" + name)
                    and files[name].size == files[prefix + "Resources/" + name].size
                    and files[name].sha256 == files[prefix + "Resources/" + name].sha256,
                    f"Bundle notice differs from package: {name}")
    require(set(files) == expected, f"Unexpected package contents in {archive.name}: {set(files) ^ expected}")
    for name in binaries:
        validate_executable(name, files[name], system, arch)
    return files


def windows_manifest(archive, build, files):
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {
        "schemaVersion": 2, "product": "TrueDown", "repository": "truewayd/KDownloader",
        "version": f"truedown-build-{build}", "build": build,
        "protocolVersion": 1, "platform": "windows-amd64",
        "files": [{"name": name, "size": files[name].size,
                   "sha256": files[name].sha256} for name in NATIVE_FILES],
        "asset": {"name": archive.name, "size": archive.stat().st_size, "sha256": digest},
    }


def validate_release(directory, build):
    require(0 < build <= 9999999999999, "Release build must be positive and bounded")
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
    require((directory / manifest_name).stat().st_size <= 65536, "Oversized update manifest")
    manifest = json.loads((directory / manifest_name).read_text(encoding="utf-8"),
                          object_pairs_hook=unique_json_object)
    for name, system, arch in packages:
        files = validate_package(directory / name, system, arch, build)
        if system == "windows":
            require(json.dumps(manifest, sort_keys=True)
                    == json.dumps(windows_manifest(directory / name, build, files), sort_keys=True),
                    "Windows update manifest does not match the complete native archive and build")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--build", type=int, required=True)
    parser.add_argument("--package", choices=("windows", "linux", "macos"))
    parser.add_argument("--arch", choices=("amd64", "arm64"), default="amd64")
    args = parser.parse_args()
    if args.package:
        validate_package(args.directory, args.package, args.arch, args.build)
        print(f"Validated native package {args.directory.name}")
    else:
        validate_release(args.directory, args.build)
        print(f"Validated all six TrueDown build {args.build} release assets")
