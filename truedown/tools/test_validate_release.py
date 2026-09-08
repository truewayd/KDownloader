import hashlib
import gzip
import io
import json
from pathlib import Path
import plistlib
import stat
import struct
import tarfile
import tempfile
import tracemalloc
import unittest
from unittest.mock import patch
import zipfile

from validate_release import (MAX_HEADER, MAX_NAME, MAX_TAR_HEADERS, MAX_TAR_METADATA,
                              NATIVE_FILES, read_package,
                              validate_package, validate_release, windows_manifest)


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
            files = {entry: bytes(binary) for entry in
                     ("TrueDown.exe", "truedown-core.exe", "truedown-cli.exe", "aria2c.exe")}
            files.update({"ARIA2_COPYING": b"license", "THIRD_PARTY_NOTICES.md": b"notices",
                          "NATIVE_LICENSES.txt": b"native notices", "README.md": b"readme"})
        elif system == "linux":
            binary[:6] = b"\x7fELF\x02\x01"
            struct.pack_into("<H", binary, 18, {"amd64": 62, "arm64": 183}[arch])
            name = f"TrueDown-build-42-linux-{arch}.tar.gz"
            files = {f"TrueDown-linux-{arch}/{entry}": data for entry, data in {
                "TrueDown": bytes(binary), "truedown-core": bytes(binary), "truedown-cli": bytes(binary),
                "README.md": b"readme", "NATIVE_LICENSES.txt": b"native notices",
                "THIRD_PARTY_NOTICES.md": b"notices", "truedown.desktop": b"desktop",
                "truedown.svg": b"svg"}.items()}
        else:
            struct.pack_into("<IIII", binary, 0, 0xFEEDFACF,
                             {"amd64": 0x01000007, "arm64": 0x0100000C}[arch], 0, 2)
            name = f"TrueDown-build-42-macos-{arch}.zip"
            files = {"TrueDown.app/Contents/MacOS/TrueDown": bytes(binary),
                     "TrueDown.app/Contents/MacOS/truedown-core": bytes(binary),
                     "TrueDown.app/Contents/MacOS/truedown-cli": bytes(binary),
                     "TrueDown.app/Contents/Info.plist": plistlib.dumps({
                         "CFBundleExecutable": "TrueDown", "CFBundlePackageType": "APPL",
                         "CFBundleIdentifier": "io.truewayd.truedown",
                         "CFBundleVersion": "42", "CFBundleIconFile": "truedown.icns"}),
                     "TrueDown.app/Contents/Resources/truedown.icns": b"icns-icon",
                     "TrueDown.app/Contents/Resources/THIRD_PARTY_NOTICES.md": b"notices",
                     "TrueDown.app/Contents/Resources/NATIVE_LICENSES.txt": b"native notices",
                     "TrueDown.app/Contents/Resources/ARIA2_COPYING": b"license",
                     "TrueDown.app/Contents/_CodeSignature/CodeResources": b"signature",
                     "README.md": b"readme", "THIRD_PARTY_NOTICES.md": b"notices",
                     "NATIVE_LICENSES.txt": b"native notices"}
        entries = {entry: (0o755 if entry.endswith(("TrueDown", "truedown-core", "truedown-cli")) else 0o644, data)
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
        self.manifest = windows_manifest(archive, 42, read_package(archive))
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

    def test_manifest_requires_exact_json_types(self):
        for field, value in (("protocolVersion", True), ("schemaVersion", 2.0), ("build", 42.0)):
            with self.subTest(field=field):
                self.write_manifest()
                self.manifest[field] = value
                (self.root / "truedown-update-42.json").write_text(json.dumps(self.manifest), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Windows update manifest"):
                    validate_release(self.root, 42)

    def test_manifest_rejects_duplicate_fields(self):
        manifest = self.root / "truedown-update-42.json"
        manifest.write_text(json.dumps(self.manifest).replace('"build": 42', '"build": 42, "build": 42'),
                            encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate manifest field"):
            validate_release(self.root, 42)

    def test_large_members_are_hashed_without_retaining_package_contents(self):
        for system in ("windows", "linux"):
            name, entries = self.packages[system, "amd64"]
            binary = next(entry for entry in entries if "truedown-core" in entry)
            mode, data = entries[binary]
            data += b"\xa5" * (16 << 20)
            entries[binary] = (mode, data)
            self.write_package(name, entries)
            with self.subTest(system=system):
                tracemalloc.start()
                try:
                    files = validate_package(self.root / name, system, "amd64", 42)
                    _, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
                self.assertLess(peak, 8 << 20)
                self.assertEqual(files[binary].header, data[:MAX_HEADER])
                self.assertEqual(files[binary].size, len(data))
                self.assertEqual(files[binary].sha256, hashlib.sha256(data).hexdigest())

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
        with self.assertRaisesRegex(ValueError, "bundle icon|package contents"):
            validate_package(self.root / name, "macos", "arm64", 42)

    def test_manifest_binds_every_native_component(self):
        for index, name in enumerate(NATIVE_FILES):
            with self.subTest(component=name):
                self.write_manifest()
                self.manifest["files"][index]["sha256"] = "0" * 64
                (self.root / "truedown-update-42.json").write_text(json.dumps(self.manifest), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Windows update manifest"):
                    validate_release(self.root, 42)

    def test_legacy_manifest_is_rejected(self):
        self.manifest["schemaVersion"] = 1
        for key in ("files", "platform", "protocolVersion"):
            del self.manifest[key]
        (self.root / "truedown-update-42.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Windows update manifest"):
            validate_release(self.root, 42)

    def test_missing_or_wrong_architecture_sidecar(self):
        for system in ("windows", "linux", "macos"):
            name, entries = self.packages[system, "amd64"]
            sidecar = next(entry for entry in entries if "truedown-core" in entry)
            with self.subTest(system=system, failure="missing"):
                self.write_package(name, {entry: value for entry, value in entries.items() if entry != sidecar})
                with self.assertRaisesRegex(ValueError, "package contents"):
                    validate_package(self.root / name, system, "amd64", 42)
            with self.subTest(system=system, failure="architecture"):
                invalid = dict(entries)
                invalid[sidecar] = (0o755, b"broken" * 30)
                self.write_package(name, invalid)
                with self.assertRaisesRegex(ValueError, "architecture|not PE"):
                    validate_package(self.root / name, system, "amd64", 42)

    def test_mac_signing_and_notice_resources_are_required(self):
        name, entries = self.packages["macos", "amd64"]
        for file in ("_CodeSignature/CodeResources", "Resources/NATIVE_LICENSES.txt"):
            with self.subTest(file=file):
                self.write_package(name, {key: value for key, value in entries.items()
                                          if key != "TrueDown.app/Contents/" + file})
                with self.assertRaisesRegex(ValueError, "package contents|Bundle notice"):
                    validate_package(self.root / name, "macos", "amd64", 42)

    def test_mac_notice_comparison_checks_beyond_retained_headers(self):
        name, entries = self.packages["macos", "amd64"]
        notice = b"license\n" * MAX_HEADER
        entries["NATIVE_LICENSES.txt"] = (0o644, notice + b"A")
        entries["TrueDown.app/Contents/Resources/NATIVE_LICENSES.txt"] = (0o644, notice + b"B")
        self.write_package(name, entries)
        with self.assertRaisesRegex(ValueError, "Bundle notice differs"):
            validate_package(self.root / name, "macos", "amd64", 42)

    def test_mac_bundle_metadata_is_bounded_and_a_dictionary(self):
        name, entries = self.packages["macos", "amd64"]
        for data, message in ((b" " * (MAX_HEADER + 1), "Oversized bundle metadata"),
                              (plistlib.dumps(["not a dictionary"]), "Invalid bundle metadata")):
            with self.subTest(message=message):
                entries["TrueDown.app/Contents/Info.plist"] = (0o644, data)
                self.write_package(name, entries)
                with self.assertRaisesRegex(ValueError, message):
                    validate_package(self.root / name, "macos", "amd64", 42)

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

    def test_windows_archive_rejects_root_directory_entries(self):
        name, entries = self.packages["windows", "amd64"]
        for directory in ("./", ".//"):
            for data in (b"", b"x"):
                with self.subTest(directory=directory, data=data):
                    self.write_package(name, entries)
                    with zipfile.ZipFile(self.root / name, "a") as archive:
                        info = zipfile.ZipInfo(directory)
                        info.create_system = 3
                        info.external_attr = (stat.S_IFDIR | 0o755) << 16
                        archive.writestr(info, data)
                    with self.assertRaisesRegex(ValueError, "Unsafe path"):
                        validate_package(self.root / name, "windows", "amd64", 42)


class ArchiveMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    @staticmethod
    def pax_record(key, value):
        record = f" {key}={value}\n".encode("utf-8")
        size = len(record) + 1
        while len(str(size)) + len(record) != size:
            size = len(str(size)) + len(record)
        return str(size).encode("ascii") + record

    def write_tar_metadata(self, records):
        destination = self.root / "metadata.tar.gz"
        with tarfile.open(destination, "w:gz", format=tarfile.GNU_FORMAT) as archive:
            for kind, data in records:
                info = tarfile.TarInfo("metadata")
                info.type, info.size = kind, len(data)
                archive.addfile(info, io.BytesIO(data))
            info = tarfile.TarInfo("payload")
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
        return destination

    def test_store_and_deflate_with_maximum_zip_comment(self):
        for method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            with self.subTest(method=method):
                destination = self.root / "supported.zip"
                with zipfile.ZipFile(destination, "w", compression=method) as archive:
                    archive.writestr("payload", b"data")
                    archive.comment = b"c" * 65535
                self.assertEqual(read_package(destination)["payload"].sha256,
                                 hashlib.sha256(b"data").hexdigest())

    def test_zip_filename_must_not_be_truncated_at_nul(self):
        destination = self.root / "nul.zip"
        with zipfile.ZipFile(destination, "w") as archive:
            archive.writestr("TrueDown.exeXignored", b"data")
        data = destination.read_bytes()
        self.assertEqual(data.count(b"TrueDown.exeXignored"), 2)
        destination.write_bytes(data.replace(b"TrueDown.exeXignored", b"TrueDown.exe\0ignored"))
        with self.assertRaisesRegex(ValueError, "Invalid ZIP filename"):
            read_package(destination)

    def test_unsupported_zip_methods_fail_before_decompression(self):
        for method in (zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA):
            with self.subTest(method=method):
                destination = self.root / "unsupported.zip"
                with zipfile.ZipFile(destination, "w", compression=method) as archive:
                    archive.writestr("payload", b"data")
                with patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("decoded member")):
                    with self.assertRaisesRegex(ValueError, "Unsupported ZIP compression"):
                        read_package(destination)

    def test_zip_central_directory_is_bounded_before_entry_allocation(self):
        destination = self.root / "metadata.zip"
        with zipfile.ZipFile(destination, "w") as archive:
            for name in ("one", "two"):
                info = zipfile.ZipInfo(name)
                info.comment = b"c" * (MAX_HEADER // 2)
                archive.writestr(info, b"data")
        with patch.object(zipfile, "ZipInfo", side_effect=AssertionError("allocated entry")):
            with self.assertRaisesRegex(ValueError, "Oversized ZIP metadata"):
                read_package(destination)

    def test_tar_extension_size_is_checked_before_body_read(self):
        for kind in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                     tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            with self.subTest(kind=kind):
                destination = self.write_tar_metadata([(kind, b"x" * (MAX_HEADER + 1))])
                requested = []
                original = gzip.GzipFile.read

                def checked_read(stream, size=-1):
                    requested.append(size)
                    self.assertLessEqual(size, MAX_HEADER)
                    return original(stream, size)

                with patch.object(gzip.GzipFile, "read", new=checked_read):
                    with self.assertRaisesRegex(ValueError, "Oversized TAR metadata"):
                        read_package(destination)
                self.assertTrue(requested)

    def test_tar_metadata_totals_and_chained_headers_are_bounded(self):
        payload = self.pax_record("comment", "c" * (MAX_HEADER - 64))
        destination = self.write_tar_metadata([(tarfile.XGLTYPE, payload)]
                                             * (MAX_TAR_METADATA // len(payload) + 1))
        with self.assertRaisesRegex(ValueError, "Oversized TAR metadata"):
            read_package(destination)
        destination = self.write_tar_metadata([(tarfile.XGLTYPE, self.pax_record("comment", "x"))]
                                             * (MAX_TAR_HEADERS + 1))
        with self.assertRaisesRegex(ValueError, "Too many TAR headers"):
            read_package(destination)

    def test_tar_sparse_extensions_are_rejected_before_map_processing(self):
        variants = (
            [("GNU.sparse.size", "1"), ("GNU.sparse.offset", "0"), ("GNU.sparse.numbytes", "1")],
            [("GNU.sparse.map", "0,1")],
            [("GNU.sparse.major", "1"), ("GNU.sparse.minor", "0")],
        )
        for headers in variants:
            with self.subTest(headers=headers):
                payload = b"".join(self.pax_record(key, value) for key, value in headers)
                destination = self.write_tar_metadata([(tarfile.XHDTYPE, payload)])
                with self.assertRaisesRegex(ValueError, "Sparse TAR entries"):
                    read_package(destination)
        destination = self.write_tar_metadata([(tarfile.GNUTYPE_SPARSE, b"x")])
        with self.assertRaisesRegex(ValueError, "Sparse TAR entries"):
            read_package(destination)

    def test_gnu_and_pax_long_names_remain_supported(self):
        for format in (tarfile.GNU_FORMAT, tarfile.PAX_FORMAT):
            with self.subTest(format=format):
                destination = self.root / "long-name.tar.gz"
                name = "TrueDown-linux-amd64/" + "a" * 300
                with tarfile.open(destination, "w:gz", format=format) as archive:
                    info = tarfile.TarInfo(name)
                    info.size = 4
                    archive.addfile(info, io.BytesIO(b"data"))
                self.assertEqual(read_package(destination)[name].size, 4)

    def test_package_name_limit_counts_utf8_bytes(self):
        destination = self.root / "long-name.zip"
        with zipfile.ZipFile(destination, "w") as archive:
            archive.writestr("\u6d4b" * (MAX_NAME // 3 + 1), b"data")
        with self.assertRaisesRegex(ValueError, "Oversized package filename"):
            read_package(destination)


if __name__ == "__main__":
    unittest.main()
