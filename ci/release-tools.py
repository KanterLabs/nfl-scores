#!/usr/bin/env python3
"""Small, dependency-free release manifest and asset publishing CLI."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterable
from urllib.parse import parse_qsl, quote, urljoin, urlsplit, urlunsplit
import uuid


SCHEMA = 1
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
MAX_JSON_RESPONSE = 4 * 1024 * 1024
HTTP_TIMEOUT = 30
MANIFEST_ASSET_NAME = "release-manifest.json"


class ReleaseError(Exception):
    """An expected, safe-to-report CLI failure."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


EXIT_CODES = {
    "invalid-arguments": 2,
    "invalid-config": 2,
    "invalid-manifest": 2,
    "unsafe-path": 2,
    "missing-target": 3,
    "integrity-mismatch": 3,
    "asset-conflict": 4,
    "asset-unverifiable": 4,
    "auth-required": 5,
    "release-not-found": 6,
    "remote-error": 7,
    "network-error": 7,
    "export-error": 8,
    "receipt-error": 8,
    "internal-error": 9,
}


def _fail(code: str, message: str, **details: Any) -> None:
    raise ReleaseError(code, message, **details)


def _is_safe_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        _fail("invalid-config", f"{field} must be a non-empty string")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        _fail("invalid-config", f"{field} contains a control character")
    return value


def _validate_project(value: Any, field: str = "project") -> str:
    text = _is_safe_text(value, field)
    if any(char in text for char in "/\\"):
        _fail("invalid-config", f"{field} contains a path separator")
    return text


def _validate_repository(value: Any, field: str = "repository") -> str:
    text = _is_safe_text(value, field)
    if not REPOSITORY_RE.fullmatch(text):
        _fail("invalid-config", f"{field} must be owner/name")
    owner, name = text.split("/", 1)
    if owner in {".", ".."} or name in {".", ".."}:
        _fail("invalid-config", f"{field} contains an invalid component")
    return text


def _validate_version(value: Any) -> str:
    text = _is_safe_text(value, "version")
    if any(char in text for char in "/\\") or text in {".", ".."}:
        _fail("invalid-config", "version contains a path component")
    if text != text.strip() or "{" in text or "}" in text:
        _fail("invalid-config", "version contains whitespace or braces")
    return text


def _validate_tag(value: Any, field: str = "release.tag") -> str:
    text = _is_safe_text(value, field)
    if any(char in text for char in "/\\") or text in {".", ".."}:
        _fail("invalid-manifest", f"{field} contains a path component")
    if text != text.strip() or "{" in text or "}" in text:
        _fail("invalid-manifest", f"{field} contains whitespace or braces")
    return text


def _validate_commit(value: Any) -> str:
    if not isinstance(value, str) or not SHA1_RE.fullmatch(value):
        _fail("invalid-config", "commit must be an exact lower-case 40-character Git SHA")
    return value


def _validate_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        _fail("invalid-manifest", f"{field} must be 64 lower-case hexadecimal characters")
    return value


def _validate_target_key(value: Any, field: str) -> str:
    text = _is_safe_text(value, field)
    if text in {".", ".."}:
        _fail("invalid-config", f"{field} is invalid")
    return text


def _validate_relative_path(value: Any, field: str) -> str:
    text = _is_safe_text(value, field)
    if "\\" in text or text.startswith("/") or text.endswith("/"):
        _fail("unsafe-path", f"{field} must be a relative POSIX file path", field=field)
    if "\x00" in text:
        _fail("unsafe-path", f"{field} contains NUL", field=field)
    path = PurePosixPath(text)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        _fail("unsafe-path", f"{field} escapes the artifact directory", field=field)
    return "/".join(path.parts)


def _validate_asset_name(value: Any, field: str) -> str:
    text = _is_safe_text(value, field)
    if text in {".", ".."} or "/" in text or "\\" in text:
        _fail("invalid-config", f"{field} must be a flat release asset name")
    return text


