#!/usr/bin/env bash
# Stop — the repo's loudest anti-pattern is "trusting a subagent's 'all tests pass'".
# This closes that hole from the other side: a session that edited source and never got the
# four gates green cannot quietly end claiming the checkpoint is done.
#
# It never runs the gates itself (npm run build is far too slow for a Stop hook). It compares
# the newest edited source file against the marker that /gates writes only when all four
# actually pass, and blocks once per session if the marker is stale.
#
# Set UMBRA_GATES_STRICT=1 to block on every Stop instead of once per session.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[[ -z "$root" || ! -d "$root" ]] && exit 0
cd "$root" || exit 0

input=$(cat)
session=$(jq -r '.session_id // "unknown"' <<<"$input" 2>/dev/null || echo unknown)

state="$root/.claude/state"
marker="$state/gates-green"
mkdir -p "$state" 2>/dev/null || exit 0

# Which source files does this repo require gates for? The ones CI actually compiles.
changed=$(git status --porcelain -- app api 2>/dev/null | awk '{print $NF}' | grep -E '\.(ts|tsx)$' || true)
[[ -z "$changed" ]] && exit 0

# Newest edit wins. If the marker is newer than every change, the gates covered this work.
newest=""
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  [[ -z "$newest" || "$f" -nt "$newest" ]] && newest="$f"
done <<<"$changed"
[[ -z "$newest" ]] && exit 0
[[ -f "$marker" && "$marker" -nt "$newest" ]] && exit 0

if [[ "${UMBRA_GATES_STRICT:-0}" != "1" ]]; then
  stamp="$state/nudged-$session"
  [[ -f "$stamp" ]] && exit 0
  : >"$stamp"
fi

count=$(wc -l <<<"$changed" | tr -d ' ')
jq -n --arg n "$count" --arg f "$newest" '{
  decision: "block",
  reason: ("You have \($n) modified TypeScript file(s) under app/ or api/ (most recently \($f)) and the four gates have not been recorded green since that edit.\n\ndocs/tracks/README.md § The loop requires all four, every time: npm run lint · npm run typecheck · npm test · npm run build — plus npm run dev for UI/map changes.\n\nRun /gates, which runs all four and records the result. Paste the real output. If a gate fails, say so plainly rather than describing the work as done.\n\nIf this session deliberately is not finishing a checkpoint (exploration, docs, a question), say that in one line and stop again — this fires once per session.")
}'
exit 0
