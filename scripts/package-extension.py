#!/usr/bin/env python3
"""Create a deterministic GNOME Shell extension ZIP from a staging tree."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
import zipfile


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--uuid", required=True)
    return parser.parse_args()


def zip_datetime() -> tuple[int, int, int, int, int, int]:
    try:
        epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))
    except ValueError as exc:
        raise SystemExit("SOURCE_DATE_EPOCH must be an integer") from exc
    # ZIP timestamps cannot represent dates before 1980.  The package's
    # content hash must not depend on the source checkout's mtimes.
    import datetime

    timestamp = datetime.datetime.fromtimestamp(max(epoch, 315532800), datetime.UTC)
    return (timestamp.year, timestamp.month, timestamp.day, timestamp.hour, timestamp.minute, timestamp.second)


def files_under(source: Path) -> list[tuple[str, Path]]:
    files: list[tuple[str, Path]] = []
    for path in source.rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"refusing non-regular package input: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise SystemExit(f"refusing non-regular package input: {path}")
        name = path.relative_to(source).as_posix()
        if name.startswith("/") or ".." in Path(name).parts:
            raise SystemExit(f"unsafe package path: {name}")
        files.append((name, path))
    return sorted(files)


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not source.is_dir():
        raise SystemExit(f"package source is not a directory: {source}")

    metadata_path = source / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read package metadata: {exc}") from exc
    if metadata.get("uuid") != args.uuid:
        raise SystemExit(f"metadata uuid is {metadata.get('uuid')!r}, expected {args.uuid!r}")
    if not isinstance(metadata.get("version"), int) or isinstance(metadata["version"], bool):
        raise SystemExit("metadata version must be an integer")

    files = files_under(source)
    if not files:
        raise SystemExit("package source is empty")
    output.parent.mkdir(parents=True, exist_ok=True)
    timestamp = zip_datetime()

    # Write beside the destination and atomically replace it so an interrupted
    # package cannot leave a partially written release artifact.
    with tempfile.NamedTemporaryFile(prefix=f".{output.name}.", dir=output.parent, delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, path in files:
                info = zipfile.ZipInfo(name, date_time=timestamp)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.extra = b""
                info.comment = b""
                archive.writestr(info, path.read_bytes())
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)

    print(output)


if __name__ == "__main__":
    main()
