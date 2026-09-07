"""Record the original SDK notice and loader hashes from a reviewed NuGet package."""

import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive", type=Path)
parser.add_argument("--version", required=True)
parser.add_argument("--crate-version", required=True)
args = parser.parse_args()
with zipfile.ZipFile(args.archive) as archive:
    nuspec = ET.fromstring(archive.read("Microsoft.Web.WebView2.nuspec"))
    version = nuspec.find(".//{*}version").text
    if version != args.version:
        raise ValueError("SDK identity does not match its package metadata")
    data = archive.read("LICENSE.txt")
    if len(data) > 65536 or b"Microsoft Corporation" not in data:
        raise ValueError("Invalid original SDK license notice")
    sha256 = hashlib.sha256(data).hexdigest()
    loaders = {arch: hashlib.sha256(archive.read(f"build/native/{arch}/WebView2LoaderStatic.lib")).hexdigest()
               for arch in ("x64", "arm64", "x86")}
directory = Path(__file__).resolve().parents[1] / "desktop" / "licenses"
directory.mkdir(exist_ok=True)
if directory.is_symlink():
    raise ValueError("Unsafe license output directory")
for name in (f"{sha256}.txt", "webview2-sdk.json"):
    file = directory / name
    if file.is_symlink() or (file.exists() and not file.is_file()):
        raise ValueError("Unsafe license output file")
(directory / f"{sha256}.txt").write_bytes(data)
(directory / "webview2-sdk.json").write_text(json.dumps({
    "version": version, "crateVersion": args.crate_version,
    "archiveSHA256": hashlib.sha256(args.archive.read_bytes()).hexdigest(),
    "source": f"https://www.nuget.org/packages/Microsoft.Web.WebView2/{version}",
    "file": f"{sha256}.txt", "sha256": sha256, "loaders": loaders,
}, indent=2) + "\n", encoding="utf-8")
print(f"Recorded WebView2 SDK {version} license and all three loader hashes")
