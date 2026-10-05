# `.claude/` — the agent configuration

Everything an agent session needs that isn't code. Committed, so every session and every
machine gets the same setup.

**The organising principle:** a rule that must hold is *enforced*, not *requested*. Root
`CLAUDE.md` lists seven hard invariants; before this directory existed they were prose, and
prose is advisory — a session under context pressure drops it. The mechanical ones are now
hooks that deny the edit.

```
.claude/
├── settings.json      permissions + hook wiring + status line
├── agents/            seven specialists, tool- and model-scoped
├── skills/            /track  /gates  /checkpoint  /design-audit
├── rules/             path-scoped constraints; load only when you open a matching file
├── hooks/             the enforcement scripts
└── state/             session-local markers (gitignored)
```

## Which layer does a thing belong in?

| If it… | Put it in | Because |
|---|---|---|
| must hold every time, mechanically | `hooks/` | deterministic; fires regardless of what the model decides |
| applies only to some files | `rules/*.md` with `paths:` | zero context cost until you open one of those files |
| must be true in every session | root `CLAUDE.md` | loaded every time — so keep it under ~200 lines |
| is a procedure you re-type | `skills/` | loads on `/name`, not before |
| reads a lot and returns a little | `agents/` | isolated context; only the summary comes back |

The trap this replaces: writing "never do X" in `CLAUDE.md` and believing it is enforcement.
It is a request. If it must hold, it goes in `hooks/`.

### Why there is no `.claude/CLAUDE.md`

`./CLAUDE.md` and `./.claude/CLAUDE.md` are the two supported locations for the *same* file —
an either/or, not a pair. Discovered memory files are concatenated rather than overriding each
other, so creating the second one would put two always-on project-instruction files in every
session: the "conflicting instructions" failure the docs warn about, in a repo whose own
guides say "root `CLAUDE.md`" a dozen times.

The slot is not empty either. Rules **without** `paths:` frontmatter load at launch *with the
same priority as `.claude/CLAUDE.md`* — which is exactly what `rules/change-discipline.md` is.
That layer exists; it just isn't named `CLAUDE.md`.

## Hooks

| Event | Script | What it does |
|---|---|---|
| `SessionStart` | `session-brief.sh` | Injects the track board — each brief's active checkpoint, branch, tree state. ~10 lines, offline, so no brief has to be read to orient. |
| `PreToolUse(Edit\|Write)` | `guard-invariants.sh` | **Denies** edits that break the mechanical invariants: the suncalc `1.x` pin, the direct `suncalc`/`earcut` deps, the suncalc default import, `preserveDrawingBuffer`, the `React.lazy` MapView import, `User-Agent` on Nominatim/Overpass, and any path under `.worktrees/` or `oldbuild/`. **Escalates** to a prompt for the shadow-colour ↔ `isBlueDominantShadowPixel` coupling, which is a judgment call rather than an error. |
| `PostToolUse(Edit\|Write)` | `lint-changed.sh` | Biome on just the file that changed. `npm run lint` reports the whole repo and its ~180-item warn backlog buries a new error; scoping to one file makes it unmissable. Never blocks. |
| `Stop` | `check-gates.sh` | If source under `app/`/`api/` changed and `/gates` hasn't recorded all four green since, blocks once per session. Never runs the gates itself — `npm run build` is far too slow for a Stop hook — it compares timestamps. `UMBRA_GATES_STRICT=1` makes it block every time. |

Verify any of them by hand:

```bash
echo '{"tool_input":{"file_path":"package.json","old_string":"\"suncalc\": \"1.9.0\"","new_string":"\"suncalc\": \"2.0.0\""}}' \
  | .claude/hooks/guard-invariants.sh
```

**These are honest about their limits.** The guard matches `Edit`/`Write`, so a `sed` or a
script can still route around it — it removes the common accident, not a determined effort.
The `Stop` hook nudges once rather than blocking repeatedly, because a hook that blocks a
session into a corner gets deleted, and a deleted hook enforces nothing.

## Agents

