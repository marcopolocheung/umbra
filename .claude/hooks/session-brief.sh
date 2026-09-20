#!/usr/bin/env bash
# SessionStart — every brief carries a "Current state" block, and the playbook says it is
# "the only thing a new session must trust". A session that doesn't read it re-derives the
# repo; a session that reads all of them burns its context before writing a line.
#
# This injects just the orientation: branch, which track each brief says is live, and whether
# the working tree is clean. Everything else stays on disk until a track is actually chosen.
# Offline and local-only — no gh, no network, so it can never slow down or fail a launch.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[[ -z "$root" || ! -d "$root/docs/tracks" ]] && exit 0
cd "$root" || exit 0

out="Umbra track board (from each brief's Current state block; the code wins if they disagree):"

for f in docs/tracks/TRACK_*.md; do
  [[ -f "$f" ]] || continue
  id=$(basename "$f" .md | sed 's/TRACK_//')
  name=$(sed -n '1s/^# Track [A-Z] — //p' "$f" | sed 's/\*//g; s/ *(parked)//I; s/ *$//')
  active=$(sed -n '/^## Current state/,/^---/p' "$f" \
           | sed -n 's/^- \*\*Active checkpoint:\*\* *//p' | head -1 \
           | sed 's/\*\*//g' | cut -c1-72)
  [[ -z "$active" ]] && active="—"
  out+=$'\n'"  $id  ${name:-?} — $active"
done

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
out+=$'\n'"Branch: $branch · working tree: $dirty changed file(s)."
out+=$'\n'"Start a track with /track <a-h|p|u>. One session owns one track; never merge a PR."

jq -n --arg c "$out" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $c
  }
}'
