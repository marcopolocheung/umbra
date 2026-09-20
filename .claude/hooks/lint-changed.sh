#!/usr/bin/env bash
# PostToolUse(Edit|Write) — lint only the file that just changed.
#
# Why this and not "run npm run lint at the end": `npm run lint` reports the whole repo, and
# a known ~180-finding warn-level backlog buries the one error the edit just introduced.
# (There is a standing trap here: Biome's max-diagnostics cap can print "0 errors" while a
# real error is truncated away.) Scoping to the touched file makes the signal unmissable and
# lands it in context while the edit is still the subject.
#
# Also reports design-token violations (hardcoded colours, arbitrary radii/sizes outside the
# registry in app/globals.css) on the lines the edit just added — Track U's registry lint.
#
# Never blocks — PostToolUse fires after the write. It reports, Claude decides.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[[ -z "$root" ]] && exit 0

input=$(cat)
file=$(jq -r '.tool_input.file_path // ""' <<<"$input")
case "$file" in
  *.ts|*.tsx|*.css) ;;
  *) exit 0 ;;
esac
[[ -f "$file" ]] || exit 0

biome="$root/node_modules/.bin/biome"
[[ -x "$biome" ]] || exit 0

# --max-diagnostics is explicit so nothing is silently truncated for a single file.
report=$("$biome" lint --max-diagnostics=50 --colors=off "$file" 2>&1) || true
has_lint=$(grep -qE '^\s*(×|Found [1-9])' <<<"$report" && echo 1 || echo 0)

token_report=""
case "$file" in
  *.tsx|*.css)
    if [[ -f "$root/scripts/verify/design-tokens.mjs" ]]; then
      token_report=$(node "$root/scripts/verify/design-tokens.mjs" --files "$file" 2>&1 || true)
      # Registry violations on the lines just added (Track U2+): reports, never blocks.
      # The hard gate is `npm run design:check` — the cmd body lists the changed lines.
    fi
    ;;
esac
has_tokens=$(grep -qE 'design-tokens:' <<<"$token_report" && echo 1 || echo 0)

[[ "$has_lint" == "0" && "$has_tokens" == "0" ]] && exit 0

lint_block=""
[[ "$has_lint" == "1" ]] && lint_block="Biome findings in ${file##*/} after your edit. Errors fail CI; warn-level items are the known backlog and do not block.

$report"

token_block=""
[[ "$has_tokens" == "1" ]] && token_block="Design-token findings on the lines you just added. Promote the value to a token in app/globals.css (Track U). Advisory for now.

$token_report"

combo="$lint_block"
[[ -n "$lint_block" && -n "$token_block" ]] && combo="$lint_block

-------

$token_block"
[[ -n "$token_block" && -z "$lint_block" ]] && combo="$token_block"

jq -n --arg r "$combo" --arg f "${file##*/}" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("Findings in \($f) after your edit:\n\n\($r)")
  }
}'
