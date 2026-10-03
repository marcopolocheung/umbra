#!/usr/bin/env node
/**
 * S1 stage 2 — build the LiDAR truth surface for each block.
 *
 * From the 2017 1-ft classified LAZ tiles (stage 1) we build, per block:
 *
 * - a **highest-hit surface** grid: for every cell, the maximum Z of any
 *   point in it (buildings, trees, whatever the beam hit first — this is the
 *   NYC OTI "Highest Hit DSM" definition, built locally so the exact tile
 *   bytes are the provenance);
 * - a **bare-earth** grid: per cell the median Z of ground-classified points
 *   (class 2), with nearest-ground fill for cells no ground point landed in;
 * - both at 1 m cells in a local east/north metre frame anchored to the block
 *   centre (EPSG:2263 converted per point), which is what the marcher consumes.
 *
 * Vectorized numpy (np.maximum.at / np.ufunc.at) — the point clouds are 1–17 M
 * points per tile and a per-point Python loop is minutes per tile.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");

const CELL_M = 1.0;
const HALF_M = 125;
/**
 * Truth-surface padding. Must exceed the receivers' own extent from the block
 * centre (±129 m with sidewalk offsets) plus the march cap (400 m), so a
 * truth ray never runs off the surface before its cap: 529 m + margin.
 */
const PAD_M = 550;

export function main() {
  const { blocks } = JSON.parse(readFileSync(join(HERE, "blocks.json"), "utf8"));
  const plan = JSON.parse(readFileSync(join(CACHE, "acquisition.json"), "utf8"));
  for (const block of blocks) {
    const stem = join(CACHE, "lidar-surface", block.slug);
    if (existsSync(`${stem}-top.bin`) && existsSync(`${stem}-ground.bin`) && existsSync(`${stem}.json`)) {
      process.stderr.write(`lidar-surface: ${block.slug} cached\n`);
      continue;
    }
    mkdirSync(join(CACHE, "lidar-surface"), { recursive: true });
    const lazPaths = plan[block.slug].laz.map((t) => join(CACHE, "lidar", `${t.id}.laz`));
    const script = `
import json
import laspy
import numpy as np
from rasterio.warp import transform as wt

CELL_M, HALF_M, PAD_M = ${CELL_M}, ${HALF_M}, ${PAD_M}
CLNG, CLAT = ${block.lng}, ${block.lat}

cx, cy = wt("EPSG:4326", "EPSG:2263", [CLNG], [CLAT])
cx, cy = float(cx[0]), float(cy[0])
ft = 1200 / 3937  # US survey foot -> metres

EXT = HALF_M + PAD_M
N = int(2 * EXT / CELL_M)
top = np.full(N * N, -np.inf, dtype=np.float32)
ground = np.full(N * N, np.nan, dtype=np.float32)
ground_n = np.zeros(N * N, dtype=np.int32)
ground_sum = np.zeros(N * N, dtype=np.float64)

for path in ${JSON.stringify(lazPaths)}:
    las = laspy.read(path)
    x = np.asarray(las.x) * ft - cx * ft   # metres east of centre
    y = np.asarray(las.y) * ft - cy * ft   # metres north of centre
    z = np.asarray(las.z) * ft             # metres (NAVD88)
    # LAS class 7 is low/high noise (birds, aircraft: |z| hundreds of metres).
    # It never shadows anything real, and the city's own DSM products drop it.
    cls = np.asarray(las.classification)
    usable = (cls != 7) & (np.abs(z) < 400)
    inside = usable & (np.abs(x) < EXT) & (np.abs(y) < EXT)
    col = ((x[inside] + EXT) / CELL_M).astype(np.int64)
    row = ((EXT - y[inside]) / CELL_M).astype(np.int64)  # row 0 = north
    idx = row * N + col
    np.maximum.at(top, idx, z[inside])
    g = (cls[inside] == 2)
    if g.any():
        gi = idx[g]
        np.add.at(ground_sum, gi, z[inside][g])
        np.add.at(ground_n, gi, 1)

have = ground_n > 0
ground[have] = (ground_sum[have] / ground_n[have]).astype(np.float32)
finite = np.isfinite(top) & (top > -1e6)
top[~finite] = np.nan

# Nearest-valid-ground fill for cells without a ground point.
from scipy.spatial import cKDTree
if have.any():
    g2 = ground.copy()
    rows, cols = np.mgrid[0:N, 0:N]
    ok = have.reshape(N, N)
    pts = np.stack([rows[ok], cols[ok]], axis=1)
    tree = cKDTree(pts)
    q = np.stack([rows.ravel(), cols.ravel()], axis=1)
    _, ii = tree.query(q)
    vals = g2.reshape(N, N)[ok]
    g2 = vals[ii].reshape(N, N)
else:
    raise SystemExit("no ground points in block")

top.reshape(N, N).astype(np.float32).tofile("${stem}-top.bin")
g2.astype(np.float32).tofile("${stem}-ground.bin")
json.dump({"n": N, "cellM": CELL_M, "extM": EXT, "centre": [CLNG, CLAT],
           "laz": [p.split("/")[-1] for p in ${JSON.stringify(lazPaths)}],
           "topHoleCells": int((~finite).sum()),
           "groundFilledCells": int((~have).sum())},
          open("${stem}.json", "w"))
print("ok", N)
`;
    execFileSync("python3", ["-c", script], { stdio: ["ignore", "pipe", "inherit"] });
    process.stderr.write(`lidar-surface: ${block.slug} built\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("20-lidar-surface.mjs")) main();
