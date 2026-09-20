# Running a track — the operating playbook

**`docs/ROADMAP.md` says *what* to build and in what order, and why each item is worth doing** —
read it when choosing work. `docs/notes/AUTONOMOUS_GOAL.md` says what the mission and guardrails
are. This file says *how a session is run*: how to start one, when to spawn subagents, when not to, and how one
session hands off to the next.

**Read this once per session, at boot. It is short on purpose.**

---

## The four rules

1. **One session = one track.** The track is the unit of context. A session that hops tracks
   pays full re-derivation cost each hop and starts touching files another track owns.
2. **One checkpoint = one PR.** Checkpoints in the briefs are sized for this. If one isn't,
   split it into issues and take the first slice.
3. **The session implements; subagents scout, parallelize the genuinely independent, and
   verify.** In this repo, implementation edits concentrate in a handful of large files and
   depend on invariants a cold agent doesn't know. Handing the *main* edit to a fresh subagent
   reliably produces plausible, wrong code.
4. **Never merge.** Every PR stays open for the repo owner. That's a hard repo rule, and it's
   also why every branch must come off `main`, not off another open PR.

---

## Starting a session

**In an interactive Claude Code session:**

```
/track b
```

Tracks are `a`–`h` plus `p` and `u`. `h` (Sun Budget) is gated on A6+G2; `p` (Publication) is
unblocked and owns the cheapest work on the board — see `docs/ROADMAP.md` §3. `u` (UI &
Design Language) is the design wave: strictly sequential, mobile-first, every PR visually
reviewed by the owner — read `docs/handoffs/DESIGN_LANGUAGE.md` before starting it.

…or to resume a specific checkpoint:

```
/track b B5
```

`/track` is now a skill (`.claude/skills/track/`), invoked exactly as before. At session start
a hook prints the track board — every brief's active checkpoint — so you can see what is live
before loading anything.

The command loads root `CLAUDE.md`, the mission and seam sections of `AUTONOMOUS_GOAL.md`,
this playbook, and the track brief — then prints a six-line orientation and starts.

**Anywhere the slash command isn't available** (`claude -p`, a cloud session, a fresh
checkout), paste this instead:

```
You own Track B (Live Navigation) for this session. Read, in order: CLAUDE.md,
docs/ROADMAP.md (what to build and why), docs/tracks/README.md, docs/tracks/TRACK_B.md.
Start from the "Current state" block in the brief, take the next unfinished checkpoint —
unless docs/ROADMAP.md's Wave 0 says something blocks it — and work it end to end per
AUTONOMOUS_GOAL.md §5 — branch, implement with tests, run all four gates, push, open a PR
with gh, never merge. Update the brief's Current state block in the same PR. Do not work on
another track's files; file issues against those tracks instead. Don't ask me what to do
next — pick the reasonable default and note the assumption in the PR.
```

That prompt is short *because the brief carries the context*. If a session needs more than
this to get going, the brief is the thing to fix — not the prompt.

---

## Subagents: when to fan out

| Situation | Pattern | Why |
|---|---|---|
| "Where is X handled? What calls Y?" across many files | 1–3 `scout` agents in parallel, read-only | Keeps large file dumps out of the session's context; returns just the pointers |
| A checkpoint splits into slices that touch **disjoint** files | one `builder` per slice — it already carries `isolation: "worktree"` | Real parallelism, no branch or file collisions |
| A checkpoint is done and you want it checked cold | `verifier`, given only the brief's acceptance criteria + the diff | Cold context is an *advantage* here: it can't inherit your optimism |
| A long research question with a bounded answer ("does Overpass expose crown diameter, and how often is it tagged?") | `landscape-scout` | Cheap, isolatable, doesn't pollute the implementation context |
| An assistant answer or a new user-facing number | `grounding-auditor` | The honesty guardrail is the one claim this product can't get wrong |
| A diff touching `app/components/**` or `page.tsx` | `interface-reviewer` | Outdoors, bright sun, one-handed is a review standard nobody applies by default |
| Sequential checkpoints (A2 → A3 → A4) | **No subagent.** Do it yourself, in order | Each one's output is the next one's input; a swarm just serializes with extra steps and lost context |
| Anything touching `MapView.tsx` or `page.tsx` | **No subagent** (until G6b/c land) | Two contested files left; concurrent edits conflict, and they're where the invariants bite |
| "Go do Track B" as a whole | **Never** | A track is weeks of dependent work with an evolving state block. That's a session, not a task |

