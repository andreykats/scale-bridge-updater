#!/usr/bin/env bash
# Publishes dist/ to the gh-pages branch of origin, which GitHub Pages serves.
# The branch is replaced on every deploy (one commit, no history), so old
# firmware binaries don't pile up in the repo.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/dist"

if [ ! -f "$dist/manifest.json" ]; then
  echo "deploy: no build in $dist; run 'npm run build' first" >&2
  exit 1
fi
if ! remote="$(git -C "$root" remote get-url origin 2>/dev/null)"; then
  echo "deploy: this repo has no 'origin' remote" >&2
  exit 1
fi

version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$dist/manifest.json")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp -R "$dist"/. "$tmp"/
git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" commit -q -m "Publish firmware $version"
git -C "$tmp" push -q -f "$remote" gh-pages
echo "Published firmware $version to the gh-pages branch of $remote"
