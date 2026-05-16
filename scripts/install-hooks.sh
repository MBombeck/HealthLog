#!/usr/bin/env bash
#
# v1.4.31 — install the repository git hooks.
#
# Run once per fresh clone:
#
#   bash scripts/install-hooks.sh
#
# Idempotent. The script flips `git config core.hooksPath` to
# `.githooks/` so every hook under that directory becomes active.
# Currently installed: `pre-commit` (OpenAPI spec drift check).

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current_path="$(git config --local --get core.hooksPath 2>/dev/null || true)"
if [ "$current_path" = ".githooks" ]; then
  echo "core.hooksPath already points at .githooks — nothing to do."
  exit 0
fi

git config --local core.hooksPath .githooks
echo "Set core.hooksPath = .githooks. Installed hooks:"
ls -1 .githooks | grep -v '^README' | sed 's/^/  /' || true
