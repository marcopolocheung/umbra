"""Fit the frozen shade-signature model (signatures-v1) from a built shade table.

Run once, on a deliberate version bump, never per build. The build projects
with the committed JSON this writes (`models/signatures-v1.json`); it never
refits, so type ids stay meaningful across generations.

The fit is phase 0's (#321, docs/handoffs/SHADE_SIGNATURES.md), step for step,
so the frozen types are the ones phase 0 reported and mapped:

1. daylight slots: union of not-all-255 slots over 60 seeded-random cells;
2. a 200k sample of sidewalk sides, stratified by cell (seeded);
3. centre per slot, PCA to 32 components (kept: the first 16);
4. k-means, K = 8, on the 16-number signature.

It also writes the int8 quantization scales and the hermetic parity fixture
the TypeScript projection is tested against (`test/fixtures/`).

Pinned: numpy 2.2.3, scikit-learn 1.9.0, seed 20261008, generation
nyc-2026-09-18-393d4cd24a30 (386 cells, 1,608,171 segments).

    NAVIGATION_PREP_ROOT=$HOME/shade-prep-data-nyc-navigation \
    ~/miniconda3/bin/python -W ignore tools/fit_signatures.py nyc-2026-09-18-393d4cd24a30

~30 seconds, ~2.5 GB peak; reruns write identical bytes.
"""
import base64, glob, json, os, sys

# One thread: k-means' multithreaded reductions otherwise move the centres by
# ~3e-7 run to run, and the committed model must reproduce byte for byte.
for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[var] = "1"

import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA

VERSION = "signatures-v1"
SEED = 20261008
SAMPLE = 200_000
COMPONENTS = 16
K = 8
SLOTS = 768
HERE = os.path.dirname(os.path.abspath(__file__))
GEN = sys.argv[1]
ROOT = os.path.join(os.environ["NAVIGATION_PREP_ROOT"], "normalized", GEN, "navigation", "nyc", GEN)
rng = np.random.default_rng(SEED)

cells = sorted(p[:-5] for p in glob.glob(f"{ROOT}/shades/*.json"))
counts = {c: len(json.load(open(c + ".json"))["segments"]) for c in cells}


def payload(c):
    return np.fromfile(c + ".bin", dtype=np.uint8).reshape(SLOTS, counts[c], 2)


# ── 1. Daylight slots ─────────────────────────────────────────────────────────
daylight = np.zeros(SLOTS, bool)
for c in rng.choice(cells, size=60, replace=False):
    daylight |= ~(payload(c) == 255).all(axis=(1, 2))
DAY = np.nonzero(daylight)[0]


def sides(c):
    """(2n, D) uint8; side order = [left of segment 0, right of segment 0, …]."""
    n = counts[c]
    return payload(c)[DAY].transpose(1, 2, 0).reshape(n * 2, DAY.size)


