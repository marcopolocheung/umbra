import { describe, expect, it } from "vitest";
import {
  transitOptionDominated,
  TRANSIT_DOMINANCE_MAX_RATIO,
  TRANSIT_DOMINANCE_SLACK_SEC,
} from "../transitGate";

const MIN = 60;

describe("transitOptionDominated", () => {
  it("keeps a transit offer within twice the walk on a long walk", () => {
    const walkSec = 60 * MIN; // an hour on foot: the ratio arm governs
    expect(transitOptionDominated(TRANSIT_DOMINANCE_MAX_RATIO * walkSec - 1, walkSec)).toBe(false);
  });

  it("suppresses one past twice the walk", () => {
    const walkSec = 60 * MIN;
    expect(transitOptionDominated(2 * TRANSIT_DOMINANCE_MAX_RATIO * walkSec + 1, walkSec)).toBe(
      true,
    );
  });

  it("suppresses a ride past the walk plus the slack on a short walk", () => {
    // Under the 15-minute slack the margin, not the ratio, is the ceiling, so
    // a 30-minute bus against a 13-minute walk fails even inside 2×.
    const walkSec = 13 * MIN;
    expect(transitOptionDominated(walkSec + TRANSIT_DOMINANCE_SLACK_SEC + 1, walkSec)).toBe(true);
    expect(transitOptionDominated(30 * MIN, walkSec)).toBe(true);
    expect(transitOptionDominated(26 * MIN, walkSec)).toBe(false);
  });

  it("treats the exact ceiling as acceptable", () => {
    const walkSec = 13 * MIN;
    const ceiling = Math.max(
      TRANSIT_DOMINANCE_MAX_RATIO * walkSec,
      walkSec + TRANSIT_DOMINANCE_SLACK_SEC,
    );
    expect(transitOptionDominated(ceiling, walkSec)).toBe(false);
  });

  it("never dominates when either figure is invalid", () => {
    expect(transitOptionDominated(0, 600)).toBe(false);
    expect(transitOptionDominated(600, 0)).toBe(false);
    expect(transitOptionDominated(Number.NaN, 600)).toBe(false);
    expect(transitOptionDominated(600, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