### The rule of thumb

> Fan out for **reading** and for **provably disjoint writing**. Keep **dependent writing**
> in the session.

### The roster

These are defined as real agents in `.claude/agents/`, so you address them by name instead of
pasting a prompt. Each is tool-scoped and model-scoped to its job.

| Agent | Writes? | Use it for |
|---|---|---|
| `scout` | no | Repo recon. Returns pointers, not file contents, and flags where the code contradicts this brief. |
| `landscape-scout` | no | One bounded external question, with sources, separating verified from inferred. |
| `verifier` | no | The cold adversarial check before the PR opens. The highest-value one in this repo. |
| `grounding-auditor` | no | Assistant answers and any user-facing number — the honesty guardrail. |
| `interface-reviewer` | no | Anything touching `app/components/**` or `page.tsx`. |
| `scribe` | no | Batch-filing findings as labelled issues at the end of a checkpoint. |
| `builder` | **yes** | One provably disjoint slice, in its own worktree. Never the contested two (`MapView.tsx`, `page.tsx`). |

Spawn them with the Agent tool, giving the specific question or the pasted acceptance
criteria — the standing instructions live in the agent file, so the prompt only needs to carry
what is particular to this call. Spawn two or three `scout`s in one message when the questions
are independent.

Six of the seven cannot write, by construction rather than by instruction. That is the point:
rule 3 above says implementation stays in the session, and the roster now enforces it.

## Anti-patterns (each one has burned a session in this repo's shape)

- **Swarming a sequential checkpoint chain.** A3 exists to make A4 safe; running them in
  parallel means A4 lands unverified.
- **Two agents in one worktree.** Concurrent edits to the same checkout produce interleaved,
  unreviewable diffs. One worktree per writer, always.
- **Branching off an open PR** because a checkpoint "depends" on it. Everything stays open for
  review, so stacked branches pile up unmergeable work. Stub the interface and branch from `main`.
- **Letting a subagent "quickly also fix" something it noticed.** Scope creep in a cold context
  is how invariants get broken. Findings become issues, not edits.
- **Trusting a subagent's "all tests pass."** Ask for the pasted output; verify the four gates
  in the session before opening a PR. `/gates` runs all four and records the result, and a
  `Stop` hook blocks a session that edited source and never got them green — but neither
  substitutes for reading the output.
- **Re-deriving the repo every session.** If you spent the first 20 minutes rediscovering how
  shadow sampling works, the brief was missing a pointer — add it before you finish.

---

## Cross-track parallelism

Real parallelism comes from **multiple sessions, one per track** (separate terminals), not
from subagents inside one session. Which pairs are safe to run at the same time:

**Track P is safe alongside everything** — it owns `README.md` and `docs/notes/**` and touches
no application code.

