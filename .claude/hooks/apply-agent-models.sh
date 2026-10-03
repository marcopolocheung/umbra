#!/usr/bin/env bash
# SessionStart hook: pick the subagent model set from the main session's model.
#
# Why this exists. This Claude Code build routes every model call through
# ANTHROPIC_BASE_URL (Fireworks). The Claude models (`sonnet`/`opus`) sit on a
# rate-limited route — three parallel opus reviewers tripped HTTP 429s — while
# the Fireworks serverless models had headroom all night. So when the main
# session runs a Fireworks model, spread the subagents across Fireworks models;
# otherwise use the Claude defaults.
#
# Why a hook and not the frontmatter. The `model:` field in agent frontmatter is
# a static string with no interpolation or expressions. The conditional
# therefore lives here, in the script, which writes a static value into the
# field. Agent configs load at session start, so this runs then.
#
# Testing: AGENT_MODEL_MAIN overrides the detected model, so both branches can
# be exercised without switching sessions.

set -euo pipefail

PROJECT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DIR="$PROJECT/.claude/agents"
SETTINGS="$HOME/.claude/settings.json"

MAIN="${AGENT_MODEL_MAIN:-}"
if [[ -z "$MAIN" && -f "$SETTINGS" ]]; then
  MAIN="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('model',''))" "$SETTINGS" 2>/dev/null || true)"
fi

# Rewrite the first `model:` line of an agent file, leaving the rest untouched.
set_model() { # $1 = file name, $2 = model value
  local f="$DIR/$1"
  [[ -f "$f" ]] || return 0
  sed -i -E "0,/^model: .*/s|^model: .*$|model: $2|" "$f"
}

if [[ "$MAIN" == deepseek-flash-latest* ]]; then
  # Main session is on the Fireworks serverless route: spread the subagents so
  # they do not all contend for the rate-limited Claude route. The verifier —
  # the gate that matters most — stays on opus, and runs alone (serialized).
  set_model verifier.md           opus
  set_model grounding-auditor.md  '"kimi-latest[1m]"'
  set_model interface-reviewer.md '"glm-latest[1m]"'
  set_model scout.md              '"deepseek-flash-latest[1m]"'
  set_model landscape-scout.md    '"deepseek-pro-latest[1m]"'
  set_model scribe.md             '"glm-flash-latest[1m]"'
else
  # Any other main model: the Claude defaults.
  set_model verifier.md           opus
  set_model grounding-auditor.md  opus
  set_model interface-reviewer.md opus
  set_model scout.md              sonnet
  set_model landscape-scout.md    opus
  set_model scribe.md             haiku
fi
