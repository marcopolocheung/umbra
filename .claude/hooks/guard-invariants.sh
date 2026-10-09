#!/usr/bin/env bash
# PreToolUse(Edit|Write) — turn the .claude/CLAUDE.md "hard invariants" from prose into
# enforcement. Prose is advisory; a session under context pressure drops it. This does not.
#
# deny     = the invariant is mechanical and breaking it breaks the app (pins, WebGL flags,
#            the lazy import, the User-Agent headers, the suncalc default import).
# escalate = the change is legitimate sometimes but must be a human decision (the shadow
#            colour <-> shadow-predicate coupling), so it becomes a permission prompt.
#
# Exit 0 with no JSON = no opinion; the normal permission flow applies.
set -uo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // ""' <<<"$input")
[[ -z "$file" ]] && exit 0

# Edit gives old_string/new_string; Write gives content. Treat them uniformly.
old=$(jq -r '.tool_input.old_string // ""' <<<"$input")
new=$(jq -r '.tool_input.new_string // .tool_input.content // ""' <<<"$input")

decide() { # $1 = allow|deny|escalate, $2 = reason
  jq -n --arg d "$1" --arg r "$2" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: $d,
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# "Does this edit strip PATTERN out of the file?" — present before, gone after.
strips() { [[ "$old" == *"$1"* && "$new" != *"$1"* ]]; }
adds()   { [[ "$new" == *"$1"* ]]; }

# ── Invariant 7: stale checkouts are never touched ────────────────────────────
case "$file" in
  *"/.worktrees/"*|*"/oldbuild/"*)
    decide deny "CLAUDE.md invariant 7: .worktrees/ and oldbuild/ are orphaned, stale
checkouts. Never read or edit them. If you meant a real file, use the path under the
repository root instead." ;;
esac

base=${file##*/}

# ── Invariant 2: the suncalc version pin (invariant 1, the maplibre pin, is retired) ──
if [[ "$base" == "package.json" ]]; then
  if adds '"suncalc"' && ! grep -qE '"suncalc"[[:space:]]*:[[:space:]]*"?[\^~]?1\.' <<<"$new"; then
    decide deny "CLAUDE.md invariant 2: suncalc stays on 1.x. 2.x is an ESM rewrite with
named exports only, so 'import SunCalc from \"suncalc\"' in sunPosition.worker.ts,
LocalShadowAdapter.ts and offscreenShadow.ts fails the rollup build."
  fi
  for dep in earcut suncalc '@types/suncalc' '@types/earcut'; do
    if strips "\"$dep\""; then
      decide deny "CLAUDE.md invariant 2: '$dep' stays a declared direct dependency.
LocalShadowAdapter.ts imports suncalc and earcut directly; dropping either back to a
transitive-only dep re-breaks both the build and tsc."
    fi
  done
fi

# ── Invariant 2 (cont.): the default import must survive ──────────────────────
case "$base" in
  LocalShadowAdapter.ts|sunPosition.worker.ts|offscreenShadow.ts)
    if strips 'import SunCalc from "suncalc"'; then
      decide deny "CLAUDE.md invariant 2: '$base' must keep the default import
'import SunCalc from \"suncalc\"'. suncalc is pinned to 1.x precisely so this form works;
switching to named imports breaks the Vite/rollup build."
    fi ;;
esac

# ── Invariant 3: the canvas must stay readable ────────────────────────────────
if strips 'preserveDrawingBuffer'; then
  decide deny "CLAUDE.md invariant 3: the map must keep
canvasContextAttributes: { preserveDrawingBuffer: true }. Shadow sampling and GeoTIFF export
read the canvas back; without it both silently return empty pixels."
fi

# ── Invariant 4: MapView is code-split ────────────────────────────────────────
if grep -qE '^[[:space:]]*import[[:space:]]+[A-Za-z_{]' <<<"$new" \
   && grep -qE 'from[[:space:]]+"[^"]*components/MapView"' <<<"$new" \
   && ! grep -qE 'import[[:space:]]+type' <<<"$new"; then
  decide deny "CLAUDE.md invariant 4: MapView is only imported via React.lazy in
app/page.tsx — that is what code-splits MapLibre out of the initial bundle. Use
lazy(() => import(\"./components/MapView\")). Type-only imports are fine."
fi

# ── Invariant 6: only a server can send the User-Agent those services want ────
# The header is forbidden to fetch(), so enforcement runs both ways: the proxies must keep
# it, and client code must never grow it back.
case "$file" in
  */api/nominatim.js|*/api/overpass.js|*/vite.config.ts)
    if strips 'User-Agent'; then
      decide deny "CLAUDE.md invariant 6: Nominatim and Overpass reject requests that do not
identify themselves, and '$base' is one of the few places the header can actually be set — a
browser is not allowed to send it. api/nominatim.js and api/overpass.js carry it in
production; the /__nominatim and /__overpass proxies in vite.config.ts carry it in dev. Keep
it on every upstream call here."
    fi ;;
  */app/*)
    # __tests__ is where the guard against this lives; it has to name the header.
    if [[ "$file" != *"__tests__"* ]] && { adds '"User-Agent"' || adds "'User-Agent'"; }; then
      decide deny "CLAUDE.md invariant 6: User-Agent is a forbidden header name
(https://fetch.spec.whatwg.org/#forbidden-header-name) — the browser drops it silently, so
setting it in client code looks like compliance and is not. Route the request through
/api/nominatim or /api/overpass, which set a real one server-side."
    fi ;;
esac

# ── Invariant 5: shadow detection is coupled to the shadow colour ──────────────
# Judgment call, not a mechanical error: surface it as a prompt rather than a block.
if [[ "$base" == "shadowSampling.ts" ]] && [[ "$old$new" == *"isBlueDominantShadowPixel"* ]]; then
  if adds 'r + g + b <' || adds 'b - ((r + g)' || strips 'r + g + b <'; then
    decide escalate "CLAUDE.md invariant 5: this edits the isBlueDominantShadowPixel
thresholds (r+g+b < 600, b - (r+g)/2 > 18, b > (r+g)/2 * 1.15). Routing and the assistant's
spot checks both decide 'shadowed' with this predicate, and it is coupled to the shadow colours
in LocalShadowAdapter.ts after compositing over the basemap. Changing it silently re-scores
every route. Confirm this is intended."
  fi
fi
if [[ "$base" == "LocalShadowAdapter.ts" ]] && { adds 'shadowColor' || adds 'rgba('; }; then
  if strips 'shadowColor' || adds 'shadowColor'; then
    decide escalate "CLAUDE.md invariant 5: shadow detection couples to the shadow colour.
Colours in LocalShadowAdapter.ts must stay blue-dominant enough to satisfy
isBlueDominantShadowPixel (app/lib/shadowSampling.ts) after compositing over the basemap.
If you change them, re-check that predicate in the same PR."
  fi
fi

exit 0
