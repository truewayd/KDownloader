#!/usr/bin/env python3
"""Convert legacy KDownloader history JSON to IndexedDB export schema v2."""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any


MAX_RECORD_BYTES = 256 * 1024
MAX_IDENTITY_LENGTH = 4096
MAX_IMPORT_RECORDS = 1_000_000
MAX_IMPORT_BYTES = 256 * 1024 * 1024
MAX_INPUT_FILE_BYTES = 256 * 1024 * 1024
MAX_OUTPUT_FILE_BYTES = 64 * 1024 * 1024
ISO_TIMESTAMP_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):(\d{2}))$",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utf16_code_units(value: str, stop_after: int | None = None) -> int:
    """Count JavaScript string code units without allocating a UTF-16 copy."""
    total = 0
    for character in value:
        total += 2 if ord(character) > 0xFFFF else 1
        if stop_after is not None and total > stop_after:
            break
    return total


def normalize_legacy_id(value: Any, field: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError(f"Invalid {field}: expected a string or integer")
    raw_value = str(value)
    code_units = 0
    for character in raw_value:
        code_point = ord(character)
        if 0xD800 <= code_point <= 0xDFFF:
            raise ValueError(f"Invalid {field}: unpaired Unicode surrogate")
        if code_point <= 0x1F or code_point == 0x7F:
            raise ValueError(
                f"Invalid {field}: maximum length is {MAX_IDENTITY_LENGTH} without control characters"
            )
        code_units += 2 if code_point > 0xFFFF else 1
        if code_units > MAX_IDENTITY_LENGTH:
            raise ValueError(
                f"Invalid {field}: maximum length is {MAX_IDENTITY_LENGTH} without control characters"
            )
    normalized = raw_value.strip()
    if not normalized:
        raise ValueError(f"Empty {field}")
    return normalized


def importable_record_bytes(record: dict[str, Any]) -> int:
    approximate_bytes = 256 + sum(
        utf16_code_units(str(record[field]))
        for field in ("source", "service", "userId", "postId", "status", "updatedAt")
    ) * 2
    if approximate_bytes > MAX_RECORD_BYTES:
        raise ValueError("Legacy history record exceeds the 256 KiB import safety limit")
    return approximate_bytes


def normalize_export_timestamp(value: Any) -> str:
    error_message = "exportedAt must be a valid timezone-qualified ISO 8601 timestamp"
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError(error_message)
    match = ISO_TIMESTAMP_RE.fullmatch(value)
    if match is None:
        raise ValueError(error_message)

    (
        year_text,
        month_text,
        day_text,
        hour_text,
        minute_text,
        second_text,
        _fraction,
        _zone,
        _offset_sign,
        offset_hour_text,
        offset_minute_text,
    ) = match.groups()
    year = int(year_text)
    month = int(month_text)
    day = int(day_text)
    hour = int(hour_text)
    minute = int(minute_text)
    second = int(second_text)
    offset_hour = int(offset_hour_text or 0)
    offset_minute = int(offset_minute_text or 0)
    leap_year = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    month_days = (31, 29 if leap_year else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if (
        month < 1
        or month > 12
        or day < 1
        or day > month_days[month - 1]
        or hour > 23
        or minute > 59
        or second > 59
        or offset_hour > 14
        or offset_minute > 59
        or (offset_hour == 14 and offset_minute != 0)
    ):
        raise ValueError(error_message)
    return value


def append_bucket(
    raw: Any,
    source: str,
    updated_at: str,
    records: list[dict[str, Any]],
    maximum_bytes: int = MAX_IMPORT_BYTES,
) -> int:
    if raw is None:
        return 0
    if not isinstance(raw, dict):
        raise ValueError(f"{source} history must be an object")

    seen: set[tuple[str, str, str, str]] = set()
    approximate_bytes = 0
    for service, users in raw.items():
        if not isinstance(service, str) or not service.strip() or not isinstance(users, dict):
            raise ValueError(f"Invalid service bucket in {source} history")
        normalized_service = normalize_legacy_id(service, "service")
        for user_id, post_ids in users.items():
            if not isinstance(user_id, str) or not user_id.strip() or not isinstance(post_ids, list):
                raise ValueError(f"Invalid user bucket for {service!r} in {source} history")
            normalized_user_id = normalize_legacy_id(user_id, f"user id for {normalized_service!r}")
            for post_id in post_ids:
                normalized_post_id = normalize_legacy_id(
                    post_id,
                    f"post id for {normalized_service!r}/{normalized_user_id!r}",
                )
                identity = (source, normalized_service, normalized_user_id, normalized_post_id)
                if identity in seen:
                    continue
                seen.add(identity)
                record = {
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
                approximate_bytes += importable_record_bytes(record)
                if approximate_bytes > maximum_bytes:
                    raise ValueError("Legacy history exceeds the 256 MiB import safety limit")
                if len(records) >= MAX_IMPORT_RECORDS:
                    raise ValueError(f"Legacy history exceeds {MAX_IMPORT_RECORDS} records")
                records.append(record)
    return approximate_bytes


def convert_bucket(raw: Any, source: str, updated_at: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    append_bucket(raw, source, updated_at, records)
    return records


def convert_legacy_history(payload: Any, exported_at: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Legacy JSON root must be an object")
    if payload.get("schemaVersion") == 2 and isinstance(payload.get("records"), list):
        raise ValueError("Input is already schemaVersion 2")
    if "downloaded" not in payload and "coomerfansDownloaded" not in payload:
        raise ValueError("Legacy JSON must contain downloaded or coomerfansDownloaded")

    timestamp = normalize_export_timestamp(utc_now() if exported_at is None else exported_at)
    records: list[dict[str, Any]] = []
    approximate_bytes = 2
    approximate_bytes += append_bucket(
        payload.get("downloaded", {}),
        "default",
        timestamp,
        records,
        MAX_IMPORT_BYTES - approximate_bytes,
    )
    approximate_bytes += append_bucket(
        payload.get("coomerfansDownloaded", {}),
        "coomerfans",
        timestamp,
        records,
        MAX_IMPORT_BYTES - approximate_bytes,
    )
    if approximate_bytes > MAX_IMPORT_BYTES:
        raise ValueError("Legacy history exceeds the 256 MiB import safety limit")
    records.sort(key=lambda item: (item["source"], item["service"], item["userId"], item["postId"]))
    converted = {"schemaVersion": 2, "exportedAt": timestamp, "records": records}
    if compact_json_byte_length(converted, MAX_OUTPUT_FILE_BYTES) + 1 > MAX_OUTPUT_FILE_BYTES:
        raise ValueError("Converted history exceeds the 64 MiB popup import limit")
    return converted


def default_output_path(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}.v2.json")


def compact_json_byte_length(value: Any, stop_after: int | None = None) -> int:
    total_bytes = 0
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))
    for text_chunk in encoder.iterencode(value):
        total_bytes += len(text_chunk.encode("utf-8"))
        if stop_after is not None and total_bytes > stop_after:
            break
    return total_bytes


def read_json_limited(input_path: Path, maximum_bytes: int = MAX_INPUT_FILE_BYTES) -> Any:
    if not isinstance(maximum_bytes, int) or maximum_bytes <= 0:
        raise ValueError("Input size limit must be a positive integer")
    with input_path.open("rb") as source:
        raw = source.read(maximum_bytes + 1)
    if len(raw) > maximum_bytes:
        raise ValueError("Legacy history exceeds the 256 MiB input safety limit")
    return json.loads(raw.decode("utf-8-sig"))


def sync_parent_directory(path: Path) -> None:
    # POSIX requires synchronizing the directory entry as well as the file for
    # rename/link publication to survive a sudden power loss. Python cannot
    # open Windows directories with the flags needed by FlushFileBuffers, so
    # NTFS publication relies on the platform's atomic namespace operation.
    if os.name == "nt":
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path.parent, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_json_atomic(
    output_path: Path,
    payload: dict[str, Any],
    maximum_bytes: int = MAX_OUTPUT_FILE_BYTES,
    *,
    overwrite: bool = True,
) -> None:
    if not isinstance(maximum_bytes, int) or maximum_bytes <= 0:
        raise ValueError("Output size limit must be a positive integer")
    temporary_path: Path | None = None
    try:
        with NamedTemporaryFile(
            mode="wb",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            total_bytes = 0
            encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))
            for text_chunk in encoder.iterencode(payload):
                byte_chunk = text_chunk.encode("utf-8")
                total_bytes += len(byte_chunk)
                if total_bytes + 1 > maximum_bytes:
                    raise ValueError("Converted history exceeds the 64 MiB popup import limit")
                temporary.write(byte_chunk)
            temporary.write(b"\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        if overwrite:
            os.replace(temporary_path, output_path)
        else:
            # A same-directory hard link provides an atomic no-clobber publish:
            # if another process created the destination after our preflight,
            # link() fails without changing either file.
            os.link(temporary_path, output_path)
            try:
                temporary_path.unlink()
            except OSError:
                # The output is already a durable name for the fsynced inode.
                # A leftover hidden link is safer than reporting publication as
                # failed and encouraging a destructive retry.
                pass
        sync_parent_directory(output_path)
        temporary_path = None
    except BaseException:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


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
        payload = read_json_limited(input_path)
        converted = convert_legacy_history(payload)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        write_json_atomic(output_path, converted, overwrite=args.overwrite)
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))
    print(f"Converted {len(converted['records'])} records -> {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
