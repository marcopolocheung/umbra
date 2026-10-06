# Browser verification

`npm test` runs under `environment: "node"` and never executes a browser. Shadow
rendering, timeline drag, end-to-end route calculation, the streaming preview and the
GeoTIFF export are untested by the four gates and always have been. Issue #121 recorded
that as impossible on this machine. **It is not.**

Two things now cover part of it: `npm run e2e`, a Playwright smoke test that runs in CI on
every PR, and the hand-run Python scripts below. This note is about the second.

## Running Chromium here

Playwright's cached Chromium fails to start because `libnss3`, `libnspr4`, `libnssutil3`,
`libsmime3` and `libasound.so.2` are missing, and there is no passwordless sudo. Every one
of those ships inside the miniconda install that is already present, so pointing the loader
at it is enough — no downloads, no root:

```bash
LD_LIBRARY_PATH=$HOME/miniconda3/lib \
  ~/.cache/ms-playwright/chromium_headless_shell-1169/chrome-linux/headless_shell --version
# Chromium 136.0.7103.25
```

On a sudo-less box *without* miniconda, the older route still works: download the `libnss3`,
`libnspr4` and `libasound2` debs, `dpkg-deb -x` them into a scratch directory, and point
`LD_LIBRARY_PATH` at its `usr/lib/x86_64-linux-gnu`.

WebGL needs a software rasteriser, since WSL exposes no GPU:

```
--use-angle=swiftshader --enable-unsafe-swiftshader
```

## Why Python, and why not in CI

These scripts predate `npm run e2e` and are written against `~/miniconda3/bin/playwright`.
`node_modules` now has `@playwright/test` too — the smoke test uses it, and it renders on the
same SwiftShader path in CI, so "no GPU in CI" is no longer the obstacle it was. What keeps
these particular scripts out is what they are: exploratory probes that print numbers for a
human to read, not assertions. Porting them would mean deciding what each one should assert.

So `scripts/verify/` stays deliberately outside `vitest.config.ts`'s glob and outside Biome's
targets. It is a tool you run by hand, before a PR that changes what the map draws.

## The scripts

