#!/usr/bin/env bash
# Point this repo's local git at .githooks/ so the pre-push hook fires.
#
# Idempotent. Safe to run on every `pnpm install` via the root `postinstall`
# script in package.json. If the user is not in a git checkout (e.g. tarball /
# CI ephemeral worktree) this exits cleanly without complaining.

set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

git config core.hooksPath .githooks
echo "✓ git hooks installed (core.hooksPath=.githooks). 'git push' now runs build+typecheck+test first."
