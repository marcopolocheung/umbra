# `studies/` — offline measurement, quarantined on purpose

A study is code written to **answer a question and produce a note**, not to run in the app. It
is kept so the note's numbers can be re-derived; without it a note is an assertion.

Everything here is dead weight from the app's point of view, and that is the point. The rules
exist because dead weight that *touches* live code is worse than dead weight that does not.

## The contract

- **Nothing under `app/`, `api/`, `scripts/` or `e2e/` may import from `studies/`.** Not a
  module, not a constant. A study is a leaf.
- **A study may import from `app/`** — and should. Reading the canopy raster through
  `app/lib/canopyRaster/canopyCog.ts` is what makes A8c a measurement of the dataset *as Umbra
  sees it* rather than of a second implementation. The dependency runs study → app, never back.
- **A study never shares a module with anything that ships or generates something that ships.**
  Copy the code instead. `canopy-urban-confusion.mjs` carries its own copy of
  `scripts/canopy-acq-index.mjs`'s scanline fill for exactly this reason: that script
  regenerates `app/lib/canopyRaster/acqDateIndex.json`, which is in the bundle, so a shared
  module would let an edit made for a study change a committed artifact.
- **Every study has a note in `docs/notes/`**, and the note names the command that reproduces
  it. The note is the deliverable; this folder is the working.
- **Cache the network.** A study that re-hits a public host on every run is a study whose
  numbers move under it, and an imposition on whoever runs that host.

## Not covered by the gates

`npm run lint`, `npm run typecheck`, `npm test` and `npm run build` **do not see this folder**,
and never will: Biome's `files.includes` is `app/**`, `api/**`, `e2e/**`, `*.ts`, `*.mjs` —
where `*.mjs` is root-only — and `tsconfig.json` takes `.ts`, `.tsx` and `.mts`. A study can be
broken for months without CI noticing.

So: no clever abstractions, run it before you commit it, and prefer a copied forty lines to a
shared import every time.

## The studies

| | question | note |
|---|---|---|
| `canopy-urban-confusion.mjs` | Does the Meta/WRI CHM v2 canopy raster read *buildings* as canopy? (A8c, #279) | `docs/notes/canopy-urban-confusion-2026-09-10.md` |
| `canopy-paint-predicate.mjs` | Does building shadow stay detectable by `isBlueDominantShadowPixel` where it lands on A8f's canopy fill, on the real canvas? (A8f, #275) | `docs/notes/canopy-paint-2026-09-10.md` |
| `shade-preference/` | Can Melnikov 2022's hierarchical shade-preference logit be refit deterministically, reproduce β̄ ≈ 1.16, and beat its baselines on held-out choices? (S2a) | `docs/notes/shade-preference.md` |

## Not yet moved

`scripts/` still holds four studies that predate this folder — `canopy-census.mjs` (A7) and
`verify/shadow_truth.py`, `verify/wall_shadow_alignment.py`, `verify/shadow_readback.py` — sitting
beside two genuinely live files, `canopy-acq-index.mjs` (generates a shipped JSON) and
`mirror-guard.sh` (runs in CI on merge). Sweeping them is **#284**; it touches other tracks'
files and did not belong in the PR that created this folder.
