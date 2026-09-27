#!/usr/bin/env bash
# Pull the latest NFL Scores from GitHub and reload it in the running shell.
# This is what the `nfl` alias on the desktop runs; development happens in
# another clone and reaches this machine through GitHub.
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    echo "Local edits in $repo_dir; not pulling over them:" >&2
    git status --short --untracked-files=no >&2
    exit 1
fi

before=$(git rev-parse --short HEAD)
git pull --ff-only --quiet
after=$(git rev-parse --short HEAD)
if [[ $before == "$after" ]]; then
    echo "Already up to date ($after)."
else
    git log --oneline "$before..$after"
fi

exec ./scripts/install.sh