- **`scripts/verify/shadow_readback.py`** — proves route shadow does not depend on camera
  pitch (#154). Calculates the same route flat and tilted and compares the shadow percentages
  the route cards report; also checks the camera went flat for the readback and got its tilt
  back afterwards.
- **`scripts/verify/wall_shadow_alignment.py`** — compares Pass E before and after a wall
  ceiling-threshold change in a fixed Tribeca scene. Its diagnostic framebuffer writes the
  shadowed decision to red, roof/wall to green, sun-facing status to blue, and zero alpha for
  every Pass E fragment. A fully covered building pixel therefore has `A == 0`; a valid
  ground probe has `A == 255`, and no pixel between it and the wall may have `A == 0`.
  The disagreement metric skips the one- or two-pixel MSAA silhouette fringe rather than
  classifying it. A separate strict count requires every intervening pixel to have
  `A == 255`; that count must clear the sample-size gate.
  The map renders without MSAA (`antialias: false` in `MapView.tsx`), so today that fringe
  is empty and both counts see the same probes.

Run them against a dev server:

```bash
npm run dev &
LD_LIBRARY_PATH=$HOME/miniconda3/lib \
  ~/miniconda3/bin/python scripts/verify/shadow_readback.py --out out/
```

Screenshots and a JSON report land in `--out` (gitignored). Put the numbers in the PR body;
do not commit the PNGs.

### Wall/ground terminator comparison

Capture the baseline from an unmodified `main` server before starting the feature server.
The verifier fixes the viewport at 1200×900, timezone at `America/New_York`, pitch at 55°,
bearing at 0°, and the scene URL at z17 in Tribeca; it also rejects a comparison whose
recorded configuration differs. Because strict alpha rejection leaves relatively few whole
pixels exactly at an antialiased silhouette, each run aggregates six deterministic subpixel
raster phases of that same camera; no blended pixel is admitted as either wall or ground.
Repeat the pair three times to rule out a lucky tile or rendering frame:

```bash
# Terminal 1, from an unmodified main worktree
npm run dev -- --host 127.0.0.1 --port 5173

# Terminal 2, from the feature worktree
for run in 1 2 3; do
  LD_LIBRARY_PATH=$HOME/miniconda3/lib \
    ~/miniconda3/bin/python scripts/verify/wall_shadow_alignment.py \
      --url http://127.0.0.1:5173 --out out/wall-shadow --tag before-$run
done

# Stop the main server, then start the feature server on the identical host and port.
npm run dev -- --host 127.0.0.1 --port 5173

for run in 1 2 3; do
  LD_LIBRARY_PATH=$HOME/miniconda3/lib \
    ~/miniconda3/bin/python scripts/verify/wall_shadow_alignment.py \
      --url http://127.0.0.1:5173 --out out/wall-shadow --tag after-$run \
      --baseline out/wall-shadow/before-$run.json
done
```

Every baseline and comparison requires at least 10,000 Pass E pixels, 1,000 wall pixels,
and 1,000 strict wall-base samples whose entire probe path has `A == 255`. Every comparison
additionally requires exactly zero
lit→shadowed flips, exactly zero roof differences, a shadowed→lit fraction from 0.3% through
2.0% of compared Pass E pixels, and a wall-base disagreement rate at least 0.2 percentage
points below its paired baseline. The lower flip bound catches a no-op; the upper bound
catches a lift mistakenly applied to whole faces.

### Ray-traced ground truth (`shadow_truth.py`)

The two verifiers above compare a frame with *another frame*. This one compares a frame
with geometry: it asks the page for the prisms the renderer just used, ray-traces them
itself, and diffs the two answers per pixel. Use it when the complaint is "the shadow looks
wrong" and you need to know where and by how much, rather than whether one build differs
from another.

```bash
npm run dev &

LD_LIBRARY_PATH=$HOME/miniconda3/lib \
  ~/miniconda3/bin/python scripts/verify/shadow_truth.py \
    --url http://localhost:5173 --out out/shadow-truth --tag before --step 2

# after the change, same scene and camera:
LD_LIBRARY_PATH=$HOME/miniconda3/lib \
  ~/miniconda3/bin/python scripts/verify/shadow_truth.py \
    --url http://localhost:5173 --out out/shadow-truth --tag after --step 2 \
    --baseline out/shadow-truth/before.json
```

It prints a wrong-pixel fraction per surface — ground, wall, roof — split by direction
(`lit-where-shadowed` versus `shadowed-where-lit`), and writes three images: the traced truth,
the renderer's decision, and a mismatch mask on black. The mask is the point: a defect that
is invisible in a log shows up there as a shape. Cyan/magenta blobs hugging vertical building
edges read differently from one filling a whole roof, and that difference is what tells the
two known failure modes apart.

`--step 2` samples every second pixel and runs about four times faster; a dense scene at
`--step 1` takes a few minutes. `--lat/--lng/--zoom/--pitch/--bearing/--date/--time` move the
scene. Needs `numpy` and `pillow` as well as playwright.

Read the numbers with its limits in mind. The truth is the renderer's own geometry traced
exactly, so it validates the shaders, not the buildings — a pixel the two disagree about the
*identity* of is excluded and counted as `surfaceMismatch`. Ground pixels are classified with
`isBlueDominantShadowPixel`, so they carry that predicate's noise over a coloured basemap;
wall and roof pixels do not, because the building pass is patched to state its decision in
the alpha channel. Treat a couple of percent as the floor: silhouette pixels and the field's
own raster resolution live there.

## What still cannot be checked

Nothing here measures whether the shadow numbers are *right* against the real world — only
whether they are self-consistent, or consistent with the geometry the renderer was handed.
Real accuracy needs the pixel sampler's answer recorded over real cities against surveyed
ground truth, which no fixture in this repo has.
