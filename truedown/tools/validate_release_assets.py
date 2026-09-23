"""Verify uploaded metadata against the already validated local release set."""
import json
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


if __name__ == "__main__":
    validate_assets(sys.argv[1], json.load(sys.stdin))
    print("All five release assets are uploaded and match local sizes")
