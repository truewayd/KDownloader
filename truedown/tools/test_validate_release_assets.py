import copy
from pathlib import Path
import tempfile
import unittest

from validate_release_assets import release_assets, validate_assets, validate_public


class UploadedAssetsTests(unittest.TestCase):
    def test_public_release_selection(self):
        release = {"tag_name": "truedown-build-48", "draft": False, "prerelease": False, "assets": ["fixture"]}
        self.assertEqual(release_assets([release], "truedown-build-48"), ["fixture"])
        for releases in [None, [], [release, release], [{**release, "draft": True}], [{**release, "prerelease": True}]]:
            with self.subTest(releases=releases), self.assertRaises(ValueError):
                release_assets(releases, "truedown-build-48")

    def test_upload_completeness_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = []
            for index in range(5):
                name = f"asset-{index}"
                Path(directory, name).write_bytes(b"payload")
                assets.append({"name": name, "state": "uploaded", "size": 7})
            validate_assets(directory, assets)
            release = {"id": 48, "tag_name": "truedown-build-48", "draft": False, "prerelease": False, "assets": assets}
            self.assertTrue(validate_public(directory, [release], "truedown-build-48", 48, assets))
            release["assets"] = []
            self.assertFalse(validate_public(directory, [release], "truedown-build-48", 48, assets))
            with self.assertRaises(ValueError):
                validate_public(directory, [release], "truedown-build-48", 49, assets)
            with self.assertRaises(ValueError):
                validate_public(directory, [release], "truedown-build-48", 48, assets[:4])
            invalid = [[], assets[:4], None, [*assets[:4], assets[0]], [*assets[:4], None]]
            for field, value in [("state", "new"), ("size", 6), ("size", True), ("name", "other")]:
                changed = copy.deepcopy(assets)
                changed[0][field] = value
                invalid.append(changed)
            for candidate in invalid:
                with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                    validate_assets(directory, candidate)


if __name__ == "__main__":
    unittest.main()
