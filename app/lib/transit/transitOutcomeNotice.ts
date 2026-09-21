/**
 * Words for a mode the panel cannot offer (Stage H of the routing repair).
 *
 * The distinction that matters to a rider: "no connected journey was found" is
 * a fact about the network; "slower than walking" is a fact about this trip;
 * "no stop is reachable on foot" is a fact about the street graph around
 * them. Collapsing all three into an empty mode — which is what silent
 * omission was — answers none of them.
 *
 * Notices are strings the panel already knows how to display (`navWarning`);
 * keeping them here keeps the product wording in one module, like
 * `transitGate` keeps the policy.
 */

import type { TransitSearchOutcome } from "../trainGraph";

export type TransitModeNoticeKind =
  | "slower-than-walking"
  | "access-unavailable"
  | "no-connected-journey";

export interface TransitModeNotice {
  mode: "subway" | "bus";
  kind: TransitModeNoticeKind;
  /** Rounded minutes, present only where the numbers exist. */
  transitMin?: number;
  walkMin?: number;
}

const MODE_NAME: Record<"subway" | "bus", string> = {
  subway: "Via Subway",
  bus: "Via Bus",
};

const MODE_PLAIN: Record<"subway" | "bus", string> = {
  subway: "subway",
  bus: "bus",
};

/** Renders one mode's notice in the panel's voice. */
export function transitModeNoticeText(notice: TransitModeNotice): string {
  switch (notice.kind) {
    case "slower-than-walking":
      return `${MODE_NAME[notice.mode]} would take about ${notice.transitMin} min against a ${notice.walkMin} min walk, so it is not offered.`;
    case "access-unavailable":
      return `No ${MODE_PLAIN[notice.mode]} stop within walking distance can be reached on foot, so ${MODE_NAME[notice.mode]} is not offered.`;
    case "no-connected-journey":
      return `No connected ${MODE_PLAIN[notice.mode]} journey was found for this trip.`;
  }
}

/**
 * Turns the per-mode search records into the notice list for one calculation.
 *
 * - `outcome` is `findBestTransitRoute`'s conclusion for the mode.
 * - `dominatedMin` is set when an offer was found but suppressed by the
 *   walking-dominance gate; its minutes are the honest door-to-door figures.
 * - Absent outcome (mode never ran — transit skipped entirely, dataset
 *   unavailable) produces no notice here; the caller words that case, because
 *   it is a fact about the calculation rather than about one mode.
 */
export function transitModeNotices(
  records: Array<{
    mode: "subway" | "bus";
    outcome?: TransitSearchOutcome;
    dominatedMin?: { transitMin: number; walkMin: number };
  }>,
): TransitModeNotice[] {
  const notices: TransitModeNotice[] = [];
  for (const record of records) {
    if (record.outcome === undefined || record.outcome === "offered") {
      if (record.dominatedMin) {
        notices.push({ mode: record.mode, kind: "slower-than-walking", ...record.dominatedMin });
      }
      continue;
    }
    notices.push({
      mode: record.mode,
      kind:
        record.outcome === "no-candidates" ? "access-unavailable" : "no-connected-journey",
    });
  }
  return notices;
}
