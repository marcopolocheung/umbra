import { describe, expect, it } from "vitest";
import type { ShadowSample } from "../shadowField/ShadowField";
import { waitExposureFromSample } from "../transitWaitExposure";

const STOP = "1 Av / E 14 St";

describe("waitExposureFromSample", () => {
  it("takes a confident sample as the sun at the stop", () => {
    const sample: ShadowSample = { shadow: 0.8, source: "tiles", confidence: 0.9 };
    expect(waitExposureFromSample(STOP, sample)).toEqual({ stopName: STOP, shadow: 0.8 });
  });

  it("reports unknown, not shade, when no source covered the stop (#393)", () => {
    // `shadow: 0` here is "nothing answered", not "full sun" — and inverting
    // that into shade is exactly the bug #393 was opened for.
    const sample: ShadowSample = { shadow: 0, source: "none", confidence: 0 };
    expect(waitExposureFromSample(STOP, sample)).toEqual({ stopName: STOP });
  });

  it("refuses a low-confidence answer even when it claims shadow", () => {
    const sample: ShadowSample = { shadow: 0.9, source: "canopy", confidence: 0.4 };
    expect(waitExposureFromSample(STOP, sample).shadow).toBeUndefined();
  });

  it("keeps night, which needs no geometry to be certain", () => {
    const sample: ShadowSample = { shadow: 1, source: "none", confidence: 1 };
    expect(waitExposureFromSample(STOP, sample)).toEqual({ stopName: STOP, shadow: 1 });
  });

  it("reports unknown when the stop was never sampled at all", () => {
    expect(waitExposureFromSample(STOP, null)).toEqual({ stopName: STOP });
  });
});
