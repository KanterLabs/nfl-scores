#!/usr/bin/env python3
"""Check the release workflow invariants that are easy to regress offline."""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_ROOTS = (ROOT / ".github" / "workflows", ROOT / ".gitea" / "workflows")
RELEASE_FILE = "release.yml"
SHA = re.compile(r"^[0-9a-f]{40}$")


def fail(message: str) -> None:
    raise SystemExit(f"workflow contract: {message}")


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        fail(f"cannot read {path}: {exc}")


def job_block(document: str, name: str) -> str:
    match = re.search(rf"(?m)^  {re.escape(name)}:\n", document)
    if match is None:
        fail(f"{name} job is missing")
    tail = document[match.end() :]
    next_job = re.search(r"(?m)^  [A-Za-z0-9_-]+:\n", tail)
    return tail[: next_job.start() if next_job else len(tail)]


def check_release_plan(document: str, forge: str) -> None:
    plan = job_block(document, "plan")
    exact_tag = 'test "${{ github.ref_name }}" = "v$expected_version"'
    if exact_tag not in plan:
        fail(f"{forge} release plan must retain the exact v-prefixed tag check")
    if "release_version=${RELEASE_VERSION#v}" not in plan:
        fail(f"{forge} release plan must normalize the v prefix only for tag events")
    if 'test "$release_version" = "$expected_version"' not in plan:
        fail(f"{forge} release plan must compare the normalized version")
    if 'printf \'version=%s\\n\' "$release_version"' not in plan:
        fail(f"{forge} release plan must emit the normalized version")


def check_package_timeout(document: str, forge: str, workflow: str) -> None:
    package = job_block(document, "package")
    match = re.search(r"(?m)^    timeout-minutes: ([0-9]+)$", package)
    if match is None or match.group(1) != "10":
        observed = match.group(1) if match else "missing"
        fail(f"{forge}/{workflow} package timeout must be 10 minutes (found {observed})")


def check_action_pins(document: str, forge: str, workflow: str, expected_checkout: str) -> None:
    refs = re.findall(r"uses:\s+[^@\s]+@([^\s#]+)", document)
    if any(not SHA.fullmatch(ref) for ref in refs):
        fail(f"{forge}/{workflow} has an unpinned action reference")
    checkouts = re.findall(r"uses:\s+actions/checkout@([^\s#]+)", document)
    if not checkouts or set(checkouts) != {expected_checkout}:
        fail(f"{forge}/{workflow} must use one checkout SHA per forge")


def check_gitea_publisher(document: str) -> None:
    publisher = job_block(document, "publish-gitea")
    if not re.search(r"(?m)^    permissions:\n      contents: read\n      releases: write\n", publisher):
        fail("Gitea publisher must keep code read and grant releases write")


def main() -> None:
    expected_checkout = "11bd71901bbe5b1630ceea73d27597364c9af683"
    for workflow_root, forge in zip(WORKFLOW_ROOTS, ("github", "gitea")):
        workflows = sorted(workflow_root.glob("*.yml"))
        if not workflows:
            fail(f"{forge} workflow directory is empty")
        for path in workflows:
            document = read(path)
            workflow = path.name
            check_action_pins(document, forge, workflow, expected_checkout)
            if re.search(r"(?m)^  package:\n", document):
                check_package_timeout(document, forge, workflow)
            if workflow == RELEASE_FILE:
                check_release_plan(document, forge)
                if forge == "gitea":
                    check_gitea_publisher(document)
    print("workflow contract passed: tag normalization, publisher permissions, package budget, action pins")


if __name__ == "__main__":
    main()
