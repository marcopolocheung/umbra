#!/usr/bin/env python3
"""
Measures whether a per-edge GTFS shape slice is buildable for the NYC feeds, and
what the stop-to-stop straight chord costs against it.

Answers four questions, in this order:

  1. Does every directed (route, direction, stopA, stopB) edge slice cleanly out
     of its trip's shape?  (If not, the whole idea is dead.)
  2. When several shapes serve one edge — which is the common case — do they
     agree on the geometry?  (If not, an edge has no well-defined geometry and
     #385's pattern problem survives the move to per-edge.)
  3. How far is the drawn straight chord from the track it claims to be?
  4. What would shipping the slices cost in the shard, as JSON and as an
     encoded polyline?

Usage:  python3 transit-edge-geometry.py <gtfs-dir> [--sample N]

`<gtfs-dir>` is an unzipped GTFS feed: the ones this repo builds from live in
`~/shade-prep-data-nyc-transit/` (gtfs_subway, gtfs_m, gtfs_b, gtfs_bx, gtfs_q,
gtfs_si, gtfs_busco).  Stdlib only; no repo dependency.
"""

import csv, collections, math, sys, json, gzip, random


def encode_polyline(points, precision=5):
    """Google encoded polyline, the standard compact wire form for a path."""
    factor = 10 ** precision
    out, prev_lat, prev_lon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            v = ~(delta << 1) if delta < 0 else (delta << 1)
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)

R = 6371000.0


def hav(p, q):
    la1, lo1 = p
    la2, lo2 = q
    dla = math.radians(la2 - la1)
    dlo = math.radians(lo2 - lo1)
    x = (math.sin(dla / 2) ** 2
         + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dlo / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(x))


def project(a, b, p):
    """Clamped projection of p onto segment a-b, in a local planar frame.

    Returns (point, t).  The frame is exact enough at NYC latitudes over a
    single shape segment (tens of metres); it is not a general-purpose geodesic.
    """
    k = math.cos(math.radians(a[0]))
    vx, vy = b[0] - a[0], (b[1] - a[1]) * k
    wx, wy = p[0] - a[0], (p[1] - a[1]) * k
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return (a[0] + vx * t, a[1] + (vy * t) / k), t


