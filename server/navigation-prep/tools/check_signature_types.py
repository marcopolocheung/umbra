"""Phase-1 acceptance: the type counts read from a BUILT generation's signature
bytes (not the Python model) must equal signatures-v1's Midtown cross-tab.

Reads only `signatures/<cell>.bin` (the type byte of each 17-byte side),
`shades/<cell>.json` (row order) and `streets/*.json` (node coordinates), and
reproduces phase 0's orientation logic exactly (`~/umbra-phase0/maps.py`).

    NAVIGATION_PREP_ROOT=$HOME/shade-prep-data-nyc-navigation \
    ~/miniconda3/bin/python tools/check_signature_types.py <generation>
"""
import glob, json, math, os, sys
import numpy as np

# signatures-v1, labelled in Python on nyc-2026-09-18-393d4cd24a30's shade
# bytes. The built TypeScript projection must reproduce it exactly.
EXPECTED = {
    "street": [299, 185, 326, 306, 204, 949, 6347, 414],
    "avenue": [128, 250, 411, 526, 182, 816, 3808, 211],
}
# Phase 0 (#321, ~/umbra-phase0/orientation.json), from its multithreaded fit,
# whose centroids sit up to 0.019 from the reproducible single-threaded refit:
# 0.125% of Midtown sides change type. Reported, not asserted.
PHASE0 = {
    "street": [299, 184, 325, 306, 208, 950, 6345, 413],
    "avenue": [128, 250, 411, 524, 185, 814, 3809, 211],
}
GEN = sys.argv[1]
ROOT = os.path.join(os.environ["NAVIGATION_PREP_ROOT"], "normalized", GEN, "navigation", "nyc", GEN)
index = json.load(open(f"{ROOT}/signatures/index.json"))
PER_SIDE, K = index["bytesPerSide"], len(index["model"]["types"])
cells = {cell["key"]: cell for cell in index["cells"]}

coords = {}
for f in glob.glob(f"{ROOT}/streets/*.json"):
    for n in json.load(open(f))["nodes"]:
        coords[n["id"]] = (n["lon"], n["lat"])


def label_cell(key):
    segments = json.load(open(f"{ROOT}/shades/{key}.json"))["segments"]
    raw = np.fromfile(f"{ROOT}/{cells[key]['payloadKey']}", dtype=np.uint8).reshape(len(segments) * 2, PER_SIDE)
    return segments, raw[:, -1].reshape(len(segments), 2)


def bbox_cells(w, s, e, n):
    out = []
    for key in cells:
        b = json.load(open(f"{ROOT}/shades/{key}.json"))["geometryBounds"]
        if b["west"] < e and b["east"] > w and b["south"] < n and b["north"] > s:
            out.append(key)
    return out


tab = {kind: np.zeros(K, int) for kind in EXPECTED}
for key in bbox_cells(-74.00, 40.74, -73.96, 40.77):
    segments, labels = label_cell(key)
    for (lo_id, hi_id), (cl, cr) in zip(segments, labels):
        if lo_id not in coords or hi_id not in coords:
            continue
        (lo0, la0), (lo1, la1) = coords[lo_id], coords[hi_id]
        dx = (lo1 - lo0) * math.cos(math.radians(la0))
        dy = la1 - la0
        if math.hypot(dx, dy) < 2e-4:
            continue
        bearing = (math.degrees(math.atan2(dx, dy)) + 360) % 180
        kind = "avenue" if abs(bearing - 29) < 15 else "street" if abs(bearing - 119) < 15 else None
        if kind:
            tab[kind][cl] += 1
            tab[kind][cr] += 1

ok = True
for kind, expected in EXPECTED.items():
    got = tab[kind].tolist()
    share = " ".join(f"{t}:{v / sum(got):.1%}" for t, v in enumerate(got))
    moved = sum(abs(a - b) for a, b in zip(got, PHASE0[kind])) // 2
    print(f"{kind:7s} built    {got}\n        expected {expected}\n        phase 0  {PHASE0[kind]} "
          f"(≥{moved} of {sum(got)} sides moved)\n        shares   {share}")
    ok &= got == expected
print("MATCH" if ok else "DIFFERS")
sys.exit(0 if ok else 1)
