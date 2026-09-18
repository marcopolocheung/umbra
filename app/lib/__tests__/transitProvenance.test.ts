import { describe, expect, it } from "vitest";
import type { TransitProvenance } from "../trainGraph";
import {
  earliestFeedExpiry,
  formatFeedDate,
  isTimetableExpired,
  riderFacingNotes,
  transitScheduleLine,
} from "../transitProvenance";

/** The six notes the pipeline actually publishes, verbatim. */
const PUBLISHED_NOTES = [
  "Each headway table is one representative date's schedule, chosen as the most common service pattern on or after 20260917 (see headwayDates); calendar_dates exceptions are applied, so holidays, school-holiday variants and pick boundaries run a different timetable than the table shows.",
  "Bus travel times are scheduled, not traffic-aware; no realtime data is used.",
  "Route geometry ships per edge, where the edge could be sliced: `geom` is a Google encoded polyline (precision 5) of the GTFS shape points strictly between the two stops, taken from the shape the trips serving that edge run on. An edge carrying no `geom` either has a shape that doubles back between its stops or has both stops on one shape segment; a client draws the straight chord there. `distM` is the along-track length of the slice where one exists, and the straight-line haversine between the two stops where none does.",
  "Subway stops carry changeSec, the feed's own cost for changing lines inside that station (0 at cross-platform interchanges). Stations the feed prices no change for leave it unset rather than defaulted; changing lines there is unpriced.",
  "Bus stop wait exposure assumes unsheltered stops (GTFS carries no shelter geometry).",
  "Headway hours are service-day hours 0-27, not wall-clock hours: hours 24-27 are the early morning of headwayDates[dataset][dayType].nextDate, whose day type is given as nextDayType. Hours 0-3 and 24-27 are different calendar days and must not be merged.",
];

function provenance(overrides: Partial<TransitProvenance> = {}): TransitProvenance {
  return {
    generation: "nyc-2026-09-17-af01f9ffbdc5",
    notes: PUBLISHED_NOTES,
    schedulesAsOf: {
      subway: { version: "v", startDate: "20260526", endDate: "20261031" },
      "bus-si": { version: "v", startDate: "20260906", endDate: "20270102" },
    },
    ...overrides,
  };
}

describe("transit provenance", () => {
  it("shows the rider the caveats and hides the wire-format ones", () => {
    const notes = riderFacingNotes(provenance());
    // What a rider needs: the timetable is one date's, and the stop is assumed
    // unsheltered.
    expect(notes.some((n) => n.startsWith("Each headway table"))).toBe(true);
    expect(notes.some((n) => n.startsWith("Bus stop wait exposure"))).toBe(true);
    expect(notes.some((n) => n.startsWith("Bus travel times are scheduled"))).toBe(true);
    // What only a client author needs.
    expect(notes.some((n) => n.startsWith("Route geometry ships per edge"))).toBe(false);
    expect(notes.some((n) => n.startsWith("Headway hours are service-day"))).toBe(false);
    expect(notes).toHaveLength(4);
  });

  it("shows a note it does not recognise rather than swallowing it", () => {
    // A new note is far more likely to be a new caveat than a new contract
    // detail, and silently dropping one is the defect this issue is about.
    const notes = riderFacingNotes(
      provenance({ notes: [...PUBLISHED_NOTES, "Ferry times are estimated from AIS."] }),
    );
    expect(notes).toContain("Ferry times are estimated from AIS.");
  });

  it("never paraphrases a note", () => {
    // The producer's own words about what its numbers mean. Rewriting them in
    // the client is how a caveat becomes weaker than what it qualifies.
    for (const note of riderFacingNotes(provenance())) {
      expect(PUBLISHED_NOTES).toContain(note);
    }
  });

  it("takes the earliest expiry, not the latest", () => {
    // The answer is only as current as the first feed to go stale: the subway
    // feed lapses two months before the bus feeds do.
    expect(earliestFeedExpiry(provenance())).toBe("20261031");
  });

  it("states the schedule window in words a rider reads", () => {
    expect(transitScheduleLine(provenance())).toBe(
      "Scheduled timetable, valid to 31 Oct 2026 — not live times",
    );
  });

  it("says nothing at all when there is no published timetable", () => {
    // The Overpass producer makes none of these claims and must not borrow
    // their wording.
    expect(transitScheduleLine(undefined)).toBeNull();
    expect(riderFacingNotes(undefined)).toEqual([]);
    expect(earliestFeedExpiry(undefined)).toBeNull();
    expect(isTimetableExpired(undefined)).toBe(false);
  });

  it("knows when the timetable it is quoting has lapsed", () => {
    // The subway feed expires 2026-10-31 and nothing in the app can move it,
    // so the card has to be able to say the times are out of date.
    expect(isTimetableExpired(provenance(), new Date("2026-10-30T12:00:00Z"))).toBe(false);
    expect(isTimetableExpired(provenance(), new Date("2026-11-01T12:00:00Z"))).toBe(true);
  });

  it("degrades rather than throwing on a date it cannot read", () => {
    expect(formatFeedDate("nonsense")).toBeNull();
    const bad = provenance({
      schedulesAsOf: { subway: { version: "v", startDate: "x", endDate: "x" } },
    });
    expect(transitScheduleLine(bad)).toBe("Scheduled timetable — not live times");
    expect(isTimetableExpired(bad)).toBe(false);
  });
});