def _load_json(path: Path, kind: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        _fail(f"invalid-{kind}", f"{kind} file does not exist", path=str(path))
    except (OSError, UnicodeError):
        _fail(f"invalid-{kind}", f"could not read {kind} file", path=str(path))
    except json.JSONDecodeError as exc:
        _fail(f"invalid-{kind}", f"{kind} is not valid JSON", line=exc.lineno, column=exc.colno)
    if not isinstance(value, dict):
        _fail(f"invalid-{kind}", f"{kind} root must be a JSON object")
    return value


def _ensure_allowed_keys(value: dict[str, Any], allowed: set[str], kind: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        _fail(f"invalid-{kind}", f"{kind} contains unknown fields", fields=unknown)


def _read_config(path: Path) -> dict[str, Any]:
    value = _load_json(path, "config")
    # Product release.json files carry runtime and packaging metadata beside
    # the shared publisher settings. When present, only the nested
    # `release_tools` object is interpreted here; its schema remains strict
    # and the top-level product fields are intentionally outside this tool's
    # ownership. Standalone shared-tool configs continue to use the root.
    if "release_tools" in value:
        nested = value.get("release_tools")
        if not isinstance(nested, dict):
            _fail("invalid-config", "release_tools must be an object")
        value = nested
    _ensure_allowed_keys(
        value,
        {"schema", "project", "repository", "tag_format", "protected_assets", "targets"},
        "config",
    )
    if value.get("schema") != SCHEMA:
        _fail("invalid-config", "config schema must be 1")
    project = _validate_project(value.get("project"), "project")
    repository = _validate_repository(value.get("repository"))

    tag_format = value.get("tag_format", "v{version}")
    tag_format = _is_safe_text(tag_format, "tag_format")
    if tag_format.count("{version}") != 1 or "{" in tag_format.replace("{version}", ""):
        _fail("invalid-config", "tag_format must contain exactly one {version} placeholder")
    if "}" in tag_format.replace("{version}", ""):
        _fail("invalid-config", "tag_format contains an invalid placeholder")

    protected_raw = value.get("protected_assets", [])
    if not isinstance(protected_raw, list) or any(not isinstance(item, str) for item in protected_raw):
        _fail("invalid-config", "protected_assets must be a list of strings")
    protected_assets = [_validate_asset_name(item, "protected_assets item") for item in protected_raw]
    if len(set(protected_assets)) != len(protected_assets):
        _fail("invalid-config", "protected_assets contains duplicates")

    targets_raw = value.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        _fail("invalid-config", "targets must be a non-empty list")
    targets: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    seen_paths: set[str] = set()
    seen_names: set[str] = set()
    for index, raw_target in enumerate(targets_raw):
        if not isinstance(raw_target, dict):
            _fail("invalid-config", f"target {index} must be an object")
        _ensure_allowed_keys(raw_target, {"target", "path", "name"}, "config target")
        target = _validate_target_key(raw_target.get("target"), f"targets[{index}].target")
        path_value = _validate_relative_path(raw_target.get("path"), f"targets[{index}].path")
        name_value = raw_target.get("name", PurePosixPath(path_value).name)
        name_value = _validate_asset_name(name_value, f"targets[{index}].name")
        if target in seen_targets or path_value in seen_paths or name_value in seen_names:
            _fail("invalid-config", f"target {index} duplicates a target, path, or asset name")
        seen_targets.add(target)
        seen_paths.add(path_value)
        seen_names.add(name_value)
        targets.append({"target": target, "path": path_value, "name": name_value})

    unknown_protected = sorted(set(protected_assets) - seen_names)
    if unknown_protected:
        _fail("invalid-config", "protected_assets names no target", names=unknown_protected)

    return {
        "schema": SCHEMA,
        "project": project,
        "repository": repository,
        "tag_format": tag_format,
        "protected_assets": protected_assets,
        "targets": targets,
    }


def _read_manifest(path: Path) -> dict[str, Any]:
    value = _load_json(path, "manifest")
    _ensure_allowed_keys(
        value,
        {"schema", "project", "repository", "release", "protected_assets", "targets"},
        "manifest",
    )
    if value.get("schema") != SCHEMA:
        _fail("invalid-manifest", "manifest schema must be 1")
    project = _validate_project(value.get("project"), "project")
    repository = _validate_repository(value.get("repository"))
    release = value.get("release")
    if not isinstance(release, dict):
        _fail("invalid-manifest", "release must be an object")
    _ensure_allowed_keys(release, {"version", "tag", "commit"}, "manifest release")
    version = _validate_version(release.get("version"))
    tag = _validate_tag(release.get("tag"))
    commit = _validate_commit(release.get("commit"))

    protected_raw = value.get("protected_assets", [])
    if not isinstance(protected_raw, list) or any(not isinstance(item, str) for item in protected_raw):
        _fail("invalid-manifest", "protected_assets must be a list of strings")
    protected_assets = [_validate_asset_name(item, "protected_assets item") for item in protected_raw]
    if len(set(protected_assets)) != len(protected_assets):
        _fail("invalid-manifest", "protected_assets contains duplicates")

    targets_raw = value.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        _fail("invalid-manifest", "targets must be a non-empty list")
    targets: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    seen_paths: set[str] = set()
    seen_names: set[str] = set()
    for index, raw_target in enumerate(targets_raw):
        if not isinstance(raw_target, dict):
            _fail("invalid-manifest", f"target {index} must be an object")
        _ensure_allowed_keys(
            raw_target,
            {"target", "path", "name", "size", "sha256", "protected"},
            "manifest target",
        )
        target = _validate_target_key(raw_target.get("target"), f"targets[{index}].target")
        path_value = _validate_relative_path(raw_target.get("path"), f"targets[{index}].path")
        name_value = _validate_asset_name(raw_target.get("name"), f"targets[{index}].name")
        size_value = raw_target.get("size")
        if isinstance(size_value, bool) or not isinstance(size_value, int) or size_value < 0:
            _fail("invalid-manifest", f"targets[{index}].size must be a non-negative integer")
        sha_value = _validate_sha256(raw_target.get("sha256"), f"targets[{index}].sha256")
        protected_value = raw_target.get("protected")
        if not isinstance(protected_value, bool):
            _fail("invalid-manifest", f"targets[{index}].protected must be boolean")
        if target in seen_targets or path_value in seen_paths or name_value in seen_names:
            _fail("invalid-manifest", f"target {index} duplicates a target, path, or asset name")
        seen_targets.add(target)
        seen_paths.add(path_value)
        seen_names.add(name_value)
        if protected_value != (name_value in protected_assets):
            _fail("invalid-manifest", f"targets[{index}].protected disagrees with protected_assets")
        targets.append(
            {
                "target": target,
                "path": path_value,
                "name": name_value,
                "size": size_value,
                "sha256": sha_value,
                "protected": protected_value,
            }
        )
    unknown_protected = sorted(set(protected_assets) - seen_names)
    if unknown_protected:
        _fail("invalid-manifest", "protected_assets names no target", names=unknown_protected)

    return {
        "schema": SCHEMA,
        "project": project,
        "repository": repository,
        "release": {"version": version, "tag": tag, "commit": commit},
        "protected_assets": protected_assets,
        "targets": targets,
    }


def _ensure_artifact_root(path: Path) -> Path:
    try:
        if path.is_symlink() or not path.is_dir():
            _fail("unsafe-path", "artifact directory must be a real directory", path=str(path))
        return path.resolve(strict=True)
    except OSError:
        _fail("missing-target", "artifact directory does not exist", path=str(path))


def _safe_artifact_file(root: Path, relative: str) -> Path:
    parts = relative.split("/")
    current = root
    for index, part in enumerate(parts):
        current = current / part
        try:
            if current.is_symlink():
                _fail("unsafe-path", "artifact path contains a symlink", path=relative)
            if index < len(parts) - 1 and not current.is_dir():
                _fail("missing-target", "artifact path parent is not a directory", path=relative)
        except OSError:
            _fail("missing-target", "could not inspect artifact path", path=relative)
    try:
        if not current.is_file():
            _fail("missing-target", "artifact target is not a regular file", path=relative)
        return current
    except OSError:
        _fail("missing-target", "could not inspect artifact target", path=relative)


def _inventory(root: Path) -> set[str]:
    files: set[str] = set()
    try:
        for directory, directories, filenames in os.walk(root, topdown=True, followlinks=False):
            directory_path = Path(directory)
            if directory_path.is_symlink():
                _fail("unsafe-path", "artifact directory contains a symlink", path=str(directory_path))
            for name in list(directories):
                candidate = directory_path / name
                if candidate.is_symlink():
                    _fail("unsafe-path", "artifact directory contains a symlink", path=str(candidate.relative_to(root)))
            for name in filenames:
                candidate = directory_path / name
                relative = candidate.relative_to(root).as_posix()
                if candidate.is_symlink():
                    _fail("unsafe-path", "artifact directory contains a symlink", path=relative)
                if not candidate.is_file():
                    _fail("missing-target", "artifact entry is not a regular file", path=relative)
                files.add(relative)
    except OSError:
        _fail("missing-target", "could not inspect artifact directory", path=str(root))
    return files


def _hash_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
        observed_size = path.stat().st_size
    except OSError:
        _fail("missing-target", "could not read artifact target", path=str(path))
    if observed_size != size:
        _fail("integrity-mismatch", "artifact changed while it was being hashed", path=str(path))
    return size, digest.hexdigest()


def _atomic_write_json(path: Path, value: dict[str, Any], code: str = "invalid-config") -> None:
    parent = path.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.is_symlink():
            _fail("unsafe-path", "output path must not be a symlink", path=str(path))
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(parent), prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except ReleaseError:
        raise
    except OSError:
        try:
            if "temporary" in locals():
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        _fail(code, "could not write output file", path=str(path))


def _write_receipt(path_value: str | None, value: dict[str, Any]) -> None:
    """Persist a publisher receipt using the same crash-safe JSON writer."""

    if path_value is None:
        return
    _atomic_write_json(Path(path_value), value, code="receipt-error")


def _manifest_hash(path: Path) -> str:
    if path.is_symlink():
        _fail("unsafe-path", "manifest path must not be a symlink", path=str(path))
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        _fail("invalid-manifest", "could not hash manifest file", path=str(path))
    return digest.hexdigest()


def _manifest_asset(path: Path) -> dict[str, Any]:
    """Describe the validated manifest as the one allowed external sidecar."""

    if path.is_symlink() or not path.is_file():
        _fail("invalid-manifest", "manifest path must be a regular file", path=str(path))
    size, sha256 = _hash_file(path)
    return {
        "target": "release-manifest",
        "path": str(path),
        "name": MANIFEST_ASSET_NAME,
        "size": size,
        "sha256": sha256,
        "protected": True,
    }


def _manifest_from_config(config: dict[str, Any], artifacts: Path, version: str, commit: str) -> dict[str, Any]:
    version = _validate_version(version)
    commit = _validate_commit(commit)
    try:
        tag = config["tag_format"].replace("{version}", version)
    except (KeyError, AttributeError):
        _fail("invalid-config", "config tag_format is invalid")
    tag = _validate_tag(tag, "release.tag")
    root = _ensure_artifact_root(artifacts)
    expected_paths = {target["path"] for target in config["targets"]}
    inventory = _inventory(root)
    extras = sorted(inventory - expected_paths)
    missing = sorted(expected_paths - inventory)
    if missing:
        _fail("missing-target", "artifact directory is missing configured targets", paths=missing)
    if extras:
        _fail("invalid-config", "artifact directory contains unconfigured files", paths=extras)

    targets: list[dict[str, Any]] = []
    protected = set(config["protected_assets"])
    for target in config["targets"]:
        file_path = _safe_artifact_file(root, target["path"])
        size, sha256 = _hash_file(file_path)
        targets.append(
            {
                "target": target["target"],
                "path": target["path"],
                "name": target["name"],
                "size": size,
                "sha256": sha256,
                "protected": target["name"] in protected,
            }
        )
    return {
        "schema": SCHEMA,
        "project": config["project"],
        "repository": config["repository"],
        "release": {"version": version, "tag": tag, "commit": commit},
        "protected_assets": config["protected_assets"],
        "targets": targets,
    }


def _verify_manifest(manifest: dict[str, Any], artifacts: Path) -> dict[str, Any]:
    normalized = _read_manifest_from_value(manifest)
    root = _ensure_artifact_root(artifacts)
    expected_paths = {target["path"] for target in normalized["targets"]}
    inventory = _inventory(root)
    missing = sorted(expected_paths - inventory)
    extras = sorted(inventory - expected_paths)
    if missing:
        _fail("missing-target", "artifact directory is missing manifest targets", paths=missing)
    if extras:
        _fail("invalid-manifest", "artifact directory contains files absent from manifest", paths=extras)
    for target in normalized["targets"]:
        file_path = _safe_artifact_file(root, target["path"])
        size, sha256 = _hash_file(file_path)
        if size != target["size"]:
            _fail(
                "integrity-mismatch",
                "artifact size does not match manifest",
                target=target["target"],
                expected=target["size"],
                observed=size,
            )
        if sha256 != target["sha256"]:
            _fail(
                "integrity-mismatch",
                "artifact SHA-256 does not match manifest",
                target=target["target"],
                expected=target["sha256"],
                observed=sha256,
            )
    return normalized


def _read_manifest_from_value(value: dict[str, Any]) -> dict[str, Any]:
    # Reuse the exact file validator for semantic consistency without creating
    # a temporary file or serializing untrusted values.
    _ensure_allowed_keys(
        value,
        {"schema", "project", "repository", "release", "protected_assets", "targets"},
        "manifest",
    )
    if value.get("schema") != SCHEMA:
        _fail("invalid-manifest", "manifest schema must be 1")
    project = _validate_project(value.get("project"), "project")
    repository = _validate_repository(value.get("repository"))
    release = value.get("release")
    if not isinstance(release, dict):
        _fail("invalid-manifest", "release must be an object")
    _ensure_allowed_keys(release, {"version", "tag", "commit"}, "manifest release")
    version = _validate_version(release.get("version"))
    tag = _validate_tag(release.get("tag"))
    commit = _validate_commit(release.get("commit"))
    protected_raw = value.get("protected_assets", [])
    if not isinstance(protected_raw, list) or any(not isinstance(item, str) for item in protected_raw):
        _fail("invalid-manifest", "protected_assets must be a list of strings")
    protected_assets = [_validate_asset_name(item, "protected_assets item") for item in protected_raw]
    if len(set(protected_assets)) != len(protected_assets):
        _fail("invalid-manifest", "protected_assets contains duplicates")
    targets_raw = value.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        _fail("invalid-manifest", "targets must be a non-empty list")
    targets: list[dict[str, Any]] = []
    seen_targets: set[str] = set()
    seen_paths: set[str] = set()
    seen_names: set[str] = set()
    for index, raw_target in enumerate(targets_raw):
        if not isinstance(raw_target, dict):
            _fail("invalid-manifest", f"target {index} must be an object")
        _ensure_allowed_keys(
            raw_target,
            {"target", "path", "name", "size", "sha256", "protected"},
            "manifest target",
        )
        target = _validate_target_key(raw_target.get("target"), f"targets[{index}].target")
        path_value = _validate_relative_path(raw_target.get("path"), f"targets[{index}].path")
        name_value = _validate_asset_name(raw_target.get("name"), f"targets[{index}].name")
        size_value = raw_target.get("size")
        if isinstance(size_value, bool) or not isinstance(size_value, int) or size_value < 0:
            _fail("invalid-manifest", f"targets[{index}].size must be a non-negative integer")
        sha_value = _validate_sha256(raw_target.get("sha256"), f"targets[{index}].sha256")
        protected_value = raw_target.get("protected")
        if not isinstance(protected_value, bool):
            _fail("invalid-manifest", f"targets[{index}].protected must be boolean")
        if target in seen_targets or path_value in seen_paths or name_value in seen_names:
            _fail("invalid-manifest", f"target {index} duplicates a target, path, or asset name")
        seen_targets.add(target)
        seen_paths.add(path_value)
        seen_names.add(name_value)
        if protected_value != (name_value in protected_assets):
            _fail("invalid-manifest", f"targets[{index}].protected disagrees with protected_assets")
        targets.append(
            {
                "target": target,
                "path": path_value,
                "name": name_value,
                "size": size_value,
                "sha256": sha_value,
                "protected": protected_value,
            }
        )
    unknown_protected = sorted(set(protected_assets) - seen_names)
    if unknown_protected:
        _fail("invalid-manifest", "protected_assets names no target", names=unknown_protected)
    return {
        "schema": SCHEMA,
        "project": project,
        "repository": repository,
        "release": {"version": version, "tag": tag, "commit": commit},
        "protected_assets": protected_assets,
        "targets": targets,
    }


def _url(value: Any, field: str, allow_query: bool = False) -> str:
    text = _is_safe_text(value, field)
    parsed = urlsplit(text)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        _fail("remote-error", f"{field} must be an HTTP(S) URL")
    if parsed.username or parsed.password:
        _fail("remote-error", f"{field} must not contain URL credentials")
    if parsed.fragment:
        _fail("remote-error", f"{field} must not contain a URL fragment")
    if parsed.query and not allow_query:
        _fail("remote-error", f"{field} must not contain a query string")
    try:
        parsed.port
    except ValueError:
        _fail("remote-error", f"{field} has an invalid port")
    return text


def _api_base(api_url: str, forge: str) -> str:
    base = _url(api_url, "api-url").rstrip("/")
    if forge == "gitea" and not base.endswith("/api/v1"):
        base += "/api/v1"
    return base


def _repo_parts(repository: str) -> tuple[str, str]:
    owner, name = repository.split("/", 1)
    return quote(owner, safe=""), quote(name, safe="")


def _release_url(api_base: str, forge: str, repository: str, tag: str) -> str:
    owner, name = _repo_parts(repository)
    return f"{api_base}/repos/{owner}/{name}/releases/tags/{quote(tag, safe='')}"


def _tag_ref_url(api_base: str, forge: str, repository: str, tag: str) -> str:
    owner, name = _repo_parts(repository)
    if forge == "gitea":
        return f"{api_base}/repos/{owner}/{name}/tags/{quote(tag, safe='')}"
    return f"{api_base}/repos/{owner}/{name}/git/ref/tags/{quote(tag, safe='')}"


def _tag_object_url(api_base: str, repository: str, sha: str) -> str:
    owner, name = _repo_parts(repository)
    return f"{api_base}/repos/{owner}/{name}/git/tags/{quote(sha, safe='')}"


def _releases_url(api_base: str, repository: str) -> str:
    owner, name = _repo_parts(repository)
    return f"{api_base}/repos/{owner}/{name}/releases"


def _release_id_url(api_base: str, repository: str, release_id: str) -> str:
    return f"{_releases_url(api_base, repository)}/{quote(release_id, safe='')}"


def _auth_token(forge: str, required: bool = True) -> tuple[str | None, str]:
    env_name = "GITEA_RELEASE_TOKEN" if forge == "gitea" else "GH_RELEASE_TOKEN"
    token = os.environ.get(env_name)
    if required and not token:
        _fail("auth-required", f"{env_name} is required for publishing")
    if token and any(ord(char) < 32 or ord(char) == 127 for char in token):
        _fail("auth-required", f"{env_name} contains a control character")
    return token, env_name


def _header_value(headers: Any, name: str) -> str | None:
    try:
        value = headers.get(name)
    except AttributeError:
        return None
    return value if isinstance(value, str) else None


class _MultipartFileBody:
    """File-like request body that streams one multipart attachment."""

    def __init__(self, prefix: bytes, path: Path, suffix: bytes) -> None:
        self._prefix = memoryview(prefix)
        self._path = path.open("rb")
        self._suffix = memoryview(suffix)
        self._phase = "prefix"

    def read(self, amount: int = -1) -> bytes:
        if amount == 0:
            return b""
        while True:
            if self._phase == "prefix":
                chunk = self._prefix[:amount if amount >= 0 else len(self._prefix)].tobytes()
                self._prefix = self._prefix[len(chunk) :]
                if chunk:
                    return chunk
                self._phase = "file"
            elif self._phase == "file":
                chunk = self._path.read(amount)
                if chunk:
                    return chunk
                self._path.close()
                self._phase = "suffix"
            elif self._phase == "suffix":
                chunk = self._suffix[:amount if amount >= 0 else len(self._suffix)].tobytes()
                self._suffix = self._suffix[len(chunk) :]
                if chunk:
                    return chunk
                self._phase = "done"
            else:
                return b""

    def close(self) -> None:
        if not self._path.closed:
            self._path.close()


def _http_request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: bytes | None = None,
    file_path: Path | None = None,
    content_type: str | None = None,
    stream: bool = False,
    accept: str = "application/json",
    multipart_field: str | None = None,
    multipart_filename: str | None = None,
) -> tuple[int, Any, bytes | None, http.client.HTTPResponse | None, http.client.HTTPConnection | None]:
    parsed = urlsplit(_url(url, "request URL", allow_query=True))
    if parsed.query and "name=" not in parsed.query and method.upper() in {"POST", "PUT", "PATCH"}:
        _fail("remote-error", "upload URL contains an unexpected query string")
    connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    try:
        connection = connection_class(parsed.hostname, parsed.port, timeout=HTTP_TIMEOUT)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        headers = {"Accept": accept, "User-Agent": "kanterlabs-release-tools/1"}
        if token:
            headers["Authorization"] = f"token {token}"
        request_body: Any = body
        if file_path is not None:
            size = file_path.stat().st_size
            if multipart_field is not None:
                boundary = "release-tools-" + uuid.uuid4().hex
                filename = (multipart_filename or file_path.name).replace("\\", "\\\\").replace('"', '\\"')
                prefix = (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{multipart_field}"; filename="{filename}"\r\n'
                    "Content-Type: application/octet-stream\r\n\r\n"
                ).encode("utf-8")
                suffix = f"\r\n--{boundary}--\r\n".encode("ascii")
                request_body = _MultipartFileBody(prefix, file_path, suffix)
                headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
                headers["Content-Length"] = str(len(prefix) + size + len(suffix))
            else:
                request_body = file_path.open("rb")
                headers["Content-Length"] = str(size)
                if content_type:
                    headers["Content-Type"] = content_type
        elif body is not None:
            headers["Content-Length"] = str(len(body))
            if content_type:
                headers["Content-Type"] = content_type
        elif content_type:
            headers["Content-Type"] = content_type
        try:
            connection.request(method.upper(), path, body=request_body, headers=headers)
        finally:
            if file_path is not None and hasattr(request_body, "close"):
                request_body.close()
        response = connection.getresponse()
        if stream:
            return response.status, response.headers, None, response, connection
        data = response.read(MAX_JSON_RESPONSE + 1)
        if len(data) > MAX_JSON_RESPONSE:
            _fail("remote-error", "remote response is too large")
        connection.close()
        return response.status, response.headers, data, None, None
    except ReleaseError:
        try:
            connection.close()
        except (NameError, OSError):
            pass
        raise
    except (OSError, socket.timeout, http.client.HTTPException) as exc:
        try:
            connection.close()
        except (NameError, OSError):
            pass
        _fail("network-error", "remote request failed", reason=type(exc).__name__)


def _decode_json_response(status: int, response_body: bytes | None) -> Any:
    if not response_body:
        _fail("remote-error", "remote API returned an empty response", status=status)
    try:
        return json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("remote-error", "remote API returned invalid JSON", status=status)


def _json_request_with_status(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, Any]:
    status, _headers, response_body, _response, _connection = _http_request(
        method,
        url,
        token=token,
        body=body,
        content_type=content_type,
    )
    if status < 200 or status >= 300:
        if status in {401, 403}:
            _fail("auth-required", "remote API rejected the request", status=status)
        _fail("remote-error", "remote API returned an error", status=status)
    return status, _decode_json_response(status, response_body)


def _json_request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: bytes | None = None,
    content_type: str | None = None,
) -> Any:
    _status, value = _json_request_with_status(
        method,
        url,
        token=token,
        body=body,
        content_type=content_type,
    )
    return value


