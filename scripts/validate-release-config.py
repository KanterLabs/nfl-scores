#!/usr/bin/env python3
"""Validate the product-owned release and runtime contracts offline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "ci" / "release.json"
RUNTIME_PATH = ROOT / "ci" / "runtime.json"
METADATA_PATH = ROOT / "metadata.json"
UUID = "nfl-scores@shanekanterman"
ARTIFACT = f"{UUID}.shell-extension.zip"
CHECKSUM = f"{ARTIFACT}.sha256"
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)


def fail(message: str) -> None:
    raise SystemExit(f"release config: {message}")


def read_json(path: Path, label: str) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read {label}: {exc}")


def exact_keys(value: object, expected: set[str], label: str) -> None:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    unknown = sorted(set(value) - expected)
    missing = sorted(expected - set(value))
    if unknown or missing:
        fail(f"{label} keys must be {sorted(expected)!r}; unknown={unknown!r} missing={missing!r}")


def validate_release(config: object) -> None:
    exact_keys(config, {"schema", "project", "repository", "tag_format", "protected_assets", "targets"}, "release config")
    assert isinstance(config, dict)
    if config["schema"] != 1:
        fail("schema must be 1")
    if config["project"] != "nfl-scores":
        fail("project must be nfl-scores")
    if config["repository"] != "KanterLabs/nfl-scores":
        fail("repository must be KanterLabs/nfl-scores")
    if config["tag_format"] != "v{version}":
        fail("tag_format must be v{version}")

    protected = config["protected_assets"]
    if protected != [ARTIFACT, CHECKSUM]:
        fail(f"protected_assets must be [{ARTIFACT!r}, {CHECKSUM!r}]")

    targets = config["targets"]
    if not isinstance(targets, list) or len(targets) != 2:
        fail("targets must contain the ZIP and checksum")
    expected = {
        ("gnome-extension", ARTIFACT, ARTIFACT),
        ("sha256", CHECKSUM, CHECKSUM),
    }
    actual: set[tuple[object, object, object]] = set()
    for index, target in enumerate(targets):
        exact_keys(target, {"target", "path", "name"}, f"target {index}")
        assert isinstance(target, dict)
        if any(not isinstance(target[field], str) for field in ("target", "path", "name")):
            fail(f"target {index} target/path/name values must be strings")
        actual.add((target["target"], target["path"], target["name"]))
    if actual != expected:
        fail(f"targets must be {sorted(expected)!r}")


def validate_runtime(runtime: object) -> None:
    exact_keys(runtime, {"schema", "product", "version", "artifact", "targets", "live_probe", "trust"}, "runtime config")
    assert isinstance(runtime, dict)
    if runtime["schema"] != 1 or runtime["product"] != "nfl-scores":
        fail("runtime schema/product is incorrect")
    if not isinstance(runtime["version"], str) or not SEMVER.fullmatch(runtime["version"]):
        fail("runtime version must be semantic version text")
    if runtime["version"] != "0.1.0":
        fail("runtime version must be 0.1.0 for this provisional release")
    if runtime["artifact"] != ARTIFACT:
        fail("runtime artifact does not match the extension UUID")

    targets = runtime["targets"]
    if not isinstance(targets, list) or len(targets) != 2:
        fail("runtime targets must include Ubuntu 26.04 and Fedora 43")
    expected = {
        ("ubuntu-26.04-gnome50", "Ubuntu 26.04", "50"),
        ("fedora-43-gnome49", "Fedora Workstation 43", "49"),
    }
    actual: set[tuple[object, object, object]] = set()
    for index, target in enumerate(targets):
        exact_keys(target, {"id", "os", "gnome_shell", "runner", "mode", "required"}, f"runtime target {index}")
        assert isinstance(target, dict)
        if any(not isinstance(target[field], str) for field in ("id", "os", "gnome_shell", "runner", "mode")):
            fail(f"runtime target {index} id/os/gnome_shell/runner/mode values must be strings")
        actual.add((target["id"], target["os"], target["gnome_shell"]))
        if target["runner"] != "homelab-heavy" or target["mode"] != "parent-supplied-gnome-harness" or target["required"] is not True:
            fail(f"runtime target {target.get('id')} must use the parent GNOME harness on homelab-heavy")
    if actual != expected:
        fail("runtime targets must include Ubuntu 26.04/GNOME 50 and Fedora 43/GNOME 49")

    live_probe = runtime["live_probe"]
    exact_keys(live_probe, {"command", "runner", "trigger"}, "live_probe")
    assert isinstance(live_probe, dict)
    if live_probe != {"command": "node scripts/check-live.mjs", "runner": "homelab", "trigger": "manual-or-scheduled"}:
        fail("live_probe must remain separate from offline checks")

    trust = runtime["trust"]
    exact_keys(trust, {"fork_pull_requests", "build_credentials", "publish_credentials"}, "trust")
    if trust != {"fork_pull_requests": "skip", "build_credentials": "none", "publish_credentials": "shared-tool-only"}:
        fail("trust policy must keep fork PRs out of privileged runners and build jobs credential-free")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--runtime", type=Path, default=RUNTIME_PATH)
    args = parser.parse_args()
    config = read_json(args.config, "release config")
    runtime = read_json(args.runtime, "runtime config")
    metadata = read_json(METADATA_PATH, "metadata")
    validate_release(config)
    validate_runtime(runtime)
    exact_keys(metadata, {"name", "description", "uuid", "settings-schema", "shell-version", "version", "url"}, "metadata")
    assert isinstance(metadata, dict)
    if metadata.get("uuid") != UUID or metadata.get("version") != 1:
        fail("metadata.json uuid/version do not match the provisional release")
    if metadata.get("shell-version") != ["48", "49", "50"]:
        fail("metadata shell-version must advertise GNOME 48, 49, and 50")
    if metadata.get("settings-schema") != "org.gnome.shell.extensions.nfl-scores":
        fail("metadata settings-schema is incorrect")
    print("release config valid: nfl-scores v0.1.0 metadata-version 1")


if __name__ == "__main__":
    main()
