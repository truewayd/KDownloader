import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from migrate_history_json import (
    convert_legacy_history,
    normalize_export_timestamp,
    read_json_limited,
    utf16_code_units,
    write_json_atomic,
)


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
        with self.assertRaisesRegex(ValueError, "exportedAt"):
            convert_legacy_history({"downloaded": {}}, "not-a-date")
        with self.assertRaisesRegex(ValueError, "exportedAt"):
            convert_legacy_history({"downloaded": {}}, "")
        with self.assertRaisesRegex(ValueError, "timezone"):
            convert_legacy_history({"downloaded": {}}, "2026-08-30T01:00:00")

    def test_rejects_structured_boolean_and_oversized_post_ids(self):
        for invalid in (True, None, {"nested": "id"}, ["id"], 1.5):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    convert_legacy_history({"downloaded": {"patreon": {"100": [invalid]}}})

        with self.assertRaisesRegex(ValueError, "4096"):
            convert_legacy_history(
                {"downloaded": {"patreon": {"100": ["x" * 4097]}}}
            )
        with self.assertRaisesRegex(ValueError, "control characters"):
            convert_legacy_history({"downloaded": {"patreon": {"100": ["bad\npost"]}}})
        for control_character in ("\0", "\t", "\v", "\x1f", "\x7f"):
            with self.subTest(control_character=repr(control_character)):
                with self.assertRaisesRegex(ValueError, "control characters"):
                    convert_legacy_history(
                        {"downloaded": {"patreon": {"100": [f"bad{control_character}post"]}}}
                    )
        with self.assertRaisesRegex(ValueError, "control characters"):
            convert_legacy_history({"downloaded": {"patreon": {"100": ["\tpost"]}}})
        with self.assertRaisesRegex(ValueError, "surrogate"):
            convert_legacy_history(
                {"downloaded": {"patreon": {"100": [chr(0xD800)]}}}
            )

    def test_identity_limit_uses_javascript_utf16_code_units(self):
        accepted = "😀" * 2048
        converted = convert_legacy_history(
            {"downloaded": {"patreon": {"100": [accepted]}}}
        )
        self.assertEqual(converted["records"][0]["postId"], accepted)

        with self.assertRaisesRegex(ValueError, "4096"):
            convert_legacy_history(
                {"downloaded": {"patreon": {"100": ["😀" * 2049]}}}
            )
        self.assertEqual(utf16_code_units("x" * 1_000_000, stop_after=4096), 4097)

    def test_export_timestamp_matches_javascript_import_contract(self):
        accepted = (
            "0000-02-29T23:59:59.123456789Z",
            "2024-02-29T23:59:59+14:00",
            "2026-01-01T00:00:00z",
            "2026-01-01T00:00:00-00:00",
        )
        for timestamp in accepted:
            with self.subTest(timestamp=timestamp):
                self.assertEqual(normalize_export_timestamp(timestamp), timestamp)

        rejected = (
            "2026-01-01 00:00:00Z",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00+14:01",
            "2026-01-01T00:00:00+15:00",
            "2025-02-29T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00:00.1234567890Z",
            " 2026-01-01T00:00:00Z",
        )
        for timestamp in rejected:
            with self.subTest(timestamp=timestamp):
                with self.assertRaisesRegex(ValueError, "timezone-qualified ISO 8601"):
                    normalize_export_timestamp(timestamp)

    def test_conversion_respects_popup_file_limit(self):
        with patch("migrate_history_json.MAX_OUTPUT_FILE_BYTES", 64):
            with self.assertRaisesRegex(ValueError, "64 MiB popup import limit"):
                convert_legacy_history(
                    {"downloaded": {"patreon": {"100": ["post-id"]}}}
                )

    def test_input_reader_stops_at_its_byte_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory, "legacy.json")
            input_path.write_bytes(b'{"downloaded":{}}')
            with self.assertRaisesRegex(ValueError, "input safety limit"):
                read_json_limited(input_path, maximum_bytes=4)

    def test_atomic_write_preserves_existing_output_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            output_path.write_text("original\n", encoding="utf-8")

            with patch("migrate_history_json.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    write_json_atomic(output_path, {"schemaVersion": 2, "records": []})

            self.assertEqual(output_path.read_text(encoding="utf-8"), "original\n")
            self.assertEqual(
                [entry for entry in os.listdir(directory) if entry.endswith(".tmp")],
                [],
            )

    def test_atomic_write_emits_valid_utf8_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            payload = {"schemaVersion": 2, "records": [{"postId": "测试"}]}
            write_json_atomic(output_path, payload)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), payload)

    def test_atomic_write_preserves_existing_output_at_size_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            output_path.write_text("original\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "64 MiB popup import limit"):
                write_json_atomic(
                    output_path,
                    {"schemaVersion": 2, "records": [{"postId": "too-large"}]},
                    maximum_bytes=16,
                )

            self.assertEqual(output_path.read_text(encoding="utf-8"), "original\n")
            self.assertEqual(
                [entry for entry in os.listdir(directory) if entry.endswith(".tmp")],
                [],
            )

    def test_atomic_write_keeps_primary_error_when_temp_cleanup_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            output_path.write_text("original\n", encoding="utf-8")

            with patch("migrate_history_json.os.replace", side_effect=OSError("replace failed")):
                with patch.object(Path, "unlink", side_effect=OSError("cleanup failed")):
                    with self.assertRaisesRegex(OSError, "replace failed"):
                        write_json_atomic(output_path, {"schemaVersion": 2, "records": []})

            self.assertEqual(output_path.read_text(encoding="utf-8"), "original\n")

    def test_atomic_no_clobber_publish_rejects_a_racing_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            real_link = os.link

            def publish_after_competitor(source, destination):
                Path(destination).write_text("competitor\n", encoding="utf-8")
                return real_link(source, destination)

            with patch("migrate_history_json.os.link", side_effect=publish_after_competitor):
                with self.assertRaises(FileExistsError):
                    write_json_atomic(
                        output_path,
                        {"schemaVersion": 2, "records": []},
                        overwrite=False,
                    )

            self.assertEqual(output_path.read_text(encoding="utf-8"), "competitor\n")
            self.assertEqual(
                [entry for entry in os.listdir(directory) if entry.endswith(".tmp")],
                [],
            )

    def test_atomic_no_clobber_publish_succeeds_without_a_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory, "history.v2.json")
            payload = {"schemaVersion": 2, "records": []}
            write_json_atomic(output_path, payload, overwrite=False)
            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), payload)
            self.assertEqual(
                [entry for entry in os.listdir(directory) if entry.endswith(".tmp")],
                [],
            )


if __name__ == "__main__":
    unittest.main()