def _get_release(url: str, token: str | None, *, allow_missing: bool = False) -> dict[str, Any] | None:
    status, _headers, body, _response, _connection = _http_request("GET", url, token=token)
    if status == 404:
        if allow_missing:
            return None
        _fail("release-not-found", "release tag was not found")
    if status in {401, 403}:
        _fail("auth-required", "remote API rejected release lookup", status=status)
    if status < 200 or status >= 300:
        _fail("remote-error", "remote API returned an error for release lookup", status=status)
    if not body:
        _fail("remote-error", "remote API returned an empty release")
    try:
        release = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("remote-error", "remote API returned invalid release JSON")
    if not isinstance(release, dict):
        _fail("remote-error", "remote API release is not an object")
    return release


def _tag_response_commit(value: Any, forge: str) -> tuple[str, str | None]:
    if not isinstance(value, dict):
        _fail("remote-error", "remote tag response is not an object")
    if forge == "gitea":
        commit = value.get("commit")
        if not isinstance(commit, dict):
            _fail("remote-error", "remote tag response has no commit object")
        sha = commit.get("sha", commit.get("id"))
        if not isinstance(sha, str) or not SHA1_RE.fullmatch(sha):
            _fail("remote-error", "remote tag response has an invalid commit SHA")
        return sha, None
    obj = value.get("object")
    if not isinstance(obj, dict):
        _fail("remote-error", "remote tag response has no object")
    sha = obj.get("sha")
    kind = obj.get("type")
    if not isinstance(sha, str) or not SHA1_RE.fullmatch(sha) or kind not in {"commit", "tag"}:
        _fail("remote-error", "remote tag response has an invalid object")
    return sha, kind


