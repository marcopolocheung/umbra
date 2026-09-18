import { describe, expect, it } from "vitest";
import type { ShadowSample } from "../shadowField/ShadowField";
import { waitExposureFrom } from "../transitWaitExposure";

const confident = (shadow: number): ShadowSample => ({ shadow, source: "tiles", confidence: 0.9 });

describe("waitExposureFrom", () => {
  it("takes a confident sample as the sun at the stop", () => {
    expect(waitExposureFrom([{ waitSec: 300, sample: confident(0.8) }])).toEqual({
      shadow: 0.8,
      coverage: 1,
      boardings: 1,
    });
  });

  it("weights the stops by the seconds spent standing at each", () => {
    // 6 min in full shadow and 2 min in full sun is not "half shadowed": the
    // rider's dose is how long they stand in the sun, which is why the ride is
    // weighted by time too.
    const exposure = waitExposureFrom([
      { waitSec: 360, sample: confident(1) },
      { waitSec: 120, sample: confident(0) },
    ])!;
    expect(exposure.shadow).toBeCloseTo(0.75, 5);
    expect(exposure.boardings).toBe(2);
  });

  it("reports unknown, not shade, when no source covered the stop (#393)", () => {
    // `shadow: 0` with no confidence is "nothing answered", not "full sun" —
    // and inverting that into shade is the bug #393 was opened for.
    const exposure = waitExposureFrom([
      { waitSec: 300, sample: { shadow: 0, source: "none", confidence: 0 } },
    ])!;
    expect(exposure.shadow).toBeUndefined();
    expect(exposure.coverage).toBe(0);
  });

  it("refuses a low-confidence answer even when it claims shadow", () => {
    const exposure = waitExposureFrom([
      { waitSec: 300, sample: { shadow: 0.9, source: "canopy", confidence: 0.4 } },
    ])!;
    expect(exposure.shadow).toBeUndefined();
  });

  it("measures over the determined part and carries how much that was", () => {
    // Same discipline as the ride: above the floor, report the figure and say
    // what share of the wait it rests on.
    const exposure = waitExposureFrom([
      { waitSec: 360, sample: confident(0.5) },
      { waitSec: 360, sample: confident(0.5) },
      { waitSec: 120, sample: null },
    ])!;
    expect(exposure.shadow).toBeCloseTo(0.5, 5);
    expect(exposure.coverage).toBeCloseTo(720 / 840, 5);
  });

  it("says nothing about a wait it mostly could not see", () => {
    // One of three boardings answered: a percentage drawn from that sliver
    // would describe a wait that was 70% unseen.
    const exposure = waitExposureFrom([
      { waitSec: 360, sample: null },
      { waitSec: 360, sample: null },
      { waitSec: 300, sample: confident(1) },
    ])!;
    expect(exposure.shadow).toBeUndefined();
    expect(exposure.coverage).toBeLessThan(0.6);
  });

  it("has nothing to qualify when no wait was priced", () => {
    expect(waitExposureFrom([])).toBeUndefined();
    expect(waitExposureFrom([{ waitSec: 0, sample: confident(1) }])).toBeUndefined();
  });

  it("keeps night, which needs no geometry to be certain", () => {
    const exposure = waitExposureFrom([
      { waitSec: 300, sample: { shadow: 1, source: "none", confidence: 1 } },
    ])!;
    expect(exposure.shadow).toBe(1);
  });
});
