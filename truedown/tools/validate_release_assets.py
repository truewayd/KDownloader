"""Verify uploaded metadata against the already validated local release set."""
import json
import argparse
from pathlib import Path
import sys


def validate_assets(directory, assets):
    expected = {path.name: path.stat().st_size for path in Path(directory).iterdir() if path.is_file()}
    if len(expected) != 5 or not isinstance(assets, list) or len(assets) != len(expected):
        raise ValueError("Release must expose all five uploaded assets")
    seen = set()
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("Invalid release asset")
        name = asset.get("name")
        if not isinstance(name, str) or name in seen or name not in expected:
            raise ValueError("Duplicate or unexpected release asset")
        seen.add(name)
        if (asset.get("state") != "uploaded" or type(asset.get("size")) is not int
                or asset["size"] <= 0 or asset["size"] != expected[name]):
            raise ValueError("Release asset is incomplete or its size differs")


def release_assets(releases, tag):
    if not isinstance(releases, list):
        raise ValueError("Expected a public release list")
    matches = [release for release in releases if isinstance(release, dict) and release.get("tag_name") == tag]
    if len(matches) != 1 or matches[0].get("draft") is not False or matches[0].get("prerelease") is not False:
        raise ValueError("Expected one public stable release")
    return matches[0].get("assets")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--release-tag")
    args = parser.parse_args()
    metadata = json.load(sys.stdin)
    if args.release_tag:
        metadata = release_assets(metadata, args.release_tag)
    validate_assets(args.directory, metadata)
    print("All five release assets are uploaded and match local sizes")
