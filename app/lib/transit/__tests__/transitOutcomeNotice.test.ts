import { describe, expect, it } from "vitest";
import {
  transitModeNoticeText,
  transitModeNotices,
} from "../transitOutcomeNotice";

describe("transitModeNotices", () => {
  it("words a walk-dominated offer with both times", () => {
    const [notice] = transitModeNotices([
      { mode: "bus", outcome: "offered", dominatedMin: { transitMin: 42, walkMin: 14 } },
    ]);
    expect(notice).toEqual({ mode: "bus", kind: "slower-than-walking", transitMin: 42, walkMin: 14 });
    expect(transitModeNoticeText(notice)).toBe(
      "Via Bus would take about 42 min against a 14 min walk, so it is not offered.",
    );
  });

  it("distinguishes no reachable stop from no connected journey", () => {
    const notices = transitModeNotices([
      { mode: "bus", outcome: "no-candidates" },
      { mode: "subway", outcome: "no-connected-journey" },
    ]);
    expect(transitModeNoticeText(notices[0])).toBe(
      "No bus stop within walking distance can be reached on foot, so Via Bus is not offered.",
    );
    expect(transitModeNoticeText(notices[1])).toBe(
      "No connected subway journey was found for this trip.",
    );
  });

  it("says nothing for a mode that ran and was offered", () => {
    expect(transitModeNotices([{ mode: "subway", outcome: "offered" }])).toEqual([]);
  });

  it("says nothing for a mode that never ran — that is the caller's case to word", () => {
    // Transit skipped under the distance gate, or the dataset was
    // unavailable: an outcome is absent, not a per-mode fact.
    expect(transitModeNotices([{ mode: "bus" }, { mode: "subway" }])).toEqual([]);
  });
});