# ── 2. Stratified sample ─────────────────────────────────────────────────────
per_cell = max(1, SAMPLE // len(cells))
rows = []
for c in cells:
    x = sides(c)
    rows.append(x[rng.choice(x.shape[0], size=min(per_cell, x.shape[0]), replace=False)])
S = np.concatenate(rows).astype(np.float32) / 255.0
del rows

# ── 3. Centre + PCA, 4. k-means ──────────────────────────────────────────────
mean = S.mean(axis=0)
pca = PCA(n_components=32, random_state=SEED).fit(S - mean)
Z = pca.transform(S - mean)[:, :COMPONENTS]
km = KMeans(n_clusters=K, n_init=4, random_state=SEED).fit(Z)


def f32(values):
    """Shortest decimal that round-trips the float32 — the build parses these."""
    return [float(np.format_float_positional(np.float32(v), unique=True)) for v in np.ravel(values)]


frozen_mean = np.array(f32(mean))
frozen_components = np.array(f32(pca.components_[:COMPONENTS])).reshape(COMPONENTS, DAY.size)
frozen_centers = np.array(f32(km.cluster_centers_)).reshape(K, COMPONENTS)


def project(x_bytes):
    """The reference projection the TS build must reproduce, in float64 on the frozen values."""
    z = (x_bytes.astype(np.float64) / 255.0 - frozen_mean) @ frozen_components.T
    d = ((z[:, None, :] - frozen_centers[None, :, :]) ** 2).sum(-1)
    return z, d.argmin(1)


# int8 scale per component: the largest |z| any input can reach. Each slot is
# 0..1, so the extremes are the two sign-matched corners of the unit cube; no
# input can clamp. The step costs ~0.09 of signature distance, against a
# typical 10th-neighbour distance of ~3.
upper = np.where(frozen_components > 0, frozen_components * (1 - frozen_mean), -frozen_components * frozen_mean).sum(1)
lower = np.where(frozen_components > 0, frozen_components * frozen_mean, -frozen_components * (1 - frozen_mean)).sum(1)
scales = f32(np.maximum(upper, lower) / 127.0)

# ── Readable names: phase 0's, from each type's mean profile on the sample ───
labels = project((S * 255).round().astype(np.uint8))[1]
SEASONS = {"winter": [11, 0, 1], "summer": [5, 6, 7]}


def hhmm(slot):
    h, mm = divmod(5 * 60 + slot * 15, 60)
    return f"{(h - 1) % 12 + 1}{'' if mm == 0 else ':%02d' % mm}{'am' if h < 12 else 'pm'}"


def clock(slot):
    h, mm = divmod(5 * 60 + slot * 15, 60)
    return f"{h:02d}:{mm:02d}"


def windows(mask):
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        if (not v or i == len(mask) - 1) and start is not None:
            end = i if v else i - 1
            if end - start >= 3:
                out.append((start, end + 1))
            start = None
    return out


def describe(members):
    g = np.full(SLOTS, np.nan)
    g[DAY] = members.mean(axis=0)
    g = g.reshape(12, 64)
    overall = float(np.nanmean(g))
    summer, winter = float(np.nanmean(g[SEASONS["summer"]])), float(np.nanmean(g[SEASONS["winter"]]))
    s_day = np.nanmean(g[SEASONS["summer"]], axis=0)
    # Drop the first and last hour of summer daylight: a sun a few degrees up
    # shades everything and says nothing about the street.
    lit = np.nonzero(~np.isnan(s_day))[0]
    core = np.zeros(64, bool)
    core[lit.min() + 4: lit.max() - 3] = True
    shade_w = windows([core[i] and v >= 0.7 for i, v in enumerate(s_day)])
    sun_w = windows([core[i] and v <= 0.3 for i, v in enumerate(s_day)])
    parts = []
    if overall >= 0.85:
        parts.append("nearly always shaded")
    elif overall <= 0.15:
        parts.append("nearly always sunny")
    else:
        if shade_w:
            parts.append("summer shade " + ", ".join(f"{hhmm(a)}–{hhmm(b)}" for a, b in shade_w))
        if sun_w:
            parts.append("summer sun " + ", ".join(f"{hhmm(a)}–{hhmm(b)}" for a, b in sun_w))
        if not parts:
            parts.append(f"mixed ({overall:.0%} shaded)")
    if winter - summer >= 0.2:
        parts.append(f"much shadier in winter ({winter:.0%} vs {summer:.0%})")
    return {
        "name": f"{overall:.0%} shaded overall; " + "; ".join(parts),
        "shaded": round(overall, 3),
        "summerShaded": round(summer, 3),
        "winterShaded": round(winter, 3),
        "summerShade": [[clock(a), clock(b)] for a, b in shade_w],
        "summerSun": [[clock(a), clock(b)] for a, b in sun_w],
    }


types = [{"id": t, **describe(S[labels == t])} for t in range(K)]

model = {
    "version": VERSION,
    "fit": {
        "generation": GEN,
        "seed": SEED,
        "sample": int(S.shape[0]),
        "libraries": {"numpy": np.__version__, "scikit-learn": __import__("sklearn").__version__},
        "varianceExplained": round(float(pca.explained_variance_ratio_[:COMPONENTS].sum()), 4),
    },
    "daySlots": [int(s) for s in DAY],
    "mean": f32(frozen_mean),
    "components": [f32(row) for row in frozen_components],
    "scales": scales,
    "centers": [f32(row) for row in frozen_centers],
    "types": types,
}
with open(os.path.join(HERE, "..", "models", f"{VERSION}.json"), "w") as out:
    json.dump(model, out, ensure_ascii=False, separators=(",", ":"))
    out.write("\n")

# ── Parity fixture: 3 real segments per type from one dense Midtown cell ─────
cell = f"{ROOT}/shades/z14-4824-6157"
x = sides(cell)
_, t = project(x)
picked = sorted({int(i) // 2 for k in range(K) for i in np.nonzero(t == k)[0][:3]})
fixture_payload = payload(cell)[:, picked, :]  # (768, m, 2), still slot-major
z, t = project(fixture_payload[DAY].transpose(1, 2, 0).reshape(len(picked) * 2, DAY.size))
q = np.clip(np.floor(z / np.array(scales) + 0.5), -127, 127).astype(int)
fixture = {
    "source": f"{GEN} shades/z14-4824-6157, segment columns {picked}",
    "segments": len(picked),
    "payloadBase64": base64.b64encode(np.ascontiguousarray(fixture_payload).tobytes()).decode(),
    "expected": {"z": [[round(float(v), 9) for v in row] for row in z], "q": q.tolist(), "types": t.tolist()},
}
with open(os.path.join(HERE, "..", "test", "fixtures", "signatures-parity.json"), "w") as out:
    json.dump(fixture, out, separators=(",", ":"))
    out.write("\n")

print(json.dumps({"daySlots": int(DAY.size), "sample": S.shape, "types": [ty["name"] for ty in types],
                  "fixtureSegments": len(picked), "fixtureTypes": sorted(set(t.tolist()))}, indent=1))
