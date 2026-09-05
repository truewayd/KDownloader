import hashlib
import io
import json
from pathlib import Path
import plistlib
import stat
import struct
import tarfile
import tempfile
import unittest
import zipfile

from validate_release import validate_package, validate_release


class ReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.packages = {}
        for system in ("windows", "linux", "macos"):
            for arch in (("amd64",) if system == "windows" else ("amd64", "arm64")):
                self.make_package(system, arch)
        self.write_manifest()

    def make_package(self, system, arch):
        binary = bytearray(128)
        if system == "windows":
            binary[:2] = b"MZ"
            struct.pack_into("<I", binary, 60, 64)
            binary[64:70] = b"PE\0\0\x64\x86"
            name = "TrueDown-build-42.zip"
            files = {"TrueDown.exe": bytes(binary), "aria2c.exe": bytes(binary),
                     "ARIA2_COPYING": b"license", "THIRD_PARTY_NOTICES.md": b"notices"}
        elif system == "linux":
            binary[:6] = b"\x7fELF\x02\x01"
            struct.pack_into("<H", binary, 18, {"amd64": 62, "arm64": 183}[arch])
            name = f"TrueDown-build-42-linux-{arch}.tar.gz"
            files = {f"TrueDown-linux-{arch}/{entry}": data for entry, data in {
                "TrueDown": bytes(binary), "README.md": b"readme",
                "THIRD_PARTY_NOTICES.md": b"notices", "truedown.desktop": b"desktop",
                "truedown.svg": b"svg"}.items()}
        else:
            struct.pack_into("<IIII", binary, 0, 0xFEEDFACF,
                             {"amd64": 0x01000007, "arm64": 0x0100000C}[arch], 0, 2)
            name = f"TrueDown-build-42-macos-{arch}.zip"
            files = {"TrueDown.app/Contents/MacOS/TrueDown": bytes(binary),
                     "TrueDown.app/Contents/Info.plist": plistlib.dumps({
                         "CFBundleExecutable": "TrueDown", "CFBundlePackageType": "APPL",
                         "CFBundleVersion": "42", "CFBundleIconFile": "truedown.icns"}),
                     "TrueDown.app/Contents/Resources/truedown.icns": b"icns-icon",
                     "README.md": b"readme", "THIRD_PARTY_NOTICES.md": b"notices"}
        entries = {entry: (0o755 if entry.endswith("TrueDown") else 0o644, data)
                   for entry, data in files.items()}
        self.packages[system, arch] = (name, entries)
        self.write_package(name, entries)

    def write_package(self, name, entries):
        if name.endswith(".tar.gz"):
            with tarfile.open(self.root / name, "w:gz") as archive:
                for entry, (mode, data) in entries.items():
                    info = tarfile.TarInfo(entry)
                    info.mode, info.size = mode, len(data)
                    archive.addfile(info, io.BytesIO(data))
        else:
            with zipfile.ZipFile(self.root / name, "w") as archive:
                for entry, (mode, data) in entries.items():
                    info = zipfile.ZipInfo(entry)
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | mode) << 16
                    archive.writestr(info, data)

    def write_manifest(self):
        archive = self.root / "TrueDown-build-42.zip"
        self.manifest = {
            "schemaVersion": 1, "product": "TrueDown", "repository": "truewayd/KDownloader",
            "version": "truedown-build-42", "build": 42,
            "asset": {"name": archive.name, "size": archive.stat().st_size,
                      "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()},
        }
        (self.root / "truedown-update-42.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_complete_release(self):
        validate_release(self.root, 42)

    def test_missing_or_extra_asset(self):
        asset = self.root / "TrueDown-build-42-macos-arm64.zip"
        asset.rename(asset.with_suffix(".unexpected"))
        with self.assertRaisesRegex(ValueError, "exactly five platform archives"):
            validate_release(self.root, 42)

    def test_manifest_must_bind_windows_archive(self):
        for field, value in (("name", "TrueDown-build-42-macos-amd64.zip"),
                             ("size", 1), ("sha256", "0" * 64)):
            with self.subTest(field=field):
                self.write_manifest()
                self.manifest["asset"][field] = value
                (self.root / "truedown-update-42.json").write_text(json.dumps(self.manifest), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Windows update manifest"):
                    validate_release(self.root, 42)

    def test_wrong_architecture(self):
        for system in ("linux", "macos"):
            with self.subTest(system=system):
                name, _ = self.packages[system, "arm64"]
                _, entries = self.packages[system, "amd64"]
                renamed = {entry.replace("linux-amd64", "linux-arm64"): value
                           for entry, value in entries.items()}
                self.write_package(name, renamed)
                with self.assertRaisesRegex(ValueError, "architecture"):
                    validate_package(self.root / name, system, "arm64", 42)

    def test_unix_executable_modes_survive_archiving(self):
        for system in ("linux", "macos"):
            with self.subTest(system=system):
                name, entries = self.packages[system, "amd64"]
                entries = {entry: (0o644, data) for entry, (_, data) in entries.items()}
                self.write_package(name, entries)
                with self.assertRaisesRegex(ValueError, "permissions lost"):
                    validate_package(self.root / name, system, "amd64", 42)

    def test_missing_bundle_resource_or_wrong_build(self):
        name, entries = self.packages["macos", "arm64"]
        with self.assertRaisesRegex(ValueError, "bundle metadata"):
            validate_package(self.root / name, "macos", "arm64", 43)
        del entries["TrueDown.app/Contents/Resources/truedown.icns"]
        self.write_package(name, entries)
        with self.assertRaisesRegex(ValueError, "package contents"):
            validate_package(self.root / name, "macos", "arm64", 42)

    def test_unexpected_package_file(self):
        name, entries = self.packages["windows", "amd64"]
        entries["truedown.token"] = (0o600, b"must not ship")
        self.write_package(name, entries)
        with self.assertRaisesRegex(ValueError, "package contents"):
            validate_package(self.root / name, "windows", "amd64", 42)

    def test_archive_rejects_traversal_and_links(self):
        name, entries = self.packages["linux", "amd64"]
        entries["../outside"] = (0o644, b"outside")
        self.write_package(name, entries)
        with self.assertRaisesRegex(ValueError, "Unsafe path"):
            validate_package(self.root / name, "linux", "amd64", 42)
        with tarfile.open(self.root / name, "w:gz") as archive:
            info = tarfile.TarInfo("TrueDown-linux-amd64/TrueDown")
            info.type, info.linkname = tarfile.SYMTYPE, "/outside"
            archive.addfile(info)
        with self.assertRaisesRegex(ValueError, "Non-regular entry"):
            validate_package(self.root / name, "linux", "amd64", 42)

        name, _ = self.packages["macos", "amd64"]
        with zipfile.ZipFile(self.root / name, "a") as archive:
            info = zipfile.ZipInfo("TrueDown.app/Contents/")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/outside")
        with self.assertRaisesRegex(ValueError, "Non-regular entry"):
            validate_package(self.root / name, "macos", "amd64", 42)


if __name__ == "__main__":
    unittest.main()
