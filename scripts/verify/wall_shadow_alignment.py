#!/usr/bin/env python3
"""Browser verification for wall/ground shadow alignment.

Pass B rasterises a shadow-ceiling field indexed by *ground* position, and the
building pass (Pass E) nudges its sample of that field toward the sun and along
the wall normal so a wall does not read as standing inside its own shadow. Moving
toward the sun reads a higher ceiling, so Pass E must raise the wall threshold by
the same distance times tan(sun altitude). Otherwise a shadow visibly steps up as
it crosses from the street onto a wall.

Vitest runs in a Node environment and does not execute this shader. This verifier
drives the real app without a production test hook: Playwright rewrites the served
MapView module to expose the map and rewrites Pass E's output into a diagnostic
framebuffer. Both substitutions are asserted so shader or component edits fail
loudly instead of silently invalidating the measurement.

The diagnostic framebuffer encodes each Pass E fragment as:

    R = shadowed decision (255 = shadowed)
    G = roof versus wall (255 = roof)
    B = sun-facing status (255 = facing the sun)
    A = 0 for every Pass E fragment

Ordinary map pixels retain A = 255. MSAA-resolved silhouette pixels have an alpha
between those values, so only A == 0 is a whole Pass E fragment and wall-base
ground probes are accepted only when every intervening pixel has A == 255.
The map has rendered without MSAA since the fps pass (antialias: false), so the
fringe no longer occurs; the checks stay as a guard for a run that turns it on.

Usage
-----
    npm run dev &
    LD_LIBRARY_PATH=$HOME/miniconda3/lib \
      ~/miniconda3/bin/python scripts/verify/wall_shadow_alignment.py \
        --url http://localhost:5173 --out out/ --tag before-1

    # Re-run against the fixed server with the same scene and viewport:
    ... --out out/ --tag after-1 --baseline out/before-1.json

See docs/notes/browser-verification.md for the repeatable three-pair procedure.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Tribeca mid-afternoon: dense low- and mid-rise buildings with long street
# shadows running onto sunlit walls. At ~33 degrees altitude the uncompensated
# lift is large enough to distinguish without turning whole faces over.
SCENE = "?lat=40.71500&lng=-74.00600&z=17&date=2026-09-04&time=15:23"
VIEWPORT = {"width": 1200, "height": 900}
TIMEZONE = "America/New_York"
PITCH = 55
BEARING = 0

# Whole-fragment wall bases are deliberately rare with MSAA: most silhouettes
# contain a partially covered pixel. These subpixel pans hold the geographic scene
# and camera fixed while sampling six deterministic raster phases, giving the
# clean-alpha gate enough independent base observations. Each before/after pair
# uses the identical sequence.
SAMPLE_OFFSETS = [[0, 0], [0.25, 0], [0.5, 0], [0.75, 0], [0, 0.5], [0.5, 0.5]]

# WebGL needs a software rasteriser; there is no GPU in WSL.
CHROME_FLAGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

MIN_PASS_E_PIXELS = 10_000
MIN_WALL_PIXELS = 1_000
MIN_WALL_BASE_SAMPLES = 1_000
MIN_SHADOWED_TO_LIT_FRACTION = 0.003
MAX_SHADOWED_TO_LIT_FRACTION = 0.02
MIN_WALL_BASE_IMPROVEMENT = 0.002

# The two in-flight rewrites: (URL glob, needle, replacement).
MAP_HANDLE_PATCH = (
    "**/app/components/MapView.tsx*",
    "onMapReady?.(map)",
    "(window.__map = map, onMapReady?.(map))",
)
DEBUG_SHADER_PATCH = (
    "**/app/lib/shadow/LocalShadowAdapter.ts*",
    "gl_FragColor = vec4(mix(lit, dark, shadowed), 1.0);",
    "gl_FragColor = vec4(shadowed, step(0.5, v_normal.z), "
    "step(0.0, v_facing), 0.0);",
)

# The routing sampler also detects ground shadow by blue dominance. This looser
# threshold reads only the composited basemap at the foot of a wall.
GROUND_BLUE_DOMINANCE = 12
# The immediate edge pixel is an MSAA blend. Three pixels is under a metre at
# this camera, and every one must be untouched ground for a sample to count.
GROUND_PROBE_GAP = 3


def _is_pass_e(px: bytes, i: int) -> bool:
    """Return whether this is a fully covered Pass E fragment."""
    return px[i + 3] == 0


def install_patches(page, applied: dict[str, int]) -> None:
    """Rewrite the dev-served modules in flight, counting each substitution."""

    def make_route(pattern: str, needle: str, replacement: str):
        def route(route_obj):
            response = route_obj.fetch()
            body = response.text()
            applied[pattern] = applied.get(pattern, 0) + body.count(needle)
            route_obj.fulfill(
                status=response.status,
                headers={
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() != "content-length"
                },
                body=body.replace(needle, replacement),
            )

        return route

    for pattern, needle, replacement in (MAP_HANDLE_PATCH, DEBUG_SHADER_PATCH):
        page.route(pattern, make_route(pattern, needle, replacement))


READ_PIXELS_JS = """() => {
  const c = document.querySelector('.maplibregl-canvas');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  const w = c.width, h = c.height;
  const px = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
  let s = '';
  for (let i = 0; i < px.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
  }
  return {w, h, b64: btoa(s)};
}"""


def capture(page, url: str, out: Path, tag: str) -> tuple[bytes, dict]:
    """Load the fixed scene, tilt it, and read the diagnostic framebuffer."""
    applied: dict[str, int] = {}
    install_patches(page, applied)

    page.goto(url, wait_until="load")
    page.wait_for_timeout(12_000)
    page.evaluate(
        "([p, b]) => window.__map && window.__map.jumpTo({pitch: p, bearing: b})",
        [PITCH, BEARING],
    )
    page.wait_for_timeout(8_000)

    assert applied.get(MAP_HANDLE_PATCH[0]), "map-handle rewrite never matched"
    assert applied.get(DEBUG_SHADER_PATCH[0]), "debug-shader rewrite never matched"
    assert page.evaluate("() => !!window.__map"), "window.__map was never set"

    page.screenshot(path=str(out / f"{tag}.png"))
    center = page.evaluate("() => window.__map.getCenter().toArray()")
    frames = []
    width = height = None
    for frame_number, offset in enumerate(SAMPLE_OFFSETS, start=1):
        page.evaluate(
            "([c, o, p, b]) => { window.__map.jumpTo({center: c, pitch: p, bearing: b}); "
            "window.__map.panBy(o, {duration: 0}); }",
            [center, offset, PITCH, BEARING],
        )
        page.wait_for_timeout(500)
        raw = page.evaluate(READ_PIXELS_JS)
        if width is None:
            width, height = raw["w"], raw["h"]
        assert (raw["w"], raw["h"]) == (width, height), "framebuffer size changed"
        frames.append(base64.b64decode(raw["b64"]))
        print(
            f"  captured raster phase {frame_number}/{len(SAMPLE_OFFSETS)}",
            file=sys.stderr,
        )
    meta = {
        "width": width,
        "height": height,
        "viewport": VIEWPORT,
        "timezone": TIMEZONE,
        "pitch": page.evaluate("() => window.__map.getPitch()"),
        "bearing": page.evaluate("() => window.__map.getBearing()"),
        "samplingOffsets": SAMPLE_OFFSETS,
        "frameCount": len(frames),
        "substitutions": applied,
    }
    return b"".join(frames), meta


def analyse(px: bytes) -> dict:
    """Classify every fully covered Pass E fragment of one readback."""
    walls = shadowed_walls = roofs = shadowed_roofs = 0
    sun_walls = shadowed_sun_walls = 0
    for i in range(0, len(px), 4):
        if not _is_pass_e(px, i):
            continue
        if px[i + 1] == 255:
            roofs += 1
            shadowed_roofs += px[i] == 255
        else:
            walls += 1
            shadowed_walls += px[i] == 255
            if px[i + 2] == 255:
                sun_walls += 1
                shadowed_sun_walls += px[i] == 255
    return {
        "passEPixels": walls + roofs,
        "wallPixels": walls,
        "sunFacingWallPixels": sun_walls,
        "roofPixels": roofs,
        "shadowedWallFraction": shadowed_walls / walls if walls else 0.0,
        "shadowedSunFacingWallFraction": (
            shadowed_sun_walls / sun_walls if sun_walls else 0.0
        ),
        "shadowedRoofFraction": shadowed_roofs / roofs if roofs else 0.0,
    }


def wall_base_disagreement(px: bytes, width: int, height: int) -> dict:
    """Compare each valid sun-facing wall base with the ground at its foot."""
    agree = disagree = 0
    strict_samples = 0
    frame_bytes = width * height * 4
    for frame_start in range(0, len(px), frame_bytes):
        for x in range(width):
            # readPixels is bottom-up, so y - 1 is below a wall fragment.
            for y in range(GROUND_PROBE_GAP, height):
                i = frame_start + (y * width + x) * 4
                if not _is_pass_e(px, i) or px[i + 1] == 255 or px[i + 2] != 255:
                    continue
                gaps = [
                    frame_start + ((y - distance) * width + x) * 4
                    for distance in range(1, GROUND_PROBE_GAP + 1)
                ]
                # A whole intervening building means this is not a base. The first
                # one or two pixels may be the MSAA silhouette fringe, which is
                # skipped rather than classified; the actual ground probe must be
                # fully uncovered. The stricter all-255 population is counted
                # separately as the sample-size validity gate.
                if any(_is_pass_e(px, j) for j in gaps):
                    continue
                ground_i = gaps[-1]
                if px[ground_i + 3] != 255:
                    continue
                if all(px[j + 3] == 255 for j in gaps):
                    strict_samples += 1
                red, green, blue = px[ground_i], px[ground_i + 1], px[ground_i + 2]
                ground_shadowed = blue - (red + green) / 2 > GROUND_BLUE_DOMINANCE
                if (px[i] == 255) == ground_shadowed:
                    agree += 1
                else:
                    disagree += 1
    total = agree + disagree
    return {
        "wallBaseSamples": total,
        "strictWallBaseSamples": strict_samples,
        "wallBaseDisagreements": disagree,
        "wallBaseDisagreementRate": disagree / total if total else 0.0,
    }


def _is_stable_face(
    px: bytes,
    frame_start: int,
    x: int,
    y: int,
    width: int,
    require_uniform_decision: bool = False,
) -> bool:
    """Exclude one-pixel face boundaries that can move between independent draws."""
    i = frame_start + (y * width + x) * 4
    if not _is_pass_e(px, i):
        return False
    face = px[i + 1]
    return all(
        _is_pass_e(px, frame_start + (yy * width + xx) * 4)
        and px[frame_start + (yy * width + xx) * 4 + 1] == face
        and (
            not require_uniform_decision
            or px[frame_start + (yy * width + xx) * 4] == px[i]
        )
        for yy in range(y - 1, y + 2)
        for xx in range(x - 1, x + 2)
    )


def compare(before: bytes, after: bytes, width: int, height: int) -> dict:
    """Measure decision flips between aligned readbacks of the same scene."""
    lit_to_shadowed = shadowed_to_lit = roof_diffs = compared = 0
    frame_bytes = width * height * 4
    for frame_start in range(0, len(before), frame_bytes):
        for y in range(1, height - 1):
            for x in range(1, width - 1):
                if not _is_stable_face(before, frame_start, x, y, width):
                    continue
                if not _is_stable_face(after, frame_start, x, y, width):
                    continue
                i = frame_start + (y * width + x) * 4
                compared += 1
                if before[i + 1] == 255:
                    if not _is_stable_face(
                        before, frame_start, x, y, width, require_uniform_decision=True
                    ) or not _is_stable_face(
                        after, frame_start, x, y, width, require_uniform_decision=True
                    ):
                        continue
                    if before[i] != after[i]:
                        roof_diffs += 1
                    continue
                was_shadowed, now_shadowed = before[i] == 255, after[i] == 255
                if was_shadowed and not now_shadowed:
                    shadowed_to_lit += 1
                elif now_shadowed and not was_shadowed:
                    lit_to_shadowed += 1
    return {
        "comparedPassEPixels": compared,
        "litToShadowed": lit_to_shadowed,
        "shadowedToLit": shadowed_to_lit,
        "roofPixelDiffs": roof_diffs,
        "shadowedToLitFraction": shadowed_to_lit / compared if compared else 0.0,
    }


def validate_capture(report: dict, failures: list[str]) -> None:
    """Apply sample-size thresholds to both baselines and comparisons."""
    if report["passEPixels"] < MIN_PASS_E_PIXELS:
        failures.append(
            f"only {report['passEPixels']} Pass E pixels; buildings may not have loaded"
        )
    if report["wallPixels"] < MIN_WALL_PIXELS:
        failures.append(f"only {report['wallPixels']} wall pixels to judge")
    if report["strictWallBaseSamples"] < MIN_WALL_BASE_SAMPLES:
        failures.append(
            f"only {report['strictWallBaseSamples']} strict wall-base samples to judge"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:5173")
    parser.add_argument("--out", default="out", type=Path)
    parser.add_argument(
        "--baseline",
        type=Path,
        help="a prior JSON report whose raw framebuffer should be compared",
    )
    parser.add_argument("--tag", default="wall_shadow_alignment")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    url = args.url.rstrip("/") + "/" + SCENE
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=CHROME_FLAGS)
        page = browser.new_page(viewport=VIEWPORT, timezone_id=TIMEZONE)
        page.on("console", lambda message: print(f"  [console] {message.text}", file=sys.stderr))
        pixels, meta = capture(page, url, args.out, args.tag)
        browser.close()

    width, height = meta["width"], meta["height"]
    report = {"scene": SCENE, **meta}
    report.update(analyse(pixels))
    report.update(wall_base_disagreement(pixels, width, height))

    raw_path = (args.out / f"{args.tag}.raw").resolve()
    raw_path.write_bytes(pixels)
    report["rawPixels"] = str(raw_path)

    failures: list[str] = []
    validate_capture(report, failures)

    if args.baseline:
        prior = json.loads(args.baseline.read_text())
        for key in (
            "scene",
            "width",
            "height",
            "viewport",
            "timezone",
            "pitch",
            "bearing",
            "samplingOffsets",
            "frameCount",
        ):
            if report[key] != prior.get(key):
                failures.append(f"baseline mismatch for {key}: {prior.get(key)!r} != {report[key]!r}")

        before = Path(prior["rawPixels"]).read_bytes()
        if len(before) != len(pixels):
            failures.append("the baseline framebuffer has a different byte length")
        else:
            delta = compare(before, pixels, width, height)
            report["vsBaseline"] = delta
            baseline_rate = prior["wallBaseDisagreementRate"]
            improvement = baseline_rate - report["wallBaseDisagreementRate"]
            report["baselineWallBaseDisagreementRate"] = baseline_rate
            report["wallBaseDisagreementImprovement"] = improvement

            if delta["litToShadowed"] != 0:
                failures.append(
                    f"{delta['litToShadowed']} pixels flipped lit->shadowed; expected zero"
                )
            if delta["roofPixelDiffs"] != 0:
                failures.append(
                    f"{delta['roofPixelDiffs']} roof pixels changed; expected zero"
                )
            flip_fraction = delta["shadowedToLitFraction"]
            if not MIN_SHADOWED_TO_LIT_FRACTION <= flip_fraction <= MAX_SHADOWED_TO_LIT_FRACTION:
                failures.append(
                    "shadowed->lit Pass E fraction outside 0.3%-2.0%: "
                    f"{flip_fraction:.3%}"
                )
            if improvement < MIN_WALL_BASE_IMPROVEMENT:
                failures.append(
                    "wall-base disagreement did not improve by 0.2 percentage points: "
                    f"{baseline_rate:.3%} -> {report['wallBaseDisagreementRate']:.3%} "
                    f"({improvement:.3%})"
                )

    (args.out / f"{args.tag}.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != "rawPixels"}, indent=2))

    for failure in failures:
        print(f"FAIL: {failure}")
    if failures:
        return 1
    if args.baseline:
        print(
            "PASS: monotone wall-only terminator band, bit-identical roofs, and "
            "wall-base disagreement improved by at least 0.2 points."
        )
    else:
        print("PASS: baseline captured. Re-run with --baseline to compare.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