def _get_tag_commit(
    api_base: str,
    forge: str,
    repository: str,
    tag: str,
    token: str | None,
    *,
    allow_missing: bool,
) -> str | None:
    """Resolve a forge tag to its peeled commit SHA before release mutation."""

    status, _headers, body, _response, _connection = _http_request(
        "GET", _tag_ref_url(api_base, forge, repository, tag), token=token
    )
    if status == 404:
        if allow_missing:
            return None
        _fail("release-not-found", "release tag was not found")
    if status in {401, 403}:
        _fail("auth-required", "remote API rejected tag lookup", status=status)
    if status < 200 or status >= 300:
        _fail("remote-error", "remote API returned an error for tag lookup", status=status)
    value = _decode_json_response(status, body)
    sha, kind = _tag_response_commit(value, forge)
    if forge == "gitea" or kind == "commit":
        return sha

    # GitHub's lightweight ref can point to an annotated tag object. Peel tag
    # objects until the immutable commit is reached, with a bounded loop for a
    # malformed or cyclic response.
    current = sha
    for _attempt in range(4):
        status, _headers, body, _response, _connection = _http_request(
            "GET", _tag_object_url(api_base, repository, current), token=token
        )
        if status in {401, 403}:
            _fail("auth-required", "remote API rejected annotated tag lookup", status=status)
        if status < 200 or status >= 300:
            _fail("remote-error", "remote API returned an error for annotated tag lookup", status=status)
        value = _decode_json_response(status, body)
        current, kind = _tag_response_commit(value, "github")
        if kind == "commit":
            return current
    _fail("remote-error", "remote tag has too many nested annotated objects")


def _release_metadata(
    release: dict[str, Any],
    expected_tag: str,
    *,
    expected_commit: str | None = None,
) -> tuple[str, bool, list[dict[str, Any]], str | None]:
    tag = release.get("tag_name", release.get("tag"))
    if not isinstance(tag, str) or tag != expected_tag:
        _fail("remote-error", "remote release tag does not match manifest")
    if expected_commit is not None:
        target_commit = release.get("target_commitish")
        if not isinstance(target_commit, str) or target_commit != expected_commit:
            _fail(
                "remote-error",
                "remote release target commit does not match manifest",
                expected=expected_commit,
                observed=target_commit,
            )
    release_id = release.get("id")
    if isinstance(release_id, bool) or not isinstance(release_id, (str, int)) or not str(release_id):
        _fail("remote-error", "remote release has no usable id")
    draft = release.get("draft", False)
    if not isinstance(draft, bool):
        _fail("remote-error", "remote release draft field is invalid")
    assets = release.get("assets", [])
    if not isinstance(assets, list):
        _fail("remote-error", "remote release assets field is invalid")
    normalized_assets: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict):
            _fail("remote-error", "remote release contains a malformed asset")
        name = asset.get("name")
        if not isinstance(name, str) or not name or any(ord(char) < 32 or ord(char) == 127 for char in name):
            _fail("remote-error", "remote release contains an invalid asset name")
        if name in seen_names:
            _fail("remote-error", "remote release contains duplicate asset names", name=name)
        seen_names.add(name)
        normalized_assets.append(asset)
    upload_url = release.get("upload_url")
    if upload_url is not None and not isinstance(upload_url, str):
        _fail("remote-error", "remote release upload URL is invalid")
    return str(release_id), draft, normalized_assets, upload_url