Read-heavy and verify-heavy on purpose. The playbook's rule 3 is that implementation stays in
the session: edits concentrate in a few large files and depend on invariants a cold agent
doesn't know, so handing the main edit to a fresh subagent reliably produces plausible, wrong
code. There is exactly one writer here (`builder`), and it is fenced.

| Agent | Model | Writes? | For |
|---|---|---|---|
| `scout` | sonnet | no | Repo recon. Returns pointers, and flags where the code contradicts a brief. |
| `landscape-scout` | opus | no | One bounded external question, with sources; separates verified from inferred. |
| `verifier` | opus | no | The cold adversarial check before a PR. The highest-value one here. |
| `grounding-auditor` | opus | no | Ungrounded assistant claims and untraceable user-facing numbers. |
| `interface-reviewer` | opus | no | UI under the real constraint: outdoors, bright sun, one-handed, walking. |
| `scribe` | haiku | no | Batch-files findings as labelled issues. |
| `builder` | inherit | **yes** | One provably disjoint slice, in its own worktree. Never the contested three. |

## Skills

- **`/track <a-g> [checkpoint]`** — boot a track session. Replaces `.claude/commands/track.md`;
  same invocation, now with named arguments and pre-approved boot commands.
- **`/gates`** — run all four CI gates, report real output, record the green marker the `Stop`
  hook and status line read.
- **`/checkpoint [id]`** — walk the eight-item definition of done, get the cold review, open
  the PR, update the brief's `Current state`, file findings.
- **`/design-audit`** — read-only Umbra redesign 2.0 review of the registry, screenshots,
  outdoor contrast, focus, and map safety.

`/gates` is model-invocable; the other two have `disable-model-invocation: true` because they
have side effects and you should decide when they run.

## Rules

Path-scoped, so each costs nothing until you open a file it covers. These are the
per-directory guides root `CLAUDE.md`'s repo map has always pointed to — they were never
written (issue #50), and `paths:` frontmatter is a better answer than nested `CLAUDE.md`
files, which load per-directory whether or not they're relevant.

`shadow-renderer` · `routing-and-shadow` · `components-and-map` · `hooks-and-state` ·
`agent-loop` · `external-apis` · `tests` — plus `change-discipline`, the only unscoped one,
which is short on purpose.

## Permissions

`settings.json` pre-approves the four gates and read-only `git`/`gh`, and denies outright only
what should never happen at all: reads of `.env*`, and anything under `.worktrees/` or
`oldbuild/`.

Two rules are **`ask`, not `deny`**. `gh pr merge` prompts because the owner merges their own
PRs — that is a decision to confirm, not something to make mechanically impossible.
Force-push prompts because the guardrail it encodes ("never rewrite published history") is
aimed at `main`, while a blanket deny also blocks the topic-branch rebase the cross-track
playbook explicitly tells the second session to do. A prompt gives the same stop-and-think
without making sanctioned work impossible. `git rebase` and `git merge` are not restricted at
all, for the same reason.

Over-denying is how a config gets switched off wholesale, which protects nothing.

## Attribution

```json
"attribution": { "commit": "", "pr": "", "sessionUrl": false }
```

Three empty/false values, which is the documented way to turn attribution off entirely: no
`Co-Authored-By` trailer on commits, no attribution line in PR bodies, no session link. The
repo owner is the sole contributor on this project and the history should say so.

This replaces the deprecated `includeCoAuthoredBy: false`. Note the interaction: once `commit`
or `pr` is set, Claude Code ignores `includeCoAuthoredBy` entirely and falls back to its
*default* text for whichever of the two you left unset — so set both, not one.

Scope note: this is project settings, so it covers this repo only. To apply it everywhere, put
the same block in `~/.claude/settings.json`.

## Maintaining this

Same test as `CLAUDE.md`: for each line, *would removing it cause a mistake?* If not, cut it.

When something goes wrong twice, ask which layer it belonged in. A repeated invariant breach
is a missing hook, not a longer `CLAUDE.md`. A repeated "where does X live?" is a missing
pointer in a brief. A repeated procedure is a skill.
