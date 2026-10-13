"""Offline A3 feasibility, adapted from Phase 0's signatures.py and maps.py.

Reuses their slot-major -> sidewalk-row loading, cell-stratified sampling and
neighbour-fidelity metrics, with sklearn's brute pairwise distances. Changes:
read the FROZEN published int8 signatures; never refit; exclude self by identity;
use deterministic ties; test local radius-filtered pools as well as a stratified
city reference; record the current slot-major transport cost.

NAVIGATION_PREP_ROOT=~/shade-prep-data-nyc-navigation ~/miniconda3/bin/python \
  tools/benchmark_signature_rerank.py nyc-2026-09-18-e6718823bbb3 \
  --output ~/umbra-signature-benchmark

Arrays and query details stay outside the repo. --reuse-cache skips verified
input decoding when manifest/index hashes match. No app/pipeline changes.
"""
import argparse
import hashlib
import json
import math
import os
import platform
import resource
import time
from pathlib import Path

for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[name] = "4"

import numpy as np
import scipy
import sklearn
from scipy.spatial.distance import cdist
from sklearn.metrics.pairwise import euclidean_distances
from threadpoolctl import threadpool_limits

SEED = 20261012
SHORTLISTS = (10, 25, 50, 100, 200, 500, 1000)
START = time.perf_counter()


def log(message):
    print(f"[{time.perf_counter() - START:7.1f}s] {message}", flush=True)


def verified(path, ref):
    raw = path.read_bytes()
    assert len(raw) == ref["bytes"] and hashlib.sha256(raw).hexdigest() == ref["sha256"], str(path)
    return raw


def distances_bytes(query, rows):
    """Float64 integer-byte dot products remain exact, including distance ties.

    Mean centring cancels in L2 distance; dividing by 255 only changes units.
    Unlike Phase 0's float32 fractions, every squared distance here is integral.
    """
    out = euclidean_distances(np.asarray(query, dtype=np.float64), np.asarray(rows, dtype=np.float64), squared=True)
    assert np.all(out == np.rint(out)), "byte distance lost integer precision"
    return out


def ordered_top(distances, ids, k, exclude=None):
    """Stable (distance, global row ID) order, explicitly removing the query.

    Argpartition finds the boundary cheaply; resolve all boundary ties by ID,
    rather than assuming a brute-kNN library puts self first among duplicates.
    """
    keep = np.isfinite(distances) & (ids != exclude if exclude is not None else True)
    positions = np.flatnonzero(keep)
    k = min(k, len(positions))
    if not k:
        return positions
    values = distances[positions]
    boundary = np.partition(values, k - 1)[k - 1]
    less = positions[values < boundary]
    equal = positions[values == boundary]
    equal = equal[np.argsort(ids[equal], kind="stable")][:k - len(less)]
    chosen = np.concatenate((less, equal))
    return chosen[np.lexsort((ids[chosen], distances[chosen]))]


def metrics(exact, ids, query_id, shortlist):
    truth = ordered_top(exact, ids, 10, query_id)
    returned = shortlist[ordered_top(exact[shortlist], ids[shortlist], len(truth), query_id)]
    strict = len(np.intersect1d(ids[truth], ids[returned])) / len(truth)
    d10 = exact[truth[-1]]
    tie_aware = float(np.mean(exact[returned] <= d10))
    within = float(np.mean(exact[returned] <= d10 * 1.1 ** 2))
    true_mean = np.sqrt(exact[truth]).mean()
    returned_mean = np.sqrt(exact[returned]).mean()
    ratio = returned_mean / true_mean if true_mean else (1.0 if not returned_mean else None)
    return {"recall10": strict, "tie_aware10": tie_aware, "within_1_1x": within,
            "distance_ratio": ratio, "zero_truth": bool(true_mean == 0),
            "zero_truth_missed": bool(true_mean == 0 and returned_mean > 0),
            "boundary_ties": int(np.sum((exact == d10) & (ids != query_id))),
            "k": len(truth)}


