---
name: track
description: Boot a Umbra track session — load the brief, confirm the baseline, pick the next checkpoint, and start work. One session owns one track for its whole life.
argument-hint: <a|b|c|d|e|f|g|h|p|u> [checkpoint id, e.g. U3]
arguments: [track, checkpoint]
disable-model-invocation: true
allowed-tools:
  - Bash(git status*)
  - Bash(npm test*)
  - Bash(gh pr list*)
  - Bash(gh issue list*)
---

You are running a **track session** for Umbra. One session owns one track for its whole
life. Do not work on another track's checkpoints, even if you notice something broken there —
file an issue against that track instead.

## Boot sequence (all of this before writing any code)

1. Read, in this order:
   - `CLAUDE.md` (root) — commands, hard invariants, repo map
   - `docs/ROADMAP.md` §3 (the order of work) — it says whether your track's next checkpoint
     is actually the right thing to do, and what is blocking what
   - `docs/notes/AUTONOMOUS_GOAL.md` §Mission, §4 (dependencies + seams), §5 (the loop)
   - `docs/tracks/README.md` — how a session is run, when to fan out
   - `docs/tracks/TRACK_${track^^}.md` — **your brief. This is your context. Read all of it.**
2. Read your brief's `## Current state` block. That is where the last session left off.
3. Confirm `main` is clean and green: `git status`, then `npm test`. If the baseline has moved
   from what the brief claims, the `Current state` block is stale — **trust the code** and say
   so.
4. Check what is already in flight: `gh pr list --state open` and
   `gh issue list --state open --label track-$track`.

You do not need to re-read the per-area constraints by hand. `.claude/rules/` loads the right
one automatically when you open a matching file — the shadow renderer, routing, components,
hooks, the agent loop, external APIs, and tests each have one.

## Pick the work

Take the next unfinished checkpoint in brief order — or `$checkpoint` if one was given. If it
is bigger than one PR, split it into issues, take the first slice, and leave the rest filed.

If your next checkpoint is blocked on another track's contract, **do not switch tracks.**
Build against a stub matching the published interface, note it in the PR's first sentence, and
file an issue against the blocking track.

## Orient (exactly this, ≤6 lines, then start)

```
Track $track — <track name>
Current state: <one line from the brief>
Taking: <checkpoint id> — <goal in one line>
Plan: <2–4 steps>
Subagents: <none | which roles and why>
```

Then work. Do not ask whether to proceed.

## Subagents

Fan out for **reading** and for **provably disjoint writing**. Keep **dependent writing** in
this session.

- `scout` — read-only recon; spawn two or three at once when the questions are independent
- `landscape-scout` — one bounded external research question, with sources
- `builder` — one genuinely disjoint slice, in its own worktree
- `verifier` — the cold adversarial check before the PR opens; the highest-value one here
- `grounding-auditor` — assistant answers and any user-facing number
- `interface-reviewer` — anything touching `app/components/**` or `page.tsx`
- `scribe` — batch-file the findings at the end

**Never** delegate an edit to `useNavigation.ts`, `MapView.tsx` or `page.tsx`, and never hand
a whole track or a chain of dependent checkpoints to a subagent.

## Execute

Follow `AUTONOMOUS_GOAL.md` §5: branch from `main` → implement with tests → `/gates` →
conventional commit → push → open a PR with `gh` → **never merge**.

PR body: at most four sentences, `Fixes #N`, no headings and no bullets.

## Close the loop

Run `/checkpoint` — it walks the definition of done, updates the brief's `Current state`
block in the same PR, and files what you found. Then take the next checkpoint. Do not stop to
ask what's next.
