import { describe, expect, it } from "vitest";
import { lineBadgePlacements } from "../lineBadges";

describe("lineBadgePlacements", () => {
  it("pins one badge per ride, not per station hop", () => {
    const badges = lineBadgePlacements([
      { line: "L", color: "#A7A9AC", coords: [[-73.99, 40.73], [-73.98, 40.73]] },
      { line: "L", color: "#A7A9AC", coords: [[-73.98, 40.73], [-73.97, 40.73]] },
      { line: "G", color: "#6CBE45", coords: [[-73.97, 40.73], [-73.97, 40.74]] },
    ]);
    expect(badges.map((b) => b.line)).toEqual(["L", "G"]);
    expect(badges[0].color).toBe("#A7A9AC");
  });

  it("sits halfway along the drawn track, on the line", () => {
    // An L-shaped ride: 1 km east, then 3 km north. Halfway (2 km) is 1 km up the second arm.
    const east = 1000 / (111_195 * Math.cos((40.73 * Math.PI) / 180));
    const north = 1000 / 111_195;
    const [badge] = lineBadgePlacements([
      { line: "A", color: "#0039A6", coords: [[-74, 40.73], [-74 + east, 40.73], [-74 + east, 40.73 + 3 * north]] },
    ]);
    expect(badge.at[0]).toBeCloseTo(-74 + east, 6);
    expect(badge.at[1]).toBeCloseTo(40.73 + north, 3);
  });

  it("starts a new badge when the same line is ridden again after a change", () => {
    const hop = (line: string, x: number) => ({ line, color: "#000000", coords: [[x, 40.7], [x + 0.01, 40.7]] as [number, number][] });
    expect(lineBadgePlacements([hop("A", 0), hop("C", 0.01), hop("A", 0.02)]).map((b) => b.line)).toEqual(["A", "C", "A"]);
  });

  it("skips empty geometry and places a single-point ride on its point", () => {
    expect(lineBadgePlacements([{ line: "S", color: "#808183", coords: [] }])).toEqual([]);
    expect(lineBadgePlacements([{ line: "S", color: "#808183", coords: [[-73.98, 40.75]] }])[0].at).toEqual([-73.98, 40.75]);
  });
});