def load(d):
    shapes = collections.defaultdict(list)
    with open(f"{d}/shapes.txt") as f:
        for r in csv.DictReader(f):
            shapes[r["shape_id"]].append(
                (int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    for k in shapes:
        shapes[k].sort()
        shapes[k] = [(a, b) for _, a, b in shapes[k]]
    stops = {}
    with open(f"{d}/stops.txt") as f:
        for r in csv.DictReader(f):
            stops[r["stop_id"]] = (float(r["stop_lat"]), float(r["stop_lon"]))
    trips = {}
    with open(f"{d}/trips.txt") as f:
        for r in csv.DictReader(f):
            trips[r["trip_id"]] = (r["route_id"], r["direction_id"], r["shape_id"])
    seq = collections.defaultdict(list)
    with open(f"{d}/stop_times.txt") as f:
        for r in csv.DictReader(f):
            seq[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"]))
    return shapes, stops, trips, seq


def edge_shapes(trips, seq):
    """Directed (route, direction, from, to) -> every shape_id that serves it."""
    pair = collections.defaultdict(set)
    for t, st in seq.items():
        if t not in trips:
            continue
        route, direction, shape = trips[t]
        st.sort()
        for a, b in zip(st, st[1:]):
            pair[(route, direction, a[1], b[1])].add(shape)
    return pair


def cumulative(pl):
    c = [0.0]
    for i in range(1, len(pl)):
        c.append(c[-1] + hav(pl[i - 1], pl[i]))
    return c


def snap(pl, cum, pt):
    """Nearest point on the polyline: (index of segment, distance, along-track)."""
    best = (0, 1e18, 0.0)
    for i in range(1, len(pl)):
        q, t = project(pl[i - 1], pl[i], pt)
        d = hav(q, pt)
        if d < best[1]:
            best = (i - 1, d, cum[i - 1] + t * (cum[i] - cum[i - 1]))
    return best


def main():
    d = sys.argv[1]
    sample_n = 250
    if "--sample" in sys.argv:
        sample_n = int(sys.argv[sys.argv.index("--sample") + 1])
    shapes, stops, trips, seq = load(d)
    pair = edge_shapes(trips, seq)
    cums = {}

    def cum(sid):
        if sid not in cums:
            cums[sid] = cumulative(shapes[sid])
        return cums[sid]

    print(f"feed: {d}")
    hdr = open(f"{d}/shapes.txt").readline().strip()
    print(f"  shapes.txt header: {hdr}")
    print(f"  stop_times.txt header: {open(f'{d}/stop_times.txt').readline().strip()}")
    print(f"  shape_dist_traveled present: {'shape_dist_traveled' in hdr}")

    multi = sum(1 for v in pair.values() if len(v) > 1)
    print(f"\n[1] edges: {len(pair)} directed (route, direction, from, to) pairs")
    print(f"    served by more than one shape: {multi} ({multi / len(pair):.1%})")

    # [2] do the shapes serving one edge agree on its geometry?
    random.seed(7)
    keys = [k for k, v in pair.items() if len(v) > 1 and k[2] in stops and k[3] in stops]
    random.shuffle(keys)
    spreads, unusable = [], 0
    for k in keys[:sample_n]:
        lens = []
        for sid in sorted(pair[k]):
            pl = shapes.get(sid)
            if not pl or len(pl) < 2:
                continue
            c = cum(sid)
            _, da, ta = snap(pl, c, stops[k[2]])
            _, db, tb = snap(pl, c, stops[k[3]])
            if max(da, db) > 150 or tb <= ta:
                continue
            lens.append(tb - ta)
        if len(lens) > 1:
            spreads.append(max(lens) - min(lens))
        elif not lens:
            unusable += 1
    if spreads:
        spreads.sort()
        over = sum(1 for s in spreads if s > 50)
        print(f"\n[2] agreement across shapes, {len(spreads)} sampled multi-shape edges")
        print(f"    sliced length spread: median {spreads[len(spreads)//2]:.1f} m, max {spreads[-1]:.1f} m")
        print(f"    spread over 50 m: {over} ({over / len(spreads):.1%})")
        print(f"    edges where no shape sliced at all: {unusable}")

    # [3] straight chord vs the track it claims to be, one shape per edge
    ratios, snaps, devs, skipped, nonmono = [], [], [], 0, 0
    geom = []
    for (route, direction, a, b), sid in ((k, sorted(v)[0]) for k, v in pair.items()):
        if a not in stops or b not in stops or sid not in shapes:
            skipped += 1
            continue
        pl, c = shapes[sid], cum(sid)
        P, Q = stops[a], stops[b]
        ia, da, ta = snap(pl, c, P)
        ib, db, tb = snap(pl, c, Q)
        snaps.append(max(da, db))
        if ib < ia or tb <= ta:
            nonmono += 1
            continue
        straight = hav(P, Q)
        if straight > 1:
            ratios.append(straight / (tb - ta))
        interior = pl[ia + 1:ib + 1]
        devs.append(max((hav(project(P, Q, pt)[0], pt) for pt in interior), default=0.0))
        geom.append([[round(lon, 5), round(lat, 5)] for lat, lon in interior])

    ratios.sort(); snaps.sort(); devs.sort()
    n = len(devs)
    pct = lambda xs, p: xs[min(len(xs) - 1, int(p * len(xs)))]
    print(f"\n[3] one shape per edge: {n} measured, {skipped} skipped, {nonmono} non-monotonic")
    print(f"    stop to shape snap:  median {pct(snaps,.5):.1f} m  p95 {pct(snaps,.95):.1f} m  max {snaps[-1]:.1f} m")
    print(f"    straight / track length: median {pct(ratios,.5):.3f}  p05 {pct(ratios,.05):.3f}  min {ratios[0]:.3f}")
    print(f"    lateral deviation of track from the drawn chord:")
    print(f"      median {pct(devs,.5):.0f} m  p75 {pct(devs,.75):.0f} m  p90 {pct(devs,.90):.0f} m"
          f"  p95 {pct(devs,.95):.0f} m  max {devs[-1]:.0f} m")
    for thr in (25, 50, 100, 200):
        c_ = sum(1 for x in devs if x > thr)
        print(f"      over {thr:3d} m: {c_:5d} edges ({c_ / n:.1%})")

    # [4] what shipping the slices would cost, two wire forms
    pts = sum(len(g) for g in geom)
    blob = json.dumps(geom, separators=(",", ":")).encode()
    poly = json.dumps([encode_polyline([(pt[1], pt[0]) for pt in g]) for g in geom],
                      separators=(",", ":")).encode()
    print(f"\n[4] interior shape points: {pts} ({pts / max(1,len(geom)):.1f} per edge)")
    print(f"    JSON arrays at 5 dp: {len(blob)/1024:.0f} KB raw, {len(gzip.compress(blob))/1024:.0f} KB gzipped")
    print(f"    encoded polyline:    {len(poly)/1024:.0f} KB raw, {len(gzip.compress(poly))/1024:.0f} KB gzipped")


if __name__ == "__main__":
    main()