def _create_release(
    api_base: str,
    forge: str,
    repository: str,
    tag: str,
    commit: str,
    token: str,
) -> tuple[dict[str, Any], bool]:
    # Both GitHub and Gitea accept this common release-create shape. Supplying
    # the exact commit prevents a tag name from resolving through a mutable
    # default branch when a release is created by an automated retry.
    body = json.dumps(
        {
            "tag_name": tag,
            "target_commitish": commit,
            "name": tag,
            "draft": True,
            "prerelease": False,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    status, _headers, response_body, _response, _connection = _http_request(
        "POST",
        _releases_url(api_base, repository),
        token=token,
        body=body,
        content_type="application/json",
    )
    if status == 409:
        # Another worker may have won the create race. Re-read the tag and let
        # the normal exact-tag/exact-commit validation decide whether it is
        # safe to continue.
        release = _get_release(_release_url(api_base, forge, repository, tag), token, allow_missing=True)
        if release is None:
            _fail("remote-error", "release creation conflicted but the release is unavailable")
        return release, False
    if status in {401, 403}:
        _fail("auth-required", "remote release creation was rejected", status=status)
    if status < 200 or status >= 300:
        _fail("remote-error", "remote release creation returned an error", status=status)
    value = _decode_json_response(status, response_body)
    if not isinstance(value, dict):
        _fail("remote-error", "remote release creation returned a non-object")
    return value, True


def _finalize_release(
    api_base: str,
    repository: str,
    release_id: str,
    token: str,
) -> dict[str, Any]:
    body = json.dumps({"draft": False}, separators=(",", ":")).encode("utf-8")
    status, _headers, response_body, _response, _connection = _http_request(
        "PATCH",
        _release_id_url(api_base, repository, release_id),
        token=token,
        body=body,
        content_type="application/json",
    )
    if status in {401, 403}:
        _fail("auth-required", "remote release finalization was rejected", status=status)
    if status == 404:
        _fail("release-not-found", "release disappeared before finalization")
    if status < 200 or status >= 300:
        _fail("remote-error", "remote release finalization returned an error", status=status)
    value = _decode_json_response(status, response_body)
    if not isinstance(value, dict):
        _fail("remote-error", "remote release finalization returned a non-object")
    return value


def _asset_metadata_hash(asset: dict[str, Any]) -> str | None:
    for key in ("sha256", "digest"):
        value = asset.get(key)
        if not isinstance(value, str):
            continue
        candidate = value[7:] if value.startswith("sha256:") else value
        if SHA256_RE.fullmatch(candidate):
            return candidate
    return None


def _asset_download_url(asset: dict[str, Any], draft: bool) -> str | None:
    # Gitea's Attachment shape can expose only browser_download_url. Draft
    # verification accepts it as a fallback, but _resolve_asset_url checks its
    # origin before _download_hash is given the draft token.
    fields = (
        ("url", "download_url", "browser_download_url")
        if draft
        else ("browser_download_url", "download_url")
    )
    for key in fields:
        value = asset.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _resolve_asset_url(value: str, base_url: str, *, public: bool) -> str:
    if value.startswith("/"):
        parsed = urlsplit(base_url)
        value = urlunsplit((parsed.scheme, parsed.netloc, value, "", ""))
    elif not urlsplit(value).scheme:
        value = urljoin(base_url.rstrip("/") + "/", value)
    value = _url(value, "asset download URL", allow_query=False)
    if _same_origin(value, base_url):
        return value
    if public:
        base_scheme, base_host, _base_port = _origin(base_url)
        value_scheme, value_host, _value_port = _origin(value)
        if (
            base_scheme == "https"
            and base_host == "api.github.com"
            and value_scheme == "https"
            and value_host == "github.com"
        ):
            return value
    _fail("remote-error", "asset download URL has an untrusted origin")


def _resolve_redirect(value: str, base_url: str) -> str:
    location = urljoin(base_url, value)
    parsed = urlsplit(location)
    if any(key.lower() in {"token", "access_token", "authorization", "password", "secret"} for key in parse_qsl_keys(parsed.query)):
        _fail("remote-error", "remote asset redirect contains credential-like query data")
    return _url(location, "asset redirect URL", allow_query=True)


def parse_qsl_keys(query: str) -> list[str]:
    # Keep URL parsing dependency-free while avoiding logging or carrying
    # credential-looking query values across a public-download redirect.
    if not query:
        return []
    return [key for key, _value in parse_qsl(query, keep_blank_values=True)]


def _download_hash(url: str, expected_size: int | None, token: str | None) -> tuple[int, str]:
    current_url = url
    current_token = token
    response: http.client.HTTPResponse | None = None
    connection: http.client.HTTPConnection | None = None
    for _attempt in range(4):
        status, headers, _body, response, connection = _http_request(
            "GET", current_url, token=current_token, stream=True, accept="application/octet-stream"
        )
        if status not in {301, 302, 303, 307, 308}:
            break
        location = _header_value(headers, "Location")
        try:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
        except OSError:
            pass
        if not location:
            _fail("remote-error", "remote asset redirect has no location")
        current_url = _resolve_redirect(location, current_url)
        # A public CDN redirect must never receive the API token. This also
        # keeps draft API redirects safe when a forge sends them to a CDN.
        current_token = None
    else:
        _fail("remote-error", "remote asset download redirected too many times")
    if status < 200 or status >= 300 or response is None or connection is None:
        try:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()
        except OSError:
            pass
        if status in {401, 403}:
            _fail("auth-required", "remote asset download was rejected", status=status)
        _fail("remote-error", "remote asset download returned an error", status=status)
    digest = hashlib.sha256()
    size = 0
    try:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    except (OSError, http.client.HTTPException) as exc:
        _fail("network-error", "remote asset download failed", reason=type(exc).__name__)
    finally:
        try:
            response.close()
            connection.close()
        except OSError:
            pass
    if expected_size is not None and size != expected_size:
        _fail("asset-conflict", "remote asset size does not match manifest", expected=expected_size, observed=size)
    return size, digest.hexdigest()


def _verify_remote_asset(
    asset: dict[str, Any],
    target: dict[str, Any],
    *,
    draft: bool,
    api_base: str,
    token: str | None,
    require_download: bool = False,
) -> dict[str, Any]:
    metadata_hash = _asset_metadata_hash(asset)
    if metadata_hash is not None and metadata_hash != target["sha256"]:
        _fail("asset-conflict", "same-name remote asset has a different SHA-256", name=target["name"])
    metadata_size = asset.get("size")
    if metadata_hash is not None:
        if isinstance(metadata_size, bool) or (metadata_size is not None and not isinstance(metadata_size, int)):
            _fail("asset-unverifiable", "same-name remote asset has an invalid size", name=target["name"])
        if metadata_size is not None and metadata_size != target["size"]:
            _fail(
                "asset-conflict",
                "remote asset size does not match manifest",
                name=target["name"],
                expected=target["size"],
                observed=metadata_size,
            )
        # GitHub exposes a SHA-256 digest on release assets. Gitea versions
        # that expose the same field are handled identically. A matching
        # digest is sufficient for publish idempotency even when the API does
        # not provide a downloadable URL for a draft asset.
        if not require_download:
            return {
                "name": target["name"],
                "action": "skip",
                "sha256": metadata_hash,
                "size": target["size"] if metadata_size is None else metadata_size,
                "verified": True,
                "verification": "digest",
                "public": not draft,
            }
    raw_url = _asset_download_url(asset, draft)
    if raw_url is None:
        _fail("asset-unverifiable", "same-name remote asset has no verifiable download URL", name=target["name"])
    download_url = _resolve_asset_url(raw_url, api_base, public=not draft)
    observed_size, observed_hash = _download_hash(download_url, target["size"], token if draft else None)
    if observed_hash != target["sha256"]:
        _fail("asset-conflict", "same-name remote asset has a different SHA-256", name=target["name"])
    return {
        "name": target["name"],
        "action": "skip",
        "sha256": observed_hash,
        "size": observed_size,
        "verified": True,
        "verification": "download",
        "public": not draft,
    }


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    try:
        port = parsed.port
    except ValueError:
        _fail("remote-error", "URL has an invalid port")
    if port is None:
        port = 443 if parsed.scheme == "https" else 80
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


def _same_origin(left: str, right: str) -> bool:
    return _origin(left) == _origin(right)


def _ensure_upload_origin(candidate: str, api_base: str, forge: str) -> str:
    if _same_origin(candidate, api_base):
        return candidate
    api_scheme, api_host, _api_port = _origin(api_base)
    candidate_scheme, candidate_host, _candidate_port = _origin(candidate)
    if (
        forge == "github"
        and api_scheme == "https"
        and api_host == "api.github.com"
        and candidate_scheme == "https"
        and candidate_host == "uploads.github.com"
    ):
        return candidate
    _fail("remote-error", "release upload URL has an untrusted origin")


def _upload_url(
    api_base: str,
    forge: str,
    repository: str,
    release_id: str,
    release_upload_url: str | None,
    name: str,
) -> str:
    if release_upload_url:
        if release_upload_url.startswith("/"):
            parsed = urlsplit(api_base)
            candidate = urlunsplit((parsed.scheme, parsed.netloc, release_upload_url, "", ""))
        else:
            candidate = urljoin(api_base.rstrip("/") + "/", release_upload_url)
        candidate = _url(candidate, "release upload URL", allow_query=True)
        candidate = re.sub(r"\{\?[^}]+\}", "", candidate)
        parsed = urlsplit(candidate)
        if any(
            key.lower() in {"token", "access_token", "authorization", "password", "secret"}
            for key in parse_qsl_keys(parsed.query)
        ):
            _fail("remote-error", "release upload URL contains credential-like query data")
        query = parsed.query
        query = f"{query}&" if query else ""
        candidate = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, f"{query}name={quote(name, safe='')}", ""))
        return _ensure_upload_origin(candidate, api_base, forge)
    owner, repo_name = _repo_parts(repository)
    upload_base = api_base
    if forge == "github" and _origin(api_base)[0:2] == ("https", "api.github.com"):
        upload_base = "https://uploads.github.com"
    candidate = f"{upload_base}/repos/{owner}/{repo_name}/releases/{quote(release_id, safe='')}/assets?name={quote(name, safe='')}"
    return _ensure_upload_origin(candidate, api_base, forge)


