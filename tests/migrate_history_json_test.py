import unittest

from migrate_history_json import convert_legacy_history


class MigrateHistoryJsonTests(unittest.TestCase):
    def test_converts_both_legacy_buckets_and_deduplicates(self):
        result = convert_legacy_history(
            {
                "downloaded": {"patreon": {"100": [1, "2", "2"]}},
                "coomerfansDownloaded": {"onlyfans": {"200": ["3"]}},
            },
            "2026-07-11T00:00:00.000Z",
        )

        self.assertEqual(result["schemaVersion"], 2)
        self.assertEqual(result["exportedAt"], "2026-07-11T00:00:00.000Z")
        self.assertEqual(len(result["records"]), 3)
        self.assertEqual(
            [(item["source"], item["postId"]) for item in result["records"]],
            [("coomerfans", "3"), ("default", "1"), ("default", "2")],
        )
        for record in result["records"]:
            self.assertEqual(record["status"], "complete")
            self.assertEqual(record["totalCount"], 0)
            self.assertEqual(record["successCount"], 0)
            self.assertEqual(record["failedCount"], 0)

    def test_rejects_unknown_or_new_format(self):
        with self.assertRaises(ValueError):
            convert_legacy_history({})
        with self.assertRaises(ValueError):
            convert_legacy_history({"schemaVersion": 2, "records": []})
        with self.assertRaises(ValueError):
            convert_legacy_history({"downloaded": []})


if __name__ == "__main__":
    unittest.main()
