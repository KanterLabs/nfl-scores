#!/usr/bin/env python3
"""Verify an NFL Scores extension artifact as an untrusted downloaded ZIP."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tempfile
import zipfile


UUID = "nfl-scores@shanekanterman"
ROOT = Path(__file__).resolve().parent.parent
SCHEMA_FILE = "schemas/org.gnome.shell.extensions.nfl-scores.gschema.xml"
EXPECTED_FILES = {
    "metadata.json",
    "extension.js",
    "scoreboard.js",
    "games.js",
    "field.js",
    "draw.js",
    "capture.js",
    "stylesheet.css",
    SCHEMA_FILE,
    "schemas/gschemas.compiled",
}
JS_FILES = [
    "extension.js",
    "scoreboard.js",
    "games.js",
    "field.js",
    "draw.js",
    "capture.js",
]


class VerificationError(Exception):
    pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("artifact", nargs="?", type=Path)
    result.add_argument("--self-test", action="store_true")
    return result


def safe_names(infos: list[zipfile.ZipInfo]) -> set[str]:
    names: set[str] = set()
    for info in infos:
        name = info.filename
        path = PurePosixPath(name)
        if not name or path.is_absolute() or ".." in path.parts or "\\" in name:
            raise VerificationError(f"unsafe ZIP member path: {name!r}")
        if name.endswith("/"):
            raise VerificationError(f"directory member is not allowed: {name!r}")
        if name in names:
            raise VerificationError(f"duplicate ZIP member: {name!r}")
        names.add(name)
        mode = (info.external_attr >> 16) & 0xFFFF
        if stat.S_ISLNK(mode):
            raise VerificationError(f"symlink ZIP member is not allowed: {name!r}")
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise VerificationError(f"non-regular ZIP member is not allowed: {name!r}")
    return names


def read_metadata(archive: zipfile.ZipFile) -> dict:
    try:
        metadata = json.loads(archive.read("metadata.json"))
    except KeyError as exc:
        raise VerificationError("metadata.json is missing") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"metadata.json is invalid: {exc}") from exc
    if not isinstance(metadata, dict):
        raise VerificationError("metadata.json must contain an object")
    if metadata.get("uuid") != UUID:
        raise VerificationError(f"metadata uuid must be {UUID!r}")
    version = metadata.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise VerificationError("metadata version must be a positive integer")
    if metadata.get("shell-version") != ["48", "49", "50"]:
        raise VerificationError("metadata shell-version must be exactly ['48', '49', '50']")
    if metadata.get("settings-schema") != "org.gnome.shell.extensions.nfl-scores":
        raise VerificationError("metadata settings-schema is incorrect")
    return metadata


def check_shape(path: Path) -> tuple[set[str], dict]:
    try:
        mode = path.lstat().st_mode
    except OSError as exc:
        raise VerificationError(f"artifact does not exist: {path}") from exc
    if stat.S_ISLNK(mode):
        raise VerificationError(f"artifact must not be a symlink: {path}")
    if not stat.S_ISREG(mode):
        raise VerificationError(f"artifact is not a regular file: {path}")
    if path.name != f"{UUID}.shell-extension.zip":
        raise VerificationError(f"artifact name must be {UUID}.shell-extension.zip")
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise VerificationError(f"artifact is not a readable ZIP: {exc}") from exc
    with archive:
        names = safe_names(archive.infolist())
        missing = EXPECTED_FILES - names
        extra = names - EXPECTED_FILES
        if missing:
            raise VerificationError(f"artifact is missing: {', '.join(sorted(missing))}")
        if extra:
            raise VerificationError(f"artifact contains unapproved files: {', '.join(sorted(extra))}")
        if len(archive.read("schemas/gschemas.compiled")) == 0:
            raise VerificationError("compiled GSettings schema is empty")
        metadata = read_metadata(archive)
    return names, metadata


def run_checked(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    try:
        result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    except OSError as exc:
        raise VerificationError(f"required command unavailable: {command[0]} ({exc})") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
        suffix = f": {detail[0]}" if detail else ""
        raise VerificationError(f"command failed ({' '.join(command)}): exit {result.returncode}{suffix}")


def check_runtime(path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="nfl-scores-artifact-") as temporary:
        root = Path(temporary)
        unpacked = root / "unpacked"
        unpacked.mkdir()
        with zipfile.ZipFile(path) as archive:
            archive.extractall(unpacked)

        glib = shutil.which("glib-compile-schemas")
        if not glib:
            raise VerificationError("glib-compile-schemas is required for artifact verification")
        run_checked([glib, "--strict", "--dry-run", str(unpacked / "schemas")])

        node = shutil.which("node")
        if not node:
            raise VerificationError("node is required for JavaScript artifact verification")
        for name in JS_FILES:
            run_checked([node, "--check", str(unpacked / name)], env=None)

        # Run the parser fixture suite against the extracted modules. This
        # keeps the downloaded ZIP as the code under test instead of silently
        # importing the source checkout.
        fixture_checker = ROOT / "scripts" / "check-fixtures.mjs"
        fixtures = ROOT / "fixtures"
        if not fixture_checker.is_file() or not fixtures.is_dir():
            raise VerificationError("offline fixture checker is unavailable")
        run_checked(
            [node, str(fixture_checker), "--module-dir", str(unpacked), str(fixtures)],
            cwd=ROOT,
            env=None,
        )

        # Exercise GNOME's own installer in an isolated XDG prefix.  No shell
        # session is enabled or changed by this check.
        installer = shutil.which("gnome-extensions")
        if not installer:
            raise VerificationError("gnome-extensions is required for install-layout verification")
        home = root / "home"
        data_home = home / ".local" / "share"
        config_home = home / ".config"
        cache_home = home / ".cache"
        for directory in (home, data_home, config_home, cache_home):
            directory.mkdir(parents=True, exist_ok=True)
        environment = os.environ.copy()
        environment.update({
            "HOME": str(home),
            "XDG_DATA_HOME": str(data_home),
            "XDG_CONFIG_HOME": str(config_home),
            "XDG_CACHE_HOME": str(cache_home),
        })
        run_checked([installer, "install", "--force", str(path)], env=environment)
        installed = data_home / "gnome-shell" / "extensions" / UUID
        for name in EXPECTED_FILES:
            if not (installed / name).is_file():
                raise VerificationError(f"GNOME installer omitted {name}")


def verify(path: Path, *, runtime: bool = True) -> None:
    check_shape(path)
    if runtime:
        check_runtime(path)


def write_archive(path: Path, names: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in names.items():
            info = zipfile.ZipInfo(name)
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)


def self_test() -> None:
    """Run black-box rejection cases without requiring GNOME dependencies."""
    metadata = json.dumps({"uuid": UUID, "version": 1, "shell-version": ["48", "49", "50"], "settings-schema": "org.gnome.shell.extensions.nfl-scores"}).encode()
    valid = {name: b"compiled" for name in EXPECTED_FILES}
    valid["metadata.json"] = metadata
    valid[SCHEMA_FILE] = b'<schemalist><schema id="org.gnome.shell.extensions.nfl-scores"/></schemalist>'
    cases: list[tuple[str, dict[str, bytes], str]] = [
        ("missing-schema", {k: v for k, v in valid.items() if k != SCHEMA_FILE}, "missing"),
        ("extra-private-file", {**valid, "ci/private.env": b"TOKEN=secret"}, "unapproved"),
        ("wrong-uuid", {**valid, "metadata.json": metadata.replace(UUID.encode(), b"other@example")}, "uuid"),
        ("path-traversal", {**valid, "../escape": b"nope"}, "unsafe"),
        ("empty-compiled-schema", {**valid, "schemas/gschemas.compiled": b""}, "empty"),
    ]
    with tempfile.TemporaryDirectory(prefix="nfl-scores-artifact-cases-") as temporary:
        root = Path(temporary)
        artifact = root / f"{UUID}.shell-extension.zip"
        for label, members, expected in cases:
            write_archive(artifact, members)
            try:
                verify(artifact, runtime=False)
            except VerificationError as error:
                if expected not in str(error):
                    raise SystemExit(f"self-test {label}: wrong rejection: {error}")
            else:
                raise SystemExit(f"self-test {label}: malformed artifact was accepted")
    print(f"artifact verifier failure cases: {len(cases)} rejected")


def main() -> None:
    args = parser().parse_args()
    if args.self_test:
        self_test()
        return
    if args.artifact is None:
        raise SystemExit("an artifact path is required")
    try:
        verify(args.artifact.resolve())
    except VerificationError as error:
        raise SystemExit(f"artifact verification failed: {error}") from error
    print(f"artifact verified: {args.artifact}")


if __name__ == "__main__":
    main()
