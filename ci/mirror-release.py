#!/usr/bin/env python3
"""Relay a verified canonical Gitea release to its public GitHub mirror."""

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
from urllib.parse import quote, urlsplit


CANONICAL_API = "https://gitea.home.shanekanterman.dev/api/v1"
PUBLIC_API = "https://api.github.com"
CANONICAL_ORIGIN = "https://gitea.home.shanekanterman.dev"
PUBLIC_ORIGIN = "https://api.github.com"
OWNER = "KanterLabs"
REPOSITORIES = ("nfl-scores", "ActionView", "helm")
MANIFEST_ASSET = "release-manifest.json"
SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_ASSET_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_ASSET_BYTES = 4 * MAX_ASSET_BYTES
HTTP_TIMEOUT = 30
PUBLISH_TIMEOUT = 300


class MirrorError(Exception):
    """An expected relay refusal safe to report to CI."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


EXIT_CODES = {
    "invalid-arguments": 2,
    "canonical-release-not-found": 3,
    "canonical-release-draft": 3,
    "canonical-release-tag": 3,
    "canonical-release-invalid": 3,
    "canonical-asset-missing": 3,
    "canonical-asset-invalid": 3,
    "manifest-invalid": 4,
    "manifest-identity": 4,
    "artifact-integrity": 4,
    "unsafe-path": 4,
    "public-commit-not-found": 5,
    "public-commit-invalid": 5,
    "auth-required": 6,
    "publisher-verify": 7,
    "publisher-ensure": 7,
    "publisher-receipt": 7,
    "network-error": 8,
    "internal-error": 9,
}


def _fail(code: str, message: str, **details: Any) -> None:
    raise MirrorError(code, message, **details)


def _safe_text(value: Any, field: str, *, code: str = "manifest-invalid") -> str:
    if not isinstance(value, str) or not value:
        _fail(code, f"{field} must be a non-empty string", field=field)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        _fail(code, f"{field} contains a control character", field=field)
    return value


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON field: {key}")
        value[key] = item
    return value


def _decode_json(data: bytes, *, field: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        _fail("manifest-invalid" if field == "manifest" else "canonical-release-invalid", f"{field} is not strict JSON")


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        _fail("network-error", "URL must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        _fail("network-error", "URL contains credentials or a query/fragment")
    try:
        port = parsed.port
    except ValueError:
        _fail("network-error", "URL has an invalid port")
    return parsed.scheme, parsed.hostname.lower(), port


def _validate_url(url: Any, *, expected: tuple[str, str, int | None], field: str) -> str:
    text = _safe_text(url, field, code="canonical-asset-invalid")
    actual = _origin(text)
    if actual != expected:
        _fail("canonical-asset-invalid", f"{field} has an untrusted origin", field=field)
    parsed = urlsplit(text)
    if not parsed.path:
        _fail("canonical-asset-invalid", f"{field} has no download path", field=field)
    return text


def _http_get(url: str, *, expected_origin: tuple[str, str, int | None], max_bytes: int) -> bytes:
    _validate_url(url, expected=expected_origin, field="download URL")
    parsed = urlsplit(url)
    connection: http.client.HTTPConnection | None = None
    try:
        connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(parsed.hostname, parsed.port, timeout=HTTP_TIMEOUT)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        connection.request("GET", path, headers={"Accept": "application/octet-stream", "User-Agent": "kanterlabs-release-mirror/1"})
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            _fail("network-error", "download returned an unexpected status", status=response.status)
        length_header = response.getheader("Content-Length")
        if length_header is not None:
            try:
                length = int(length_header)
            except ValueError:
                _fail("network-error", "download returned an invalid content length")
            if length < 0 or length > max_bytes:
                _fail("network-error", "download exceeded the response size limit", limit=max_bytes)
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            _fail("network-error", "download exceeded the response size limit", limit=max_bytes)
        return data
    except MirrorError:
        raise
    except (OSError, socket.timeout, http.client.HTTPException) as exc:
        _fail("network-error", "remote request failed", reason=type(exc).__name__)
    finally:
        if connection is not None:
            connection.close()


def _http_json(url: str, *, expected_origin: tuple[str, str, int | None], field: str) -> Any:
    try:
        data = _http_get(url, expected_origin=expected_origin, max_bytes=MAX_JSON_BYTES)
    except MirrorError as exc:
        if exc.code == "network-error" and exc.details.get("status") == 404:
            if field == "canonical release":
                _fail("canonical-release-not-found", "canonical release tag was not found")
            if field == "public commit":
                _fail("public-commit-not-found", "public repository does not contain the canonical commit")
        raise
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        _fail("canonical-release-invalid", f"{field} returned invalid JSON")


def _stream_download(
    url: str,
    destination: Path,
    *,
    expected_origin: tuple[str, str, int | None],
    expected_size: int,
    expected_sha256: str | None,
    field: str,
) -> tuple[int, str]:
    if expected_size < 0 or expected_size > MAX_ASSET_BYTES:
        _fail("artifact-integrity", f"{field} exceeds the asset size limit", size=expected_size)
    _validate_url(url, expected=expected_origin, field=f"{field} download URL")
    parsed = urlsplit(url)
    connection: http.client.HTTPConnection | None = None
    temporary = destination.with_name(f".{destination.name}.mirror-part")
    if temporary.exists() or temporary.is_symlink():
        _fail("unsafe-path", f"{field} temporary path already exists")
    try:
        connection_class = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(parsed.hostname, parsed.port, timeout=HTTP_TIMEOUT)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        connection.request("GET", path, headers={"Accept": "application/octet-stream", "User-Agent": "kanterlabs-release-mirror/1"})
        response = connection.getresponse()
        if response.status < 200 or response.status >= 300:
            _fail("network-error", f"{field} download returned an unexpected status", status=response.status)
        length_header = response.getheader("Content-Length")
        if length_header is not None:
            try:
                declared_length = int(length_header)
            except ValueError:
                _fail("network-error", f"{field} download returned an invalid content length")
            if declared_length != expected_size:
                _fail("artifact-integrity", f"{field} content length disagrees with the manifest", expected=expected_size, observed=declared_length)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with temporary.open("xb") as handle:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_size or size > MAX_ASSET_BYTES:
                    _fail("artifact-integrity", f"{field} exceeded its manifest size", expected=expected_size, observed=size)
                handle.write(chunk)
                digest.update(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        observed = digest.hexdigest()
        if size != expected_size:
            _fail("artifact-integrity", f"{field} size does not match the manifest", expected=expected_size, observed=size)
        if expected_sha256 is not None and observed != expected_sha256:
            _fail("artifact-integrity", f"{field} SHA-256 does not match the manifest", expected=expected_sha256, observed=observed)
        os.replace(temporary, destination)
        return size, observed
    except MirrorError:
        raise
    except (OSError, socket.timeout, http.client.HTTPException) as exc:
        _fail("network-error", f"{field} download failed", reason=type(exc).__name__)
    finally:
        if connection is not None:
            connection.close()
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _normalize_repository(value: Any) -> str:
    text = _safe_text(value, "repository", code="invalid-arguments")
    if text.startswith(OWNER + "/"):
        text = text[len(OWNER) + 1 :]
    if text not in REPOSITORIES:
        _fail("invalid-arguments", "repository is not in the mirror allowlist")
    return f"{OWNER}/{text}"


def _validate_version(value: Any) -> str:
    text = _safe_text(value, "version", code="invalid-arguments")
    if not SEMVER_RE.fullmatch(text):
        _fail("invalid-arguments", "version must be strict semantic-version text")
    return text


def _validate_asset_name(value: Any, field: str, *, code: str = "manifest-invalid") -> str:
    text = _safe_text(value, field, code=code)
    if text in {".", ".."} or "/" in text or "\\" in text:
        _fail(code, f"{field} must be a flat asset name", field=field)
    return text


def _validate_relative_path(value: Any, field: str) -> str:
    text = _safe_text(value, field)
    if "\\" in text or text.startswith("/") or text.endswith("/"):
        _fail("unsafe-path", f"{field} must be a relative POSIX path", field=field)
    path = PurePosixPath(text)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        _fail("unsafe-path", f"{field} escapes the artifact directory", field=field)
    return "/".join(path.parts)


def _manifest_value(data: bytes, *, repository: str, version: str, tag: str) -> dict[str, Any]:
    value = _decode_json(data, field="manifest")
    if not isinstance(value, dict):
        _fail("manifest-invalid", "manifest root must be an object")
    allowed = {"schema", "project", "repository", "release", "protected_assets", "targets"}
    unknown = sorted(set(value) - allowed)
    if unknown:
        _fail("manifest-invalid", "manifest contains unknown fields", fields=unknown)
    if value.get("schema") != 1:
        _fail("manifest-invalid", "manifest schema must be 1")
    project = _safe_text(value.get("project"), "project")
    if "/" in project or "\\" in project:
        _fail("manifest-invalid", "project contains a path separator")
    if value.get("repository") != repository:
        _fail("manifest-identity", "manifest repository does not match the requested mirror", expected=repository)
    release = value.get("release")
    if not isinstance(release, dict):
        _fail("manifest-invalid", "manifest release must be an object")
    release_unknown = sorted(set(release) - {"version", "tag", "commit"})
    if release_unknown:
        _fail("manifest-invalid", "manifest release contains unknown fields", fields=release_unknown)
    if release.get("version") != version or release.get("tag") != tag:
        _fail("manifest-identity", "manifest version or tag does not match the requested mirror", expected_tag=tag)
    commit = release.get("commit")
    if not isinstance(commit, str) or not SHA1_RE.fullmatch(commit):
        _fail("manifest-invalid", "manifest commit must be a lower-case 40-character SHA")
    protected_raw = value.get("protected_assets", [])
    if not isinstance(protected_raw, list) or any(not isinstance(item, str) for item in protected_raw):
        _fail("manifest-invalid", "protected_assets must be a list of strings")
    protected = [_validate_asset_name(item, "protected_assets item") for item in protected_raw]
    if len(set(protected)) != len(protected):
        _fail("manifest-invalid", "protected_assets contains duplicate names")
    targets_raw = value.get("targets")
    if not isinstance(targets_raw, list) or not targets_raw:
        _fail("manifest-invalid", "targets must be a non-empty list")
    targets: list[dict[str, Any]] = []
    seen_target: set[str] = set()
    seen_path: set[str] = set()
    seen_name: set[str] = set()
    for index, raw in enumerate(targets_raw):
        if not isinstance(raw, dict):
            _fail("manifest-invalid", f"target {index} must be an object")
        unknown_target = sorted(set(raw) - {"target", "path", "name", "size", "sha256", "protected"})
        if unknown_target:
            _fail("manifest-invalid", f"target {index} contains unknown fields", fields=unknown_target)
        target = _safe_text(raw.get("target"), f"targets[{index}].target")
        path = _validate_relative_path(raw.get("path"), f"targets[{index}].path")
        name = _validate_asset_name(raw.get("name"), f"targets[{index}].name")
        size = raw.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > MAX_ASSET_BYTES:
            _fail("manifest-invalid", f"targets[{index}].size is outside the allowed range")
        sha256 = raw.get("sha256")
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            _fail("manifest-invalid", f"targets[{index}].sha256 is invalid")
        protected_flag = raw.get("protected")
        if not isinstance(protected_flag, bool) or protected_flag != (name in protected):
            _fail("manifest-invalid", f"targets[{index}].protected disagrees with protected_assets")
        if target in seen_target or path in seen_path or name in seen_name:
            _fail("manifest-invalid", f"target {index} duplicates a target, path, or name")
        seen_target.add(target)
        seen_path.add(path)
        seen_name.add(name)
        targets.append({"target": target, "path": path, "name": name, "size": size, "sha256": sha256, "protected": protected_flag})
    if set(protected) - seen_name:
        _fail("manifest-invalid", "protected_assets names no target")
    return {
        "schema": 1,
        "project": project,
        "repository": repository,
        "release": {"version": version, "tag": tag, "commit": commit},
        "protected_assets": protected,
        "targets": targets,
    }


def _release_assets(release: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_assets = release.get("assets")
    if not isinstance(raw_assets, list):
        _fail("canonical-release-invalid", "canonical release assets must be a list")
    assets: dict[str, dict[str, Any]] = {}
    for asset in raw_assets:
        if not isinstance(asset, dict):
            _fail("canonical-asset-invalid", "canonical release contains a malformed asset")
        name = _validate_asset_name(asset.get("name"), "canonical asset name", code="canonical-asset-invalid")
        if name in assets:
            _fail("canonical-asset-invalid", "canonical release contains duplicate asset names", name=name)
        size = asset.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > MAX_ASSET_BYTES:
            _fail("canonical-asset-invalid", "canonical asset size is invalid", name=name)
        browser = asset.get("browser_download_url")
        if browser is not None and not isinstance(browser, str):
            _fail("canonical-asset-invalid", "canonical asset download URL is invalid", name=name)
        assets[name] = {"name": name, "size": size, "browser_download_url": browser}
    return assets


def _safe_artifact_path(root: Path, relative: str, *, field: str) -> Path:
    path = PurePosixPath(relative)
    destination = root.joinpath(*path.parts)
    try:
        root_resolved = root.resolve()
        destination_resolved = destination.resolve(strict=False)
    except OSError:
        _fail("unsafe-path", f"{field} cannot be resolved")
    if not destination_resolved.is_relative_to(root_resolved):
        _fail("unsafe-path", f"{field} escapes the artifact root")
    current = root
    for component in path.parts[:-1]:
        current = current / component
        if current.is_symlink():
            _fail("unsafe-path", f"{field} traverses a symlink")
    if destination.exists() or destination.is_symlink():
        _fail("unsafe-path", f"{field} collides with an existing file")
    return destination


def _tool_path() -> Path:
    here = Path(__file__).resolve().parent
    candidates = (
        here / "release-tools.py",
        here / "release_tools.py",
        here.parent / "release-tools" / "release_tools.py",
        here.parent / "release-tools" / "release-tools.py",
    )
    for candidate in candidates:
        if candidate.is_file() and not candidate.is_symlink():
            return candidate
    _fail("publisher-verify", "vendored release-tools.py was not found")


def _tool_environment(*, publishing: bool) -> dict[str, str]:
    environment = dict(os.environ)
    # The relay never sends or exposes a canonical Gitea publishing token.
    environment.pop("GITEA_RELEASE_TOKEN", None)
    if not publishing:
        environment.pop("GH_RELEASE_TOKEN", None)
    return environment


def _parse_tool_json(raw: str) -> dict[str, Any] | None:
    if not raw.strip():
        return None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _run_tool(command: str, args: list[str], *, cwd: Path) -> dict[str, Any]:
    tool = _tool_path()
    try:
        process = subprocess.run(
            [sys.executable, str(tool), command, *args],
            cwd=str(cwd),
            env=_tool_environment(publishing=command == "ensure-release"),
            capture_output=True,
            text=True,
            check=False,
            timeout=PUBLISH_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        _fail("publisher-verify" if command == "verify" else "publisher-ensure", "release-tools invocation failed", reason=type(exc).__name__)
    if process.returncode != 0:
        payload = _parse_tool_json(process.stderr)
        nested = payload.get("error") if payload else None
        code = nested.get("code") if isinstance(nested, dict) else None
        if command == "ensure-release" and code == "auth-required":
            _fail("auth-required", "GitHub publisher token is required")
        _fail("publisher-verify" if command == "verify" else "publisher-ensure", "release-tools command failed", tool_error=code or "unknown")
    payload = _parse_tool_json(process.stdout)
    if not payload or payload.get("ok") is not True:
        _fail("publisher-verify" if command == "verify" else "publisher-ensure", "release-tools returned an invalid receipt")
    return payload


def _validate_publisher_receipt(
    receipt: dict[str, Any],
    *,
    repository: str,
    tag: str,
    commit: str,
    manifest_sha256: str,
    manifest_size: int,
    targets: list[dict[str, Any]],
) -> dict[str, Any]:
    if receipt.get("repository") != repository or receipt.get("tag") != tag or receipt.get("source_commit") != commit:
        _fail("publisher-receipt", "publisher receipt release identity does not match the canonical manifest")
    if receipt.get("public") is not True or receipt.get("draft") is not False:
        _fail("publisher-receipt", "publisher receipt does not prove a public release")
    if receipt.get("manifest_sha256") != manifest_sha256:
        _fail("publisher-receipt", "publisher receipt manifest hash does not match the canonical sidecar")
    raw_assets = receipt.get("assets")
    if not isinstance(raw_assets, list):
        _fail("publisher-receipt", "publisher receipt assets are malformed")
    assets: dict[str, dict[str, Any]] = {}
    for item in raw_assets:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            _fail("publisher-receipt", "publisher receipt contains a malformed asset")
        name = item["name"]
        if name in assets:
            _fail("publisher-receipt", "publisher receipt contains duplicate assets", name=name)
        assets[name] = item
    target_receipts: list[dict[str, Any]] = []
    for target in targets:
        item = assets.get(target["name"])
        if (
            item is None
            or item.get("size") != target["size"]
            or item.get("sha256") != target["sha256"]
            or item.get("verified") is not True
        ):
            _fail("publisher-receipt", "published asset proof differs from the canonical manifest", name=target["name"])
        target_receipts.append(
            {
                "name": target["name"],
                "size": target["size"],
                "sha256": target["sha256"],
                "action": item.get("action"),
            }
        )
    manifest_asset = receipt.get("manifest_asset")
    if not isinstance(manifest_asset, dict):
        manifest_asset = assets.get(MANIFEST_ASSET)
    if not isinstance(manifest_asset, dict) or manifest_asset.get("name") != MANIFEST_ASSET:
        _fail("publisher-receipt", "publisher receipt has no manifest sidecar proof")
    if (
        manifest_asset.get("size") != manifest_size
        or manifest_asset.get("sha256") != manifest_sha256
        or manifest_asset.get("verified") is not True
    ):
        _fail("publisher-receipt", "published manifest sidecar proof differs from the canonical sidecar")
    return {
        "public": True,
        "repository": repository,
        "tag": tag,
        "source_commit": commit,
        "manifest_sha256": manifest_sha256,
        "assets": target_receipts,
        "manifest_asset": {
            "name": MANIFEST_ASSET,
            "size": manifest_size,
            "sha256": manifest_sha256,
            "action": manifest_asset.get("action"),
        },
    }


def _configuration(args: argparse.Namespace, repository: str) -> tuple[str, str, tuple[str, str, int | None], tuple[str, str, int | None]]:
    if args.fixture_api is None:
        return CANONICAL_API, PUBLIC_API, _origin(CANONICAL_ORIGIN), _origin(PUBLIC_ORIGIN)
    fixture = _safe_text(args.fixture_api, "fixture-api", code="invalid-arguments").rstrip("/")
    scheme, host, port = _origin(fixture)
    if host not in {"127.0.0.1", "localhost", "::1"}:
        _fail("invalid-arguments", "fixture-api is restricted to loopback hosts")
    parsed = urlsplit(fixture)
    if parsed.path.rstrip("/").endswith("/api/v1"):
        gitea_api = fixture
        public_api = fixture[: -len("/api/v1")]
        browser_origin = public_api
    else:
        gitea_api = fixture + "/api/v1"
        public_api = fixture
        browser_origin = fixture
    return gitea_api, public_api, _origin(browser_origin), _origin(public_api)


def mirror(args: argparse.Namespace) -> dict[str, Any]:
    repository = _normalize_repository(args.repository)
    version = _validate_version(args.version)
    tag = f"v{version}"
    gitea_api, github_api, canonical_origin, github_origin = _configuration(args, repository)
    owner, name = repository.split("/", 1)
    encoded_owner = quote(owner, safe="")
    encoded_name = quote(name, safe="")
    release_url = f"{gitea_api}/repos/{encoded_owner}/{encoded_name}/releases/tags/{quote(tag, safe='')}"
    release = _http_json(release_url, expected_origin=_origin(gitea_api), field="canonical release")
    if not isinstance(release, dict):
        _fail("canonical-release-invalid", "canonical release is not an object")
    if release.get("tag_name") != tag:
        _fail("canonical-release-tag", "canonical release tag does not match the requested version", expected=tag)
    if release.get("draft") is not False:
        _fail("canonical-release-draft", "canonical release must be non-draft")
    assets = _release_assets(release)
    sidecar = assets.get(MANIFEST_ASSET)
    if sidecar is None:
        _fail("canonical-asset-missing", "canonical release has no release-manifest.json sidecar")
    sidecar_url = sidecar.get("browser_download_url")
    if not isinstance(sidecar_url, str):
        _fail("canonical-asset-invalid", "canonical manifest sidecar has no browser download URL")
    sidecar_bytes = _http_get(sidecar_url, expected_origin=canonical_origin, max_bytes=MAX_JSON_BYTES)
    if len(sidecar_bytes) != sidecar["size"]:
        _fail("artifact-integrity", "canonical manifest sidecar size does not match release metadata")
    manifest = _manifest_value(sidecar_bytes, repository=repository, version=version, tag=tag)
    canonical_commit = release.get("target_commitish")
    if isinstance(canonical_commit, str) and SHA1_RE.fullmatch(canonical_commit):
        if canonical_commit != manifest["release"]["commit"]:
            _fail("canonical-release-invalid", "canonical release target commit differs from its manifest")
    manifest_sha256 = hashlib.sha256(sidecar_bytes).hexdigest()
    total_size = 0
    with tempfile.TemporaryDirectory(prefix="kanterlabs-mirror-") as temporary:
        workspace = Path(temporary)
        artifact_root = workspace / "artifacts"
        artifact_root.mkdir()
        downloaded: list[dict[str, Any]] = []
        for target in manifest["targets"]:
            remote = assets.get(target["name"])
            if remote is None:
                _fail("canonical-asset-missing", "canonical release is missing a manifest target", name=target["name"])
            if remote["size"] != target["size"]:
                _fail("artifact-integrity", "canonical asset size differs from the manifest", name=target["name"])
            url = remote.get("browser_download_url")
            if not isinstance(url, str):
                _fail("canonical-asset-invalid", "canonical target has no browser download URL", name=target["name"])
            total_size += target["size"]
            if total_size > MAX_TOTAL_ASSET_BYTES:
                _fail("artifact-integrity", "canonical release exceeds the total asset size limit")
            destination = _safe_artifact_path(artifact_root, target["path"], field=f"target {target['name']}")
            size, digest = _stream_download(
                url,
                destination,
                expected_origin=canonical_origin,
                expected_size=target["size"],
                expected_sha256=target["sha256"],
                field=target["name"],
            )
            downloaded.append({"name": target["name"], "size": size, "sha256": digest})

        commit_url = f"{github_api}/repos/{encoded_owner}/{encoded_name}/commits/{manifest['release']['commit']}"
        commit_response = _http_json(commit_url, expected_origin=github_origin, field="public commit")
        if not isinstance(commit_response, dict) or commit_response.get("sha") != manifest["release"]["commit"]:
            _fail("public-commit-invalid", "public repository does not resolve the exact canonical commit")

        manifest_path = workspace / MANIFEST_ASSET
        manifest_path.write_bytes(sidecar_bytes)
        receipt_path = workspace / "mirror-receipt.json"
        verify = _run_tool(
            "verify",
            ["--manifest", str(manifest_path), "--artifacts", str(artifact_root)],
            cwd=_tool_path().parent.parent,
        )
        ensure_api = github_api
        ensure = _run_tool(
            "ensure-release",
            [
                "--forge",
                "github",
                "--api-url",
                ensure_api,
                "--repository",
                repository,
                "--manifest",
                str(manifest_path),
                "--artifacts",
                str(artifact_root),
                "--receipt-output",
                str(receipt_path),
            ],
            cwd=_tool_path().parent.parent,
        )
        receipt_value = ensure
        if receipt_path.is_file():
            try:
                receipt_value = json.loads(receipt_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                _fail("publisher-receipt", "publisher receipt file is unreadable")
        if not isinstance(receipt_value, dict) or receipt_value.get("ok") is not True:
            _fail("publisher-receipt", "publisher did not return a successful receipt")
        published = _validate_publisher_receipt(
            receipt_value,
            repository=repository,
            tag=tag,
            commit=manifest["release"]["commit"],
            manifest_sha256=manifest_sha256,
            manifest_size=len(sidecar_bytes),
            targets=manifest["targets"],
        )
        result = {
            "ok": True,
            "command": "mirror-release",
            "repository": repository,
            "version": version,
            "tag": tag,
            "source_commit": manifest["release"]["commit"],
            "manifest_sha256": manifest_sha256,
            "canonical_assets": downloaded,
            "verified": verify,
            "public": True,
            "assets": published["assets"],
            "manifest_asset": published["manifest_asset"],
        }
    if args.receipt_output:
        _write_receipt(Path(args.receipt_output), result)
    return result


def _write_receipt(path: Path, value: dict[str, Any]) -> None:
    if path.exists() and path.is_symlink():
        _fail("publisher-receipt", "receipt output must not be a symlink")
    parent = path.parent
    if not parent.exists() or parent.is_symlink():
        _fail("publisher-receipt", "receipt output parent is unsafe")
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(parent), prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except (NameError, OSError):
            pass
        _fail("publisher-receipt", "could not write mirror receipt")


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        _fail("invalid-arguments", message)


def _parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(prog="mirror-release.py", description=__doc__)
    parser.add_argument("--repository", required=True, help="one of the first-wave repository slugs")
    parser.add_argument("--version", required=True, help="strict semantic version without the v prefix")
    parser.add_argument("--receipt-output", help="optional sanitized mirror receipt path")
    parser.add_argument("--fixture-api", help=argparse.SUPPRESS)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    try:
        args = _parser().parse_args(list(argv) if argv is not None else None)
        result = mirror(args)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except MirrorError as exc:
        payload: dict[str, Any] = {"ok": False, "error": {"code": exc.code, "message": exc.message}}
        payload["error"].update(exc.details)
        print(json.dumps(payload, sort_keys=True, separators=(",", ":")), file=sys.stderr)
        return EXIT_CODES.get(exc.code, 9)
    except (BrokenPipeError, KeyboardInterrupt):
        return 1
    except Exception:
        print(json.dumps({"ok": False, "error": {"code": "internal-error", "message": "unexpected internal failure"}}, separators=(",", ":")), file=sys.stderr)
        return EXIT_CODES["internal-error"]


if __name__ == "__main__":
    raise SystemExit(main())
