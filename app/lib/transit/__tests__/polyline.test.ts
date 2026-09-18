import { describe, expect, it } from "vitest";
import { decodePolyline } from "../polyline";

/**
 * Vectors pin the producer's actual wire format as literals — not an encoder
 * against its own inverse. Each was produced once by the producer's
 * `encodePolyline` (`server/transit-prep/src/shapeSlice.ts`, precision 5) and
 * is pasted here with its source, so a producer-side format change fails here
 * rather than silently drawing wrong lines.
 */
describe("decodePolyline", () => {
  it("decodes a single interior point", () => {
    // Producer's own CORNER case: bus:a → bus:b north then east (`verifyShard.test.ts`).
    expect(decodePolyline("_}wwFndrbM")).toEqual([[-73.99, 40.76]]);
  });

  it("decodes several points with negative longitude deltas", () => {
    // Every NYC longitude is negative, so this is the common path, not the edge case.
    const decoded = decodePolyline("_hdxFnicbMcGkHkMkM")!;
    expect(decoded).toHaveLength(3);
    const [[lon1, lat1], [lon2, lat2], [lon3, lat3]] = decoded;
    expect(lat1).toBeCloseTo(40.8232, 5);
    expect(lon1).toBeCloseTo(-73.914, 5);
    expect(lat2).toBeCloseTo(40.8245, 5);
    expect(lon2).toBeCloseTo(-73.9125, 5);
    expect(lat3).toBeCloseTo(40.8268, 5);
    expect(lon3).toBeCloseTo(-73.9102, 5);
  });

  it("decodes an L-shaped dogleg, holding 5 dp quantisation", () => {
    // Three midtown interior points: north one block, then east two.
    const decoded = decodePolyline("owvwF~~pbMgE??oK")!;
    expect(decoded).toHaveLength(3);
    expect(decoded[0]?.[1]).toBeCloseTo(40.754, 5);
    expect(decoded[0]?.[0]).toBeCloseTo(-73.984, 5);
    expect(decoded[1]?.[1]).toBeCloseTo(40.755, 5);
    expect(decoded[1]?.[0]).toBeCloseTo(-73.984, 5);
    expect(decoded[2]?.[1]).toBeCloseTo(40.755, 5);
    expect(decoded[2]?.[0]).toBeCloseTo(-73.982, 5);
  });

  it("decodes the canonical Google example", () => {
    // The documentation's own vector — a cross-check against the spec, not our encoder.
    const decoded = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")!;
    expect(decoded).toHaveLength(3);
    expect(decoded[0]?.[1]).toBeCloseTo(38.5, 5);
    expect(decoded[0]?.[0]).toBeCloseTo(-120.2, 5);
    expect(decoded[1]?.[1]).toBeCloseTo(40.7, 5);
    expect(decoded[1]?.[0]).toBeCloseTo(-120.95, 5);
    expect(decoded[2]?.[1]).toBeCloseTo(43.252, 5);
    expect(decoded[2]?.[0]).toBeCloseTo(-126.453, 5);
  });

  it("returns null for the empty string", () => {
    expect(decodePolyline("")).toBeNull();
  });

  it("returns null for a truncated string", () => {
    // A lone continuation byte, and a valid encoding with its tail cut off.
    expect(decodePolyline("_")).toBeNull();
    expect(decodePolyline("_}wwFndrb")).toBeNull();
    // A cut mid-pair: latitude complete, longitude missing.
    expect(decodePolyline("_}wwF")).toBeNull();
  });

  it("returns null for out-of-charset input", () => {
    // Below 63 (space) and above 126 (DEL) are both outside the encoder's range.
    expect(decodePolyline(" ")).toBeNull();
    expect(decodePolyline("_}wwFndrbM ")).toBeNull();
    expect(decodePolyline("\u007f_}wwFndrbM")).toBeNull();
  });
});
