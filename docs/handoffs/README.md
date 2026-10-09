# Session handoffs

Documents sized for **one new session** each. They exist because the roadmap says *what* to do
and the briefs say *how*, but neither says *"here is the state of the world today, start
here."* That is what these are.

**They are snapshots and they decay.** Every one carries a `Verified` date and the commands to
re-check its claims. If a handoff disagrees with the code, **the code wins** — fix the handoff
in the same PR as the work, the way `docs/tracks/README.md` requires of the briefs' state
blocks.

| Read this | If you are |
|---|---|
| [`THREAD_SHADOW.md`](THREAD_SHADOW.md) | building the differentiator (G→A→H) |
| [`THREAD_AGENT.md`](THREAD_AGENT.md) | building the multimodal agent (Track C) |
| [`TRANSIT_NEXT.md`](TRANSIT_NEXT.md) | finishing transit: surviving Overpass, pricing the wait, then bus |
| [`NYC_NAVIGATION_DATA.md`](NYC_NAVIGATION_DATA.md) | building the NYC static streets and building-shadow dataset |
| [`NYC_REMOTE_FIELD.md`](NYC_REMOTE_FIELD.md) | delivering the NYC remote shadow field to rendering and routing |
| [`SHADE_SIGNATURES.md`](SHADE_SIGNATURES.md) | compressing each sidewalk's year of shade into a signature and street type |
| [`DESIGN_LANGUAGE.md`](DESIGN_LANGUAGE.md) | running the UI & design-language wave (Track U) |

Finished handoffs are deleted rather than archived; git history keeps them. The current state
of every track is in its brief's `## Current state` block, not here.

**Every session, regardless:** `/gates` before any PR opens, `/checkpoint` before it is
reviewed, and never merge — that is the owner's call.
