/**
 * Turns a transit answer's provenance into something a rider can read (#410).
 *
 * The published manifest carries six honesty statements and a feed window, and
 * `shardContract.ts` says of them: "the honesty statements the transit card has
 * to surface. Never drop these." Nothing outside the parser read them, so the
 * card quoted `incl. ~4 min wait` without ever saying that the wait is one
 * representative date's schedule, is not traffic-aware, and comes from a feed
 * with an expiry date.
 *
 * Two rules here, both deliberate:
 *
 * **The notes are shown verbatim, never paraphrased.** They are the producer's
 * own words about what its numbers do and do not mean; rewriting them in the
 * client is how a caveat quietly becomes weaker than the thing it qualifies.
 *
 * **Which notes are rider-facing is decided by shape, not by index.** Two of the
 * six describe the wire format for whoever writes a client — how route geometry
 * ships, and that headway hours run 0-27 — and mean nothing to someone
 * deciding whether to wait for a train. Matching them by position in the array
 * would break silently the first time the pipeline adds a note, so they are
 * matched on their own subject matter and the default is to **show** a note we
 * do not recognise, because a new note is more likely to be a new caveat than a
 * new contract detail.
 */

import type { TransitProvenance } from "./trainGraph";

/**
 * Notes about the wire format rather than about the ride. Deliberately narrow:
 * anything unmatched is shown.
 */
const CLIENT_CONTRACT_NOTE = /^(Route geometry ships per edge|Headway hours are service-day hours)/;

/** `YYYYMMDD` → `31 Oct 2026`. Returns null on anything else. */
export function formatFeedDate(yyyymmdd: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The statements a rider should see, in the producer's own words. */
export function riderFacingNotes(provenance: TransitProvenance | undefined): string[] {
  if (!provenance) return [];
  return provenance.notes.filter((note) => !CLIENT_CONTRACT_NOTE.test(note));
}

/**
 * The earliest expiry across the feeds behind this answer, as `YYYYMMDD`.
 *
 * Earliest, not latest: the answer is only as current as the first feed to go
 * stale, and the subway feed expires months before the bus feeds do.
 */
export function earliestFeedExpiry(provenance: TransitProvenance | undefined): string | null {
  if (!provenance) return null;
  const dates = Object.values(provenance.schedulesAsOf)
    .map((feed) => feed.endDate)
    .filter((date) => /^\d{8}$/.test(date))
    .sort();
  return dates[0] ?? null;
}

/**
 * The one line the card always shows beside a quoted time.
 *
 * `null` when there is no published timetable at all — the Overpass producer
 * makes none of these claims, so it must not borrow their wording.
 */
export function transitScheduleLine(provenance: TransitProvenance | undefined): string | null {
  if (!provenance) return null;
  const expiry = earliestFeedExpiry(provenance);
  const formatted = expiry ? formatFeedDate(expiry) : null;
  return formatted
    ? `Scheduled timetable, valid to ${formatted} — not live times`
    : "Scheduled timetable — not live times";
}

/** Whether the feeds behind this answer have already lapsed, as of `now`. */
export function isTimetableExpired(
  provenance: TransitProvenance | undefined,
  now: Date = new Date(),
): boolean {
  const expiry = earliestFeedExpiry(provenance);
  if (!expiry) return false;
  const today = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
  return expiry < today;
}