def haversine(lnglat, centre):
    a = np.radians(lnglat)
    b = np.radians(centre)
    d = a - b
    h = np.sin(d[:, 1] / 2) ** 2 + np.cos(a[:, 1]) * math.cos(b[1]) * np.sin(d[:, 0] / 2) ** 2
    return 6371000 * 2 * np.arctan2(np.sqrt(h), np.sqrt(np.maximum(0, 1 - h)))


def selected_cells(cells, point, radius):
    # remoteNavigation.zoneAround/expandBounds, same constants and intersection.
    x, y = point
    dy = radius / 111320
    dx = dy / max(math.cos(math.radians(y)), .2)
    return [c for c in cells if c["bounds"]["west"] <= x + dx and c["bounds"]["east"] >= x - dx
            and c["bounds"]["south"] <= y + dy and c["bounds"]["north"] >= y - dy]


def prepare(root, output, reuse):
    manifest_raw = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_raw)
    index_raw = verified(root / manifest["signatures"]["key"], manifest["signatures"])
    index = json.loads(index_raw)
    assert index["generation"] == manifest["generation"] and index["bytesPerSide"] == 17
    model = index["model"]
    day = np.array(model["daySlots"], dtype=np.int64)
    assert len(day) == 581 and np.all(day[1:] > day[:-1])
    fingerprints = {"manifest": hashlib.sha256(manifest_raw).hexdigest(), "index": hashlib.sha256(index_raw).hexdigest()}
    cache = output / manifest["generation"]
    cache.mkdir(parents=True, exist_ok=True)
    meta_path = cache / "inventory.json"
    shapes = {"annual": (np.uint8, (sum(c["segments"] for c in index["cells"]) * 2, len(day))),
              "vectors": (np.float32, (sum(c["segments"] for c in index["cells"]) * 2, 16)),
              "projection": (np.float64, (sum(c["segments"] for c in index["cells"]) * 2, 16)),
              "midpoints": (np.float64, (sum(c["segments"] for c in index["cells"]), 2)),
              "lengths": (np.float64, (sum(c["segments"] for c in index["cells"]),))}
    if reuse and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        assert meta["fingerprints"] == fingerprints, "cache belongs to different bytes"
        arrays = {name: np.load(cache / f"{name}.npy", mmap_mode="r") for name in shapes}
        for name, (dtype, shape) in shapes.items():
            assert arrays[name].dtype == dtype and arrays[name].shape == shape
        log(f"reused verified decoding cache: {len(meta['cells'])} cells")
        return manifest, index, meta, arrays, cache
    arrays = {name: np.lib.format.open_memmap(cache / f"{name}.npy", mode="w+", dtype=dtype, shape=shape)
              for name, (dtype, shape) in shapes.items()}
    shade_refs = {ref["key"]: ref for ref in manifest["shadeShards"]}
    street_refs = {ref["key"]: ref for ref in manifest["streetShards"]}
    means = np.array(model["mean"], dtype=np.float64)
    components = np.array(model["components"], dtype=np.float64)
    scales = np.array(model["scales"], dtype=np.float64)
    cells, start, moved = [], 0, 0
    for ci, cell in enumerate(sorted(index["cells"], key=lambda c: c["key"])):
        shade_ref = shade_refs[cell["shadeKey"]]
        shade = json.loads(verified(root / cell["shadeKey"], shade_ref))
        street_key = cell["shadeKey"].replace("shades/", "streets/", 1)
        street = json.loads(verified(root / street_key, street_refs[street_key]))
        segments = shade["segments"]
        n = len(segments)
        assert n == cell["segments"] and shade["generation"] == manifest["generation"]
        # Phase 0 load_cell/sides, using frozen daySlots rather than re-inference.
        raw = verified(root / shade["payload"]["key"], shade["payload"])
        x = np.frombuffer(raw, dtype=np.uint8).reshape(768, n, 2)[day].transpose(1, 2, 0).reshape(n * 2, len(day))
        packed = np.frombuffer(verified(root / cell["payloadKey"], cell), dtype=np.uint8).reshape(n * 2, 17)
        z = (x.astype(np.float64) / 255 - means) @ components.T
        codes = packed[:, :16].view(np.int8)
        moved += int(np.count_nonzero(codes != np.floor(z / scales + .5)))
        end = start + n * 2
        arrays["annual"][start:end] = x
        arrays["vectors"][start:end] = (codes.astype(np.float64) * scales).astype(np.float32)
        arrays["projection"][start:end] = z
        # Phase 0 maps/check_signature_types node join; retain midpoint eligibility.
        coords = {node["id"]: (node["lon"], node["lat"]) for node in street["nodes"]}
        a = np.array([coords[lo] for lo, hi in segments])
        b = np.array([coords[hi] for lo, hi in segments])
        lengths = {}
        for edge in street["edges"]:
            pair = (min(edge["from"], edge["to"]), max(edge["from"], edge["to"]))
            lengths[pair] = min(lengths.get(pair, math.inf), edge["distanceM"])
        arrays["midpoints"][start // 2:end // 2] = (a + b) / 2
        arrays["lengths"][start // 2:end // 2] = [lengths[tuple(pair)] for pair in segments]
        cells.append({"key": cell["key"], "start": start, "end": end, "segments": n,
                      "bounds": shade["geometryBounds"], "street_bytes": street_refs[street_key]["bytes"],
                      "shade_index_bytes": shade_ref["bytes"], "signature_bytes": cell["bytes"]})
        start = end
        if ci % 40 == 0:
            log(f"decoded {ci + 1}/{len(index['cells'])} cells; {end:,} sides")
    assert moved == 0, f"{moved} codes disagree with frozen model projection"
    for array in arrays.values():
        array.flush()
    meta = {"fingerprints": fingerprints, "cells": cells, "projection_code_mismatches": moved}
    meta_path.write_text(json.dumps(meta))
    log(f"verified {start:,} published sides; quantization matches frozen projection")
    return manifest, index, meta, arrays, cache


def queries_for(cells, arrays, rng, per_cell, spacing, cap):
    chosen, positions = [], []
    for ci in rng.permutation(len(cells)):
        cell = cells[ci]
        segments = np.arange(cell["start"] // 2, cell["end"] // 2)
        eligible = segments[arrays["lengths"][segments] >= 15]
        accepted = 0
        for segment in rng.permutation(eligible)[:500]:
            position = arrays["midpoints"][segment]
            if positions and np.any(haversine(np.array(positions), position) < spacing):
                continue
            chosen.append({"row": int(segment * 2 + rng.integers(2)), "cell": int(ci)})
            positions.append(position.tolist())
            accepted += 1
            if accepted >= per_cell or len(chosen) >= cap:
                break
        if len(chosen) >= cap:
            break
    return sorted(chosen, key=lambda q: q["row"])


def summarize(records):
    result = {}
    for field in ("recall10", "tie_aware10", "within_1_1x"):
        result[field] = float(np.mean([r[field] for r in records]))
    ratios = [r["distance_ratio"] for r in records if r["distance_ratio"] is not None]
    nonzero = [r["distance_ratio"] for r in records if not r["zero_truth"]]
    result["median_distance_ratio_nonzero_truth"] = float(np.median(nonzero)) if nonzero else None
    result["p95_distance_ratio_nonzero_truth"] = float(np.quantile(nonzero, .95)) if nonzero else None
    recalls = np.array([r["recall10"] for r in records])
    result.update(min_recall10=float(recalls.min()), queries_below_0_95=int(np.sum(recalls < .95)),
                  fraction_below_0_95=float(np.mean(recalls < .95)))
    result.update(queries=len(records), median_distance_ratio=float(np.median(ratios)),
                  zero_truth_queries=sum(r["zero_truth"] for r in records),
                  zero_truth_missed=sum(r["zero_truth_missed"] for r in records),
                  boundary_tie_queries=sum(r["boundary_ties"] > 1 for r in records),
                  full_top10_queries=sum(r["k"] == 10 for r in records))
    # Resample cells, not neighbouring sides independently.
    groups = sorted(set(r["cell"] for r in records))
    counts = np.array([sum(r["cell"] == c for r in records) for c in groups])
    sums = np.array([sum(r["recall10"] for r in records if r["cell"] == c) for c in groups])
    draw = np.random.default_rng(SEED).integers(len(groups), size=(1000, len(groups)))
    bootstrap = sums[draw].sum(1) / counts[draw].sum(1)
    result["recall10_cell_bootstrap_ci95"] = np.quantile(bootstrap, [.025, .975]).tolist()
    return result


def shortlist_transport(cells, ids, query_id, day_slots):
    owners = np.searchsorted([c["end"] for c in cells], np.r_[ids, query_id], side="right")
    selected = [cells[int(i)] for i in np.unique(owners)]
    runs = 1 + int(np.count_nonzero(np.diff(day_slots) != 1))
    return {"annual_cells_after_shortlist": len(selected),
            "annual_bytes_after_shortlist": sum(c["segments"] * 2 * len(day_slots) for c in selected),
            "annual_requests_after_shortlist": len(selected) * runs,
            "ideal_candidate_bytes": (len(ids) + 1) * len(day_slots)}


def measure_pool(exact, ids, qid, vectors, projection, query_vector, query_projection, cell, storage, cells, day_slots):
    out = {"stored": {}, "float": {}}
    for mode, matrix, query in (("stored", vectors, query_vector), ("float", projection, query_projection)):
        d = cdist(query[None].astype(np.float64), np.asarray(matrix, dtype=np.float64), metric="sqeuclidean")[0]
        ranked = ordered_top(d, ids, max(SHORTLISTS), qid)
        for size in SHORTLISTS:
            value = metrics(exact, ids, qid, ranked[:size])
            value.update(query_id=qid, cell=cell, **storage, **shortlist_transport(cells, ids[ranked[:size]], qid, day_slots))
            out[mode][size] = value
    return out


def run(args):
    root = Path(os.environ["NAVIGATION_PREP_ROOT"]).expanduser() / "normalized" / args.generation / "navigation" / "nyc" / args.generation
    output = Path(args.output).expanduser()
    manifest, index, meta, arrays, cache = prepare(root, output, args.reuse_cache)
    cells = meta["cells"]
    rng = np.random.default_rng(SEED)
    queries = queries_for(cells, arrays, rng, args.per_cell, args.spacing, args.queries)
    log(f"selected {len(queries)} query sides in {len(set(q['cell'] for q in queries))} cells; spacing >= {args.spacing} m")
    results = {scope: {mode: {size: [] for size in SHORTLISTS} for mode in ("stored", "float")}
               for scope in ("global_sample", "radius_400", "radius_800")}
    probes = []
    skipped_local = {radius: {"no_shards": 0, "reference_not_loaded": 0, "less_than_10": 0} for radius in (400, 800)}
    for qi, query in enumerate(queries):
        qid, cell = query["row"], query["cell"]
        point = arrays["midpoints"][qid // 2]
        for radius in (400, 800):
            selected = selected_cells(cells, point, radius)
            if not selected:
                skipped_local[radius]["no_shards"] += 1
                continue
            ids = np.concatenate([np.arange(c["start"], c["end"]) for c in selected])
            ids = ids[(arrays["lengths"][ids // 2] >= 15) & (haversine(arrays["midpoints"][ids // 2], point) <= radius)]
            if qid not in ids:
                skipped_local[radius]["reference_not_loaded"] += 1
                continue
            if len(ids) < 11:
                skipped_local[radius]["less_than_10"] += 1
                continue
            exact = distances_bytes(arrays["annual"][qid:qid + 1], arrays["annual"][ids])[0]
            storage = {"pool_sides": len(ids) - 1, "cells_loaded": len(selected),
                       "annual_bytes": sum(c["segments"] * 2 * 581 for c in selected),
                       "signature_bytes": sum(c["signature_bytes"] for c in selected),
                       "street_bytes": sum(c["street_bytes"] for c in selected),
                       "shade_index_bytes": sum(c["shade_index_bytes"] for c in selected)}
            values = measure_pool(exact, ids, qid, arrays["vectors"][ids], arrays["projection"][ids],
                                  arrays["vectors"][qid], arrays["projection"][qid], cell, storage, cells, index["model"]["daySlots"])
            for mode in values:
                for size, value in values[mode].items():
                    results[f"radius_{radius}"][mode][size].append(value)
            if radius == 400 and len(probes) < 40 and qi % 31 == 0:
                sig = cdist(arrays["vectors"][qid:qid + 1].astype(np.float64), arrays["vectors"][ids].astype(np.float64), metric="sqeuclidean")[0]
                top = ordered_top(sig, ids, 100, qid)
                probes.append({"query": query, "radius": radius, "eligible_rows": ids.tolist(),
                               "expected_shortlist": ids[top].tolist(), "exact_squared_bytes": exact[top].astype(int).tolist()})
        if qi % 100 == 0:
            log(f"local fidelity {qi}/{len(queries)} queries")
    # Verify the numerical/code path on the three worst local tails as well.
    by_id = {q["row"]: q for q in queries}
    for record in sorted(results["radius_800"]["stored"][100], key=lambda r: r["recall10"])[:3]:
        qid = record["query_id"]
        selected = selected_cells(cells, arrays["midpoints"][qid // 2], 800)
        ids = np.concatenate([np.arange(c["start"], c["end"]) for c in selected])
        ids = ids[(arrays["lengths"][ids // 2] >= 15) & (haversine(arrays["midpoints"][ids // 2], arrays["midpoints"][qid // 2]) <= 800)]
        sig = cdist(arrays["vectors"][qid:qid + 1].astype(np.float64), arrays["vectors"][ids].astype(np.float64), metric="sqeuclidean")[0]
        top = ordered_top(sig, ids, 100, qid)
        exact = distances_bytes(arrays["annual"][qid:qid + 1], arrays["annual"][ids[top]])[0]
        probes.append({"query": by_id[qid], "radius": 800, "eligible_rows": ids.tolist(),
                       "expected_shortlist": ids[top].tolist(), "exact_squared_bytes": exact.astype(int).tolist(),
                       "purpose": "worst-case error analysis"})
    # Phase 0's cell-stratified ~200k reference, plus every query for self exclusion.
    per_cell = max(1, args.reference // len(cells))
    sampled = [rng.choice(np.arange(c["start"], c["end"]), size=min(per_cell, c["end"] - c["start"]), replace=False) for c in cells]
    ids = np.unique(np.concatenate(sampled + [np.array([q["row"] for q in queries])]))
    raw = arrays["annual"][ids].astype(np.float64)
    vectors = arrays["vectors"][ids].astype(np.float64)
    projection = arrays["projection"][ids]
    log(f"global reference {len(ids):,} sides; exact search in batches of 16")
    for start in range(0, len(queries), 16):
        group = queries[start:start + 16]
        dists = distances_bytes(arrays["annual"][[q["row"] for q in group]], raw)
        for query, exact in zip(group, dists):
            qid = query["row"]
            values = measure_pool(exact, ids, qid, vectors, projection, arrays["vectors"][qid], arrays["projection"][qid], query["cell"], {"pool_sides": len(ids) - 1}, cells, index["model"]["daySlots"])
            for mode in values:
                for size, value in values[mode].items():
                    results["global_sample"][mode][size].append(value)
        if start % 160 == 0:
            log(f"global fidelity {start}/{len(queries)} queries")
    report = {"generation": args.generation, "seed": SEED, "model": index["model"]["version"],
              "fingerprints": meta["fingerprints"], "day_slots": 581, "total_sides": len(arrays["annual"]),
              "query_count": len(queries), "query_cells": len(set(q["cell"] for q in queries)),
              "query_spacing_m": args.spacing, "reference_sides": len(ids), "skipped_local": skipped_local,
              "versions": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__, "sklearn": sklearn.__version__},
              "projection_code_mismatches": meta["projection_code_mismatches"],
              "wall_seconds": time.perf_counter() - START, "peak_rss_gib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 ** 2,
              "curves": {}, "storage": {}}
    for scope, modes in results.items():
        report["curves"][scope] = {mode: {size: summarize(records) for size, records in sizes.items()} for mode, sizes in modes.items()}
        records = modes["stored"][100]
        fields = ("pool_sides", "annual_cells_after_shortlist", "annual_bytes_after_shortlist", "annual_requests_after_shortlist", "ideal_candidate_bytes")
        if scope != "global_sample":
            fields += ("cells_loaded", "annual_bytes", "signature_bytes", "street_bytes", "shade_index_bytes")
        report["storage"][scope] = {field: {"median": float(np.median([r[field] for r in records])), "p95": float(np.quantile([r[field] for r in records], .95))} for field in fields}
    (cache / "results.json").write_text(json.dumps(report, indent=2))
    (cache / "queries.json").write_text(json.dumps(queries))
    (cache / "probes.json").write_text(json.dumps(probes))
    (cache / "query_metrics.json").write_text(json.dumps(results))
    log(f"done; results {cache / 'results.json'}; peak RSS {report['peak_rss_gib']:.2f} GiB")
    if args.plot:
        plot_report(report, Path(args.plot))
    print(json.dumps(report, indent=2), flush=True)


def plot_report(report, target):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    plt.rcParams.update({"svg.fonttype": "none", "font.size": 10})
    fig, ax = plt.subplots(figsize=(9, 4.8))
    scopes = [("radius_400", "400 m eligible pool", "#2166ac"),
              ("radius_800", "800 m eligible pool", "#d6604d"),
              ("global_sample", f"{report['reference_sides']:,}-side stratified reference", "#6a51a3")]
    for scope, label, colour in scopes:
        for mode, linestyle in (("stored", "-"), ("float", "--")):
            curve = report["curves"][scope][mode]
            x = sorted(int(k) for k in curve)
            y = [curve.get(k, curve.get(str(k)))["recall10"] for k in x]
            ax.plot(x, y, color=colour, linestyle=linestyle, marker="o" if mode == "stored" else None, markersize=4, label=label if mode == "stored" else "_nolegend_")
    ax.axhline(.95, color="#666666", linestyle=":", linewidth=1)
    ax.set(xscale="log", ylim=(.35, 1.015), xlabel="PCA shortlist size (then exact annual-profile rerank)", ylabel="Mean strict recall@10")
    ax.set_xticks(SHORTLISTS, labels=[str(k) for k in SHORTLISTS])
    ax.grid(axis="y", alpha=.2)
    legend = ax.legend(loc="lower right", frameon=False)
    ax.add_artist(legend)
    ax.legend(handles=[Line2D([0], [0], color="#333333", label="Published int8", marker="o"), Line2D([0], [0], color="#333333", linestyle="--", label="Frozen float projection"), Line2D([0], [0], color="#666666", linestyle=":", label="Mean target: 0.95")], loc="lower center", bbox_to_anchor=(.5, 1.01), ncol=3, frameon=False)
    fig.suptitle(f"Frozen shade signatures: {report['query_count']:,} queries spaced ≥500 m", x=.12, y=.98, ha="left", fontsize=12)
    fig.text(.12, .015, "Published NYC generation e6718823bbb3 · exact byte distances · deterministic ties · local pools exclude <15 m segments", fontsize=8, color="#555555")
    fig.tight_layout(rect=(0, .04, 1, .91))
    target.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(target, metadata={"Date": None})
    if target.suffix.lower() == ".svg":
        target.write_text("\n".join(line.rstrip() for line in target.read_text().splitlines()) + "\n")
    plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("generation")
    parser.add_argument("--output", required=True)
    parser.add_argument("--reuse-cache", action="store_true")
    parser.add_argument("--plot", help="Optional standalone SVG/PDF figure path")
    parser.add_argument("--queries", type=int, default=1600)
    parser.add_argument("--per-cell", type=int, default=4)
    parser.add_argument("--spacing", type=float, default=500)
    parser.add_argument("--reference", type=int, default=200000)
    arguments = parser.parse_args()
    with threadpool_limits(limits=4):
        run(arguments)
