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


def release_assets(releases, tag, release_id=None):
    if not isinstance(releases, list):
        raise ValueError("Expected a public release list")
    matches = [release for release in releases if isinstance(release, dict) and release.get("tag_name") == tag]
    if len(matches) != 1 or matches[0].get("draft") is not False or matches[0].get("prerelease") is not False:
        raise ValueError("Expected one public stable release")
    if release_id is not None and (type(matches[0].get("id")) is not int or matches[0]["id"] != release_id):
        raise ValueError("Public release ID differs from the uploaded release")
    return matches[0].get("assets")


def validate_public(directory, releases, tag, release_id, fallback):
    inline = release_assets(releases, tag, release_id)
    # The second endpoint must independently expose the entire validated bundle.
    validate_assets(directory, fallback)
    try:
        validate_assets(directory, inline)
    except ValueError:
        return False
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--release-tag")
    parser.add_argument("--release-id", type=int)
    parser.add_argument("--asset-metadata", type=Path)
    args = parser.parse_args()
    metadata = json.load(sys.stdin)
    if args.asset_metadata:
        if not args.release_tag or not args.release_id or args.release_id <= 0:
            parser.error("Public fallback validation requires a tag and positive release ID")
        legacy = validate_public(args.directory, metadata, args.release_tag, args.release_id,
                                 json.loads(args.asset_metadata.read_text(encoding="utf-8")))
        if not legacy:
            print("::warning::GitHub omits inline assets; clients before build 48 need a one-time manual upgrade")
        print("Anonymous release-ID discovery verified; legacy inline discovery=" + str(legacy).lower())
        sys.exit(0)
    if args.release_tag:
        metadata = release_assets(metadata, args.release_tag)
    validate_assets(args.directory, metadata)
    print("All five release assets are uploaded and match local sizes")