def _publish(manifest: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    normalized = _verify_manifest(manifest, Path(args.artifacts))
    repository = _validate_repository(args.repository, "repository")
    if normalized["repository"] != repository:
        _fail("invalid-manifest", "requested repository does not match manifest")
    manifest_hash = _manifest_hash(Path(args.manifest))
    if args.dry_run:
        result = {
            "ok": True,
            "command": "publish",
            "dry_run": True,
            "forge": args.forge,
            "repository": repository,
            "tag": normalized["release"]["tag"],
            "manifest": str(args.manifest),
            "artifacts": str(args.artifacts),
            "manifest_sha256": manifest_hash,
            "source_commit": normalized["release"]["commit"],
            "public": None,
            "assets": [
                {"name": target["name"], "sha256": target["sha256"], "size": target["size"], "action": "upload"}
                for target in normalized["targets"]
            ],
        }
        _write_receipt(getattr(args, "receipt_output", None), result)
        return result
    token, _env_name = _auth_token(args.forge, required=True)
    api_base = _api_base(args.api_url, args.forge)
    release = _get_release(_release_url(api_base, args.forge, repository, normalized["release"]["tag"]), token)
    release_id, draft, assets, release_upload_url = _release_metadata(release, normalized["release"]["tag"])
    asset_by_name = {asset["name"]: asset for asset in assets}
    receipts_by_name: dict[str, dict[str, Any]] = {}
    # Verify every existing asset before making any upload request. This keeps
    # a later protected-asset conflict from leaving an avoidable partial
    # release behind.
    for target in normalized["targets"]:
        existing = asset_by_name.get(target["name"])
        if existing is not None:
            receipts_by_name[target["name"]] = _verify_remote_asset(
                existing,
                target,
                draft=draft,
                api_base=api_base,
                token=token,
            )
    for target in normalized["targets"]:
        if target["name"] in receipts_by_name:
            continue
        upload_url = _upload_url(api_base, args.forge, repository, release_id, release_upload_url, target["name"])
        path = _safe_artifact_file(_ensure_artifact_root(Path(args.artifacts)), target["path"])
        status, _headers, _body, _response, _connection = _http_request(
            "POST",
            upload_url,
            token=token,
            file_path=path,
            content_type="application/octet-stream",
            multipart_field="attachment" if args.forge == "gitea" else None,
            multipart_filename=target["name"],
        )
        if status in {401, 403}:
            _fail("auth-required", "remote asset upload was rejected", status=status)
        if status < 200 or status >= 300:
            _fail("remote-error", "remote asset upload returned an error", status=status, name=target["name"])
        receipts_by_name[target["name"]] = {
            "name": target["name"],
            "action": "upload",
            "sha256": target["sha256"],
            "size": target["size"],
            "verified": False,
            "public": not draft,
        }
        # Keep a local map in case a fixture returns the newly uploaded asset
        # but the server only refreshes its release object on the next request.
        asset_by_name[target["name"]] = {"name": target["name"]}
    # Re-read and hash-check every asset after uploads. The upload response is
    # only an acknowledgement; the release representation is the durable
    # source used by a retry. Preserve each target's planned action while
    # replacing its unverified placeholder with verified remote evidence.
    release = _get_release(_release_url(api_base, args.forge, repository, normalized["release"]["tag"]), token)
    release_id_after, draft_after, assets_after, _upload_url_after = _release_metadata(
        release,
        normalized["release"]["tag"],
    )
    if release_id_after != release_id or draft_after != draft:
        _fail("remote-error", "remote release changed while publishing")
    asset_by_name_after = {asset["name"]: asset for asset in assets_after}
    verified_receipts: list[dict[str, Any]] = []
    for target in normalized["targets"]:
        existing = asset_by_name_after.get(target["name"])
        if existing is None:
            _fail("missing-target", "remote release is missing a manifest asset after upload", name=target["name"])
        prior = receipts_by_name[target["name"]]
        verified = _verify_remote_asset(
            existing,
            target,
            draft=draft_after,
            api_base=api_base,
            token=token,
        )
        verified["action"] = prior["action"]
        verified_receipts.append(verified)
    receipts = verified_receipts
    result = {
        "ok": True,
        "command": "publish",
        "dry_run": False,
        "forge": args.forge,
        "repository": repository,
        "tag": normalized["release"]["tag"],
        "manifest": str(args.manifest),
        "artifacts": str(args.artifacts),
        "manifest_sha256": manifest_hash,
        "source_commit": normalized["release"]["commit"],
        "release_id": release_id,
        "draft": draft_after,
        "public": not draft_after,
        "assets": receipts,
    }
    _write_receipt(getattr(args, "receipt_output", None), result)
    return result


def _ensure_release(manifest: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    """Create or reconcile a release, publishing only verified assets.

    A newly-created release is always draft. The draft is finalized only after
    every configured asset and the validated manifest sidecar have been
    downloaded and matched to their local hashes. Existing published releases
    are immutable from this command's perspective: they may be inspected and
    acknowledged when complete, but a missing asset is never added in place.
    """

    normalized = _verify_manifest(manifest, Path(args.artifacts))
    repository = _validate_repository(args.repository, "repository")
    if normalized["repository"] != repository:
        _fail("invalid-manifest", "requested repository does not match manifest")
    tag = normalized["release"]["tag"]
    commit = normalized["release"]["commit"]
    manifest_sidecar = _manifest_asset(Path(args.manifest))
    if any(target["name"] == MANIFEST_ASSET_NAME for target in normalized["targets"]):
        _fail("invalid-manifest", "manifest target name conflicts with the release manifest sidecar")
    all_targets = [*normalized["targets"], manifest_sidecar]
    manifest_hash = manifest_sidecar["sha256"]
    receipt_path = getattr(args, "receipt_output", None)
    common: dict[str, Any] = {
        "command": "ensure-release",
        "forge": args.forge,
        "repository": repository,
        "tag": tag,
        "manifest": str(args.manifest),
        "artifacts": str(args.artifacts),
        "manifest_sha256": manifest_hash,
        "source_commit": commit,
    }
    if args.dry_run:
        result = {
            **common,
            "ok": True,
            "dry_run": True,
            "create": True,
            "finalize": True,
            "public": None,
            "assets": [
                {
                    "name": target["name"],
                    "sha256": target["sha256"],
                    "size": target["size"],
                    "action": "upload",
                }
                for target in normalized["targets"]
            ],
            "manifest_asset": {
                "name": manifest_sidecar["name"],
                "sha256": manifest_sidecar["sha256"],
                "size": manifest_sidecar["size"],
                "action": "upload",
            },
        }
        _write_receipt(receipt_path, result)
        return result

    token, _env_name = _auth_token(args.forge, required=True)
    api_base = _api_base(args.api_url, args.forge)
    release_lookup_url = _release_url(api_base, args.forge, repository, tag)
    artifact_root = _ensure_artifact_root(Path(args.artifacts))
    state: dict[str, Any] = {**common, "ok": False, "status": "starting", "assets": []}
    receipts_by_name: dict[str, dict[str, Any]] = {}
    planned_actions: dict[str, str] = {}
    created = False
    finalized = False

    def persist_state() -> None:
        state["assets"] = [
            receipts_by_name[target["name"]]
            for target in normalized["targets"]
            if target["name"] in receipts_by_name
        ]
        if MANIFEST_ASSET_NAME in receipts_by_name:
            state["manifest_asset"] = receipts_by_name[MANIFEST_ASSET_NAME]
        else:
            state.pop("manifest_asset", None)
        _write_receipt(receipt_path, state)

    def verify_assets(
        asset_by_name: dict[str, dict[str, Any]],
        *,
        draft: bool,
        download_token: str | None,
        require_download: bool = False,
    ) -> None:
        for target in all_targets:
            existing = asset_by_name.get(target["name"])
            if existing is None:
                _fail(
                    "missing-target",
                    f"{'draft' if draft else 'published'} release is missing a manifest asset",
                    name=target["name"],
                )
            verified = _verify_remote_asset(
                existing,
                target,
                draft=draft,
                api_base=api_base,
                token=download_token,
                require_download=require_download,
            )
            verified["action"] = planned_actions.get(target["name"], "skip")
            receipts_by_name[target["name"]] = verified

    try:
        # Release metadata alone is insufficient provenance: a forge can return
        # a matching target_commitish while the named tag resolves elsewhere.
        tag_commit = _get_tag_commit(
            api_base,
            args.forge,
            repository,
            tag,
            token,
            allow_missing=True,
        )
        release = _get_release(release_lookup_url, token, allow_missing=True)
        if release is None:
            if tag_commit is not None and tag_commit != commit:
                _fail(
                    "remote-error",
                    "remote tag commit does not match manifest",
                    expected=commit,
                    observed=tag_commit,
                )
            release, created = _create_release(
                api_base,
                args.forge,
                repository,
                tag,
                commit,
                token,
            )
            # Creation may have materialized a previously absent tag. Resolve
            # it again before accepting the draft release as usable.
            tag_commit = _get_tag_commit(
                api_base,
                args.forge,
                repository,
                tag,
                token,
                allow_missing=False,
            )
        if tag_commit != commit:
            _fail(
                "remote-error",
                "remote tag commit does not match manifest",
                expected=commit,
                observed=tag_commit,
            )
        common["tag_commit"] = tag_commit
        state["tag_commit"] = tag_commit
        release_id, draft, assets, release_upload_url = _release_metadata(
            release,
            tag,
            expected_commit=commit,
        )
        state.update(
            {
                "release_id": release_id,
                "created": created,
                "draft": draft,
                "public": not draft,
                "status": "release-ready",
            }
        )
        persist_state()
        asset_by_name = {asset["name"]: asset for asset in assets}

        # Verify all existing names before the first upload. This makes a
        # protected-asset conflict a clean refusal instead of a partial update.
        for target in all_targets:
            existing = asset_by_name.get(target["name"])
            if existing is None:
                continue
            verified = _verify_remote_asset(
                existing,
                target,
                draft=draft,
                api_base=api_base,
                token=token,
                require_download=not draft,
            )
            planned_actions[target["name"]] = "skip"
            verified["action"] = "skip"
            receipts_by_name[target["name"]] = verified
        persist_state()

        if not draft:
            missing = [target["name"] for target in all_targets if target["name"] not in receipts_by_name]
            if missing:
                _fail(
                    "remote-error",
                    "published release is missing manifest assets and cannot be repaired",
                    names=missing,
                )
            result = {
                **common,
                "ok": True,
                "dry_run": False,
                "release_id": release_id,
                "created": created,
                "finalized": False,
                "draft": False,
                "public": True,
                "assets": [receipts_by_name[target["name"]] for target in normalized["targets"]],
                "manifest_asset": receipts_by_name[MANIFEST_ASSET_NAME],
            }
            _write_receipt(receipt_path, result)
            return result

        state["status"] = "uploading"
        persist_state()
        for target in all_targets:
            if target["name"] in receipts_by_name:
                continue
            upload_url = _upload_url(api_base, args.forge, repository, release_id, release_upload_url, target["name"])
            path = (
                Path(manifest_sidecar["path"])
                if target["name"] == MANIFEST_ASSET_NAME
                else _safe_artifact_file(artifact_root, target["path"])
            )
            status, _headers, _body, _response, _connection = _http_request(
                "POST",
                upload_url,
                token=token,
                file_path=path,
                content_type="application/octet-stream",
                multipart_field="attachment" if args.forge == "gitea" else None,
                multipart_filename=target["name"],
            )
            if status in {401, 403}:
                _fail("auth-required", "remote asset upload was rejected", status=status)
            if status < 200 or status >= 300:
                _fail("remote-error", "remote asset upload returned an error", status=status, name=target["name"])
            # The upload response is intentionally not trusted as proof of
            # content. A subsequent release read and download hash is the
            # durable verification boundary.
            planned_actions[target["name"]] = "upload"
            receipts_by_name[target["name"]] = {
                "name": target["name"],
                "action": "upload",
                "sha256": target["sha256"],
                "size": target["size"],
                "verified": False,
                "public": False,
            }
            persist_state()

        # Re-read after uploads so interrupted clients can retry by observing
        # the server's durable asset list. Verify draft downloads with the API
        # token before changing the release's visibility.
        release = _get_release(release_lookup_url, token)
        release_id, draft, assets, _release_upload_url = _release_metadata(
            release,
            tag,
            expected_commit=commit,
        )
        if not draft:
            # A concurrent worker may have finalized after our uploads. Treat
            # that as success only after public URL verification below.
            receipts_by_name = {}
            asset_by_name = {asset["name"]: asset for asset in assets}
            verify_assets(asset_by_name, draft=False, download_token=None, require_download=True)
            result = {
                **common,
                "ok": True,
                "dry_run": False,
                "release_id": release_id,
                "created": created,
                "finalized": False,
                "draft": False,
                "public": True,
                "assets": [receipts_by_name[target["name"]] for target in normalized["targets"]],
                "manifest_asset": receipts_by_name[MANIFEST_ASSET_NAME],
            }
            _write_receipt(receipt_path, result)
            return result

        asset_by_name = {asset["name"]: asset for asset in assets}
        receipts_by_name = {}
        verify_assets(asset_by_name, draft=True, download_token=token)
        state["status"] = "assets-verified"
        persist_state()

        _finalize_release(api_base, repository, release_id, token)
        finalized = True
        state["status"] = "finalizing"
        state["finalized"] = True
        persist_state()

        # Confirm the now-public release and hash every public download. This
        # is also the receipt proof that a successful finalization is complete.
        release = _get_release(release_lookup_url, token)
        release_id, draft, assets, _release_upload_url = _release_metadata(
            release,
            tag,
            expected_commit=commit,
        )
        if draft:
            _fail("remote-error", "remote release remained draft after finalization")
        receipts_by_name = {}
        asset_by_name = {asset["name"]: asset for asset in assets}
        verify_assets(asset_by_name, draft=False, download_token=None, require_download=True)
        result = {
            **common,
            "ok": True,
            "dry_run": False,
            "release_id": release_id,
            "created": created,
            "finalized": finalized,
            "draft": False,
            "public": True,
            "assets": [receipts_by_name[target["name"]] for target in normalized["targets"]],
            "manifest_asset": receipts_by_name[MANIFEST_ASSET_NAME],
        }
        _write_receipt(receipt_path, result)
        return result
    except ReleaseError as exc:
        # Keep the last known remote state durable across an interrupted CI
        # process. A receipt write failure must not hide the original remote
        # error; the next invocation still re-reads the release by tag.
        state["ok"] = False
        state["status"] = "incomplete"
        state["error"] = {"code": exc.code, "message": exc.message, **exc.details}
        try:
            persist_state()
        except ReleaseError:
            pass
        raise


def _inspect(manifest: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    normalized = _read_manifest_from_value(manifest)
    repository = _validate_repository(args.repository, "repository")
    if normalized["repository"] != repository:
        _fail("invalid-manifest", "requested repository does not match manifest")
    manifest_sidecar = _manifest_asset(Path(args.manifest))
    if any(target["name"] == MANIFEST_ASSET_NAME for target in normalized["targets"]):
        _fail("invalid-manifest", "manifest target name conflicts with the release manifest sidecar")
    manifest_hash = manifest_sidecar["sha256"]
    token, _env_name = _auth_token(args.forge, required=False)
    api_base = _api_base(args.api_url, args.forge)
    release = _get_release(_release_url(api_base, args.forge, repository, normalized["release"]["tag"]), token)
    release_id, draft, assets, _release_upload_url = _release_metadata(release, normalized["release"]["tag"])
    if draft:
        return {
            "ok": True,
            "command": "inspect",
            "forge": args.forge,
            "repository": repository,
            "tag": normalized["release"]["tag"],
            "manifest": str(args.manifest),
            "manifest_sha256": manifest_hash,
            "source_commit": normalized["release"]["commit"],
            "release_id": release_id,
            "draft": True,
            "public": False,
            "assets": [
                {"name": target["name"], "public": False, "verified": False}
                for target in normalized["targets"]
            ],
            "manifest_asset": {
                "name": manifest_sidecar["name"],
                "sha256": manifest_sidecar["sha256"],
                "size": manifest_sidecar["size"],
                "public": False,
                "verified": False,
            },
        }
    asset_by_name = {asset["name"]: asset for asset in assets}
    receipts: list[dict[str, Any]] = []
    for target in normalized["targets"]:
        existing = asset_by_name.get(target["name"])
        if existing is None:
            _fail("missing-target", "published release is missing a manifest asset", name=target["name"])
        receipts.append(
            _verify_remote_asset(
                existing,
                target,
                draft=False,
                api_base=api_base,
                token=None,
                require_download=True,
            )
        )
    manifest_remote = asset_by_name.get(MANIFEST_ASSET_NAME)
    if manifest_remote is None:
        _fail("missing-target", "published release is missing the release manifest sidecar")
    manifest_receipt = _verify_remote_asset(
        manifest_remote,
        manifest_sidecar,
        draft=False,
        api_base=api_base,
        token=None,
        require_download=True,
    )
    return {
        "ok": True,
        "command": "inspect",
        "forge": args.forge,
        "repository": repository,
        "tag": normalized["release"]["tag"],
        "manifest": str(args.manifest),
        "manifest_sha256": manifest_hash,
        "source_commit": normalized["release"]["commit"],
        "release_id": release_id,
        "draft": False,
        "public": True,
        "assets": receipts,
        "manifest_asset": manifest_receipt,
    }


def _git_revision(source: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(source.parent), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return "unavailable"
    revision = result.stdout.strip()
    return revision if SHA1_RE.fullmatch(revision) else "unavailable"


def _export(args: argparse.Namespace) -> dict[str, Any]:
    source = Path(__file__).resolve()
    output_dir = Path(args.output_dir)
    try:
        if output_dir.exists() and output_dir.is_symlink():
            _fail("export-error", "vendor output directory must not be a symlink")
        output_dir.mkdir(parents=True, exist_ok=True)
        destination = output_dir / "release-tools.py"
        lock_path = output_dir / "release-tools.lock"
        if destination.is_symlink() or lock_path.is_symlink():
            _fail("export-error", "vendor output files must not be symlinks")
        if destination.resolve() == source:
            _fail("export-error", "vendor output must be different from source")
        source_bytes = source.read_bytes()
        source_hash = hashlib.sha256(source_bytes).hexdigest()
        with tempfile.NamedTemporaryFile("wb", dir=str(output_dir), prefix=".release-tools.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(source_bytes)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        destination.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        lock = {
            "schema": 1,
            "source_file": "release_tools.py",
            "source_revision": _git_revision(source),
            "sha256": source_hash,
            "bytes": len(source_bytes),
        }
        _atomic_write_json(lock_path, lock, code="export-error")
    except ReleaseError:
        raise
    except OSError:
        try:
            if "temporary" in locals():
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        _fail("export-error", "could not write vendor snapshot")
    return {"ok": True, "command": "export", "output_dir": str(output_dir), "sha256": source_hash, "source_revision": lock["source_revision"]}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        _fail("invalid-arguments", message)


def _parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(prog="release_tools.py", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=JsonArgumentParser)
    manifest = commands.add_parser("manifest", help="generate a release manifest")
    manifest.add_argument("--config", required=True)
    manifest.add_argument("--artifacts", required=True)
    manifest.add_argument("--version", required=True)
    manifest.add_argument("--commit", required=True)
    manifest.add_argument("--output", required=True)

    verify = commands.add_parser("verify", help="verify local artifact files")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--artifacts", required=True)

    publish = commands.add_parser("publish", help="publish release assets")
    publish.add_argument("--forge", choices=("gitea", "github"), required=True)
    publish.add_argument("--repository", required=True)
    publish.add_argument("--api-url", required=True)
    publish.add_argument("--manifest", required=True)
    publish.add_argument("--artifacts", required=True)
    publish.add_argument("--dry-run", action="store_true")
    publish.add_argument("--create", action="store_true", help="create a missing release as a draft")
    publish.add_argument("--receipt-output", "--receipt", dest="receipt_output")

    ensure = commands.add_parser("ensure-release", help="create or reconcile a verified release")
    ensure.add_argument("--forge", choices=("gitea", "github"), required=True)
    ensure.add_argument("--repository", required=True)
    ensure.add_argument("--api-url", required=True)
    ensure.add_argument("--manifest", required=True)
    ensure.add_argument("--artifacts", required=True)
    ensure.add_argument("--dry-run", action="store_true")
    ensure.add_argument("--receipt-output", "--receipt", dest="receipt_output")

    inspect = commands.add_parser("inspect", help="verify public release downloads")
    inspect.add_argument("--forge", choices=("gitea", "github"), required=True)
    inspect.add_argument("--repository", required=True)
    inspect.add_argument("--api-url", required=True)
    inspect.add_argument("--manifest", required=True)

    export = commands.add_parser("export", help="write a vendored source snapshot")
    export.add_argument("--output-dir", required=True)
    return parser


def _run(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "manifest":
        config = _read_config(Path(args.config))
        manifest = _manifest_from_config(config, Path(args.artifacts), args.version, args.commit)
        _atomic_write_json(Path(args.output), manifest)
        return {
            "ok": True,
            "command": "manifest",
            "output": str(args.output),
            "repository": manifest["repository"],
            "tag": manifest["release"]["tag"],
            "commit": manifest["release"]["commit"],
            "targets": len(manifest["targets"]),
        }
    if args.command == "verify":
        manifest = _read_manifest(Path(args.manifest))
        normalized = _verify_manifest(manifest, Path(args.artifacts))
        return {
            "ok": True,
            "command": "verify",
            "manifest": str(args.manifest),
            "manifest_sha256": _manifest_hash(Path(args.manifest)),
            "repository": normalized["repository"],
            "tag": normalized["release"]["tag"],
            "commit": normalized["release"]["commit"],
            "targets": len(normalized["targets"]),
        }
    if args.command == "publish":
        manifest = _read_manifest(Path(args.manifest))
        if args.create:
            return _ensure_release(manifest, args)
        return _publish(manifest, args)
    if args.command == "ensure-release":
        manifest = _read_manifest(Path(args.manifest))
        return _ensure_release(manifest, args)
    if args.command == "inspect":
        manifest = _read_manifest(Path(args.manifest))
        return _inspect(manifest, args)
    if args.command == "export":
        return _export(args)
    _fail("invalid-arguments", "unknown command")


def main(argv: Iterable[str] | None = None) -> int:
    try:
        args = _parser().parse_args(list(argv) if argv is not None else None)
        result = _run(args)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except ReleaseError as exc:
        payload: dict[str, Any] = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        payload["error"].update(exc.details)
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")), file=sys.stderr)
        return EXIT_CODES.get(exc.code, 9)
    except (BrokenPipeError, KeyboardInterrupt):
        return 1
    except Exception:
        # Do not leak stack traces, environment values, or response bodies from
        # an unexpected dependency/runtime failure.
        print(
            json.dumps(
                {"ok": False, "error": {"code": "internal-error", "message": "unexpected internal failure"}},
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return EXIT_CODES["internal-error"]


if __name__ == "__main__":
    raise SystemExit(main())
