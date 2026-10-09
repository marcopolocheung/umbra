---
name: gates
description: Run all four Umbra CI gates (lint, typecheck, test, build) in order, report the real output, and record the result so the session can honestly claim the work was verified. Use before opening any PR and whenever asked whether the checks pass.
argument-hint: "[--quick to stop at typecheck]"
disable-model-invocation: false
allowed-tools:
  - Bash(npm run lint*)
  - Bash(npm run typecheck*)
  - Bash(npm test*)
  - Bash(npm run build*)
  - Bash(mkdir -p ${CLAUDE_PROJECT_DIR}/.claude/state)
  - Bash(touch ${CLAUDE_PROJECT_DIR}/.claude/state/gates-green)
  - Bash(rm -f ${CLAUDE_PROJECT_DIR}/.claude/state/gates-green)
---

# The four gates

CI runs exactly these four, in this order, on every PR to `main` and every push to `main`.
`docs/tracks/README.md` § The loop requires all four, every time — not a representative sample.

Run them one at a time so a failure is attributable:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If `$ARGUMENTS` contains `--quick`, run only `lint` and `typecheck` — the fast pair — and say
explicitly that this was a partial run and the marker was not written.

## What each result means

**`npm run lint`** — Biome. Errors block CI; a known backlog of roughly 180 findings is
`warn`-level and does not. Two traps: Biome's max-diagnostics cap can print a reassuring
summary while truncating a real error, and the warn backlog buries new findings. If the output
looks truncated, say so rather than reading the summary line as a pass.

**`npm run typecheck`** — `tsc --noEmit`. Baseline is **0 errors**. Any error is yours.

**`npm test`** — `vitest run`, `environment: "node"`, hermetic. The last recorded baseline was
156 tests across 23 files; if the count has moved down, something was deleted or skipped, and
that is worth a sentence. A green suite says nothing about rendering — see below.

**`npm run build`** — `vite build`. Catches what the others miss: the suncalc default-import
break, bundle-splitting regressions, and anything that only fails under rollup.

## Recording the result

**Only when all four pass**, mark them green:

```bash
mkdir -p "${CLAUDE_PROJECT_DIR}/.claude/state" && touch "${CLAUDE_PROJECT_DIR}/.claude/state/gates-green"
```

If any gate fails, remove a stale marker instead:

```bash
rm -f "${CLAUDE_PROJECT_DIR}/.claude/state/gates-green"
```

The `Stop` hook and the status line both read that marker's timestamp against the newest
edited file under `app/` and `api/`. This is what stops a session ending with an unearned
"all tests pass" — so never touch the marker without having actually run all four green.

## Reporting

Paste the real output — the counts, the timings, the failures. Not "all four passed."
If a gate fails, say which, quote the error, and do not describe the work as done because the
other three were fine.

## The gate you cannot run

None of this exercises a browser. Shadow rendering, timeline drag, end-to-end route
calculation, the streaming preview and GeoTIFF export are untested by `npm test` and always
have been. If the change touches UI or the map, the definition of done also requires
`npm run dev` and a human look — state plainly that this check is still outstanding rather
than letting four green gates imply it.
