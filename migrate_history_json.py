#!/usr/bin/env python3
"""Convert legacy KDownloader history JSON to IndexedDB export schema v2."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def convert_bucket(raw: Any, source: str, updated_at: str) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise ValueError(f"{source} history must be an object")

    records: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for service, users in raw.items():
        if not isinstance(service, str) or not service.strip() or not isinstance(users, dict):
            raise ValueError(f"Invalid service bucket in {source} history")
        for user_id, post_ids in users.items():
            if not isinstance(user_id, str) or not user_id.strip() or not isinstance(post_ids, list):
                raise ValueError(f"Invalid user bucket for {service!r} in {source} history")
            for post_id in post_ids:
                post_id = str(post_id).strip()
                if not post_id:
                    raise ValueError(f"Empty post id for {service!r}/{user_id!r}")
                identity = (source, service.strip(), user_id.strip(), post_id)
                if identity in seen:
                    continue
                seen.add(identity)
                records.append(
                    {
                        "source": source,
                        "service": identity[1],
                        "userId": identity[2],
                        "postId": identity[3],
                        "status": "complete",
                        # The legacy format stored only a post-level boolean, so
                        # per-file counts cannot be reconstructed accurately.
                        "totalCount": 0,
                        "successCount": 0,
                        "failedCount": 0,
                        "updatedAt": updated_at,
                    }
                )
    return records


def convert_legacy_history(payload: Any, exported_at: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Legacy JSON root must be an object")
    if payload.get("schemaVersion") == 2 and isinstance(payload.get("records"), list):
        raise ValueError("Input is already schemaVersion 2")
    if "downloaded" not in payload and "coomerfansDownloaded" not in payload:
        raise ValueError("Legacy JSON must contain downloaded or coomerfansDownloaded")

    timestamp = exported_at or utc_now()
    records = [
        *convert_bucket(payload.get("downloaded", {}), "default", timestamp),
        *convert_bucket(payload.get("coomerfansDownloaded", {}), "coomerfans", timestamp),
    ]
    records.sort(key=lambda item: (item["source"], item["service"], item["userId"], item["postId"]))
    return {"schemaVersion": 2, "exportedAt": timestamp, "records": records}


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}.v2.json")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert legacy {downloaded, coomerfansDownloaded} JSON to KDownloader schema v2."
    )
    parser.add_argument("input", type=Path, help="Legacy history JSON file")
    parser.add_argument("output", nargs="?", type=Path, help="Output path; defaults to <input>.v2.json")
    parser.add_argument("--overwrite", action="store_true", help="Allow replacing an existing output file")
    args = parser.parse_args()

    input_path = args.input.resolve()
    output_path = (args.output or default_output_path(input_path)).resolve()
    if not input_path.is_file():
        parser.error(f"input file does not exist: {input_path}")
    if input_path == output_path:
        parser.error("input and output paths must be different")
    if output_path.exists() and not args.overwrite:
        parser.error(f"output already exists: {output_path} (use --overwrite)")

    try:
        payload = json.loads(input_path.read_text(encoding="utf-8-sig"))
        converted = convert_legacy_history(payload)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(converted, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Converted {len(converted['records'])} records -> {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
