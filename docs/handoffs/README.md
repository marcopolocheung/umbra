# Session handoffs

Documents sized for **one new session** each. They exist because the roadmap says *what* to do
and the briefs say *how*, but neither says *"here is the state of the world today, start
here."* That is what these are.

**They are snapshots and they decay.** Every one carries a `Verified` date and the commands to
re-check its claims. If a handoff disagrees with the code, **the code wins** — fix the handoff
in the same PR as the work, the way `docs/tracks/README.md` requires of the briefs' state
blocks.

| Read this | If you are | Session shape |
|---|---|---|
| [`WAVE_0.md`](WAVE_0.md) | clearing the things that are currently false | ~4 small PRs, cross-track |
| [`PUBLICATION.md`](PUBLICATION.md) | making the existing work visible (P4 + P2) | 2 PRs, no new engineering |
| [`THREAD_SHADOW.md`](THREAD_SHADOW.md) | building the differentiator (G→A→H) | long; one checkpoint per PR |
| [`THREAD_AGENT.md`](THREAD_AGENT.md) | building the multimodal agent (Track C) | long; one checkpoint per PR |
| [`TRANSIT_CLIENT.md`](TRANSIT_CLIENT.md) | **done through S3a** — the record of how the client came to route on the published data | history; read before `TRANSIT_NEXT` |
| [`TRANSIT_NEXT.md`](TRANSIT_NEXT.md) | finishing transit: making it visible, pricing the wait, then bus | 3 phases; 1 small session, then 2 long |

**Order.** `WAVE_0` first — it unblocks both threads and its items are hours, not days. Then
`PUBLICATION`, which is the cheapest signal on the board. `TRANSIT_NEXT`'s Phase 1 is three
small PRs and one of them (#395) is what makes every other transit change visible at all, so it
is cheap to take early. The two threads are **independent and
parallel**: Track C owns `app/lib/agent/**` outright and reaches the rest of the app only
through tool wrappers, so a shadow session and an agent session do not collide.

**Every session, regardless:** `/gates` before any PR opens, `/checkpoint` before it is
reviewed, and never merge — that is the owner's call.

## State common to all of them *(verified 2026-09-09, commit `f159b25`)*

- `main` is **green**: lint 0 errors (51 warnings / 8 infos are the known backlog), typecheck 0,
  **550 tests / 48 files**, build clean, browser smoke test passing in CI.
- **P1 is done.** The public mirror at `marcopolocheung/shademapnav` is live and current, so
  anything requiring a publicly-resolving link now works.
- The **PR queue is empty.** #253 and #255 merged this refresh; #165, #210, #213 merged
  earlier and #161 was closed.
- Toolchain is **vite 6.4.3 / vitest 4.1.11 / jsdom 30.0.1 / `@types/node` 24.13.3** on
  **Node 24.21.0** — `.nvmrc` and `engines.node` both say `24.x`, and CI matches. **Vercel runs
  24.x too**, which is why the bump went to 24 rather than the 22 #215 proposed. `vitest` stays
  on **4.x** deliberately: vitest 5 removes the `bench` export (**#254**).
- **Wave 0 is clear.** #204 (real timezones) and #208 (access tags) merged, and #215 (the Node
  bump) is done — so nothing in `WAVE_0.md` blocks either thread any more.
