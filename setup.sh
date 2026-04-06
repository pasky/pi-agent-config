#!/bin/bash
# Run after clone or submodule update
cd "$(dirname "$0")"
git config core.hooksPath .githooks
git submodule update --init --recursive
git submodule foreach 'git fetch --quiet'
# Reattach submodules to their configured branch (avoid detached HEAD)
# Only reattaches if the branch tip matches the checked-out commit
git submodule foreach '
  branch=$(git config -f $toplevel/.gitmodules submodule.$name.branch || echo main)
  pinned=$(git rev-parse HEAD)
  local_ref=$(git rev-parse refs/heads/$branch 2>/dev/null || echo none)
  if [ "$local_ref" = "none" ]; then
    # No local branch yet — create it at the pinned commit
    git switch -c $branch 2>/dev/null
  elif [ "$local_ref" = "$pinned" ]; then
    # Already matches — just switch
    git switch $branch 2>/dev/null
  elif git merge-base --is-ancestor $pinned $local_ref 2>/dev/null; then
    # Local branch is ahead of pinned (has unpushed commits) — keep it, just switch
    git switch $branch 2>/dev/null
  elif git merge-base --is-ancestor $local_ref $pinned 2>/dev/null; then
    # Local branch is behind pinned — fast-forward to pinned commit
    git switch $branch 2>/dev/null
    git merge --ff-only $pinned 2>/dev/null
  else
    echo "WARNING: $name local $branch (${local_ref:0:12}) has diverged from pinned (${pinned:0:12}) — staying detached"
  fi
'
(cd packages/pi-amplike && npm install)
(cd packages/chrome-cdp-skill && npm install)