| | A | B | C | D | E | G | H |
|---|---|---|---|---|---|---|---|
| **A** Shadow Engine | — | ✅ | ✅ | ⚠️ A6/D1 share the sweep API | ⚠️ both edit `routing.ts` | ⚠️ G4 owns A's fixtures | ⚠️ both edit `routing.ts`; H consumes A6 |
| **B** Navigation | ✅ | — | ✅ | ✅ | ⚠️ B8 consumes `Trip`, E5 defines it | ✅ | ✅ |
| **C** Copilot | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ (H6 consumes C's job contract) |
| **D** Heat & Timing | ⚠️ | ✅ | ✅ | — | ✅ | ✅ | ✅ (H supplies minutes, D converts) |
| **E** Journeys & Modes | ⚠️ | ⚠️ B8 consumes `Trip`, E5 defines it | ✅ | ✅ | — | ⚠️ G6 splits E's files | ⚠️ both edit `routing.ts`; H5 consumes `Trip` |
| **G** Proving Ground | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | — | ⚠️ H4 shares G's fixtures |
| **H** Sun Budget | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | — |
| **P** Publication | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

✅ = run simultaneously without coordination. ⚠️ = coordinate: agree in an issue who edits the
shared file first, and let the second session rebase after the first PR opens.

**G6 (the seam splits) runs alone.** It rewrites the three contested files by definition.
Pause other tracks' work on those files while it's in flight — it is the one piece of work
worth blocking on, because it removes the ⚠️s from this table permanently.

**Track C is the friendliest to run alongside anything** — it owns `app/lib/agent/**` outright
and consumes everyone else through tool wrappers.

---

## Publishing: the public mirror

`origin` is private. `github.com/marcopolocheung/shademapnav` is what the world sees, and the
app links into it — the heat and UV rows render a "how this was calculated" link pointing at
`docs/notes/`. So a doc that is merged but not mirrored is a dead link in production, which is
what #199 was.

**You do not push the mirror.** `.github/workflows/mirror.yml` pushes `main` on every merge,
then curls every `umbra` doc URL it finds in `app/` and fails if one 404s. If that job
goes red, the mirror is stale and a link in the UI is probably broken — fix it before taking
new work.

The same workflow also runs on your PR, minus the push. Two things follow for a track session:

- **A doc the UI links to must land in the same PR as the link.** The mirror publishes whatever
  is on `main`; it cannot publish a file that is not there yet. The PR run checks each linked
  path exists in your tree, so this fails at review rather than after merge.
- **Never commit anything to `main` you would not publish.** `scripts/mirror-guard.sh` runs on
  the PR and again before the push, blocking `.env` files, credential-shaped literals and
  hard-coded keys — but it recognises shapes, not judgement. Run it yourself
  (`./scripts/mirror-guard.sh`) if a PR adds fixtures, config or captured output. It reports
  file and line only, never the matched text.

**One-time setup, owner only.** The job needs push access to a second repo, which
`GITHUB_TOKEN` does not grant. Create a fine-grained PAT scoped to `marcopolocheung/shademapnav`
alone with **Contents: Read and write**, add it as the `MIRROR_TOKEN` repository secret on
`Umbra`, then run the workflow once from the Actions tab to backfill. Until that
secret exists the job fails loudly on every merge rather than mirroring nothing quietly.

## State and handoff

Each brief carries a `## Current state` block. It is the only thing a new session must trust:

```markdown
## Current state
- **Active checkpoint:** B3 (position tracking) — PR #NNN open
- **Done:** B1, B2
- **Open PRs:** #NNN (B3)
- **Decisions made:** map-matching tolerance 25 m; heading from `coords.heading`, compass fallback deferred
- **Blocked on:** nothing (B6 will need Track A's `ShadowField`; stubbed at `app/lib/shadowField/stub.ts`)
- **Next action:** B4 — replace the NAVIGATING card
- **Last verified:** 2026-08-24, 156 tests / 23 files green on main
```

Update it **in the same PR as the work it describes**. A state block that drifts is worse than
none, because the next session will believe it.

If you discover the brief is wrong about the code — the code wins. Fix the brief in your PR
and say so in the PR's four sentences.

---

## Definition of done (every checkpoint, no exceptions)

- [ ] The brief's acceptance criteria for that checkpoint are met, demonstrably
- [ ] Tests cover the behavior (logic changes in `app/lib/**`, `app/services/**`, `app/hooks/**` require them)
- [ ] `npm run lint` · `npm run typecheck` · `npm test` · `npm run build` all pass — run
      `/gates`, which records the result the `Stop` hook reads
- [ ] UI/map changes confirmed in `npm run dev` — actually looked at, not assumed
- [ ] No hard invariant touched (root `CLAUDE.md`)
- [ ] PR open, ≤4 sentences, `Fixes #N`, never merged
- [ ] `## Current state` updated in the brief
- [ ] Findings filed as issues with priority + type + `track-x` labels

`/checkpoint` walks this list in order, gets the cold review, opens the PR, and updates the
state block — use it rather than working from memory.
