/**
 * When a transit offer is so much slower than walking that it only buries the
 * walking answers under a joke, it is suppressed.
 *
 * Two arms bound the same hole: a ratio alone punishes very short walks (a
 * 4-minute walk doubles at 6 minutes), and a fixed slack alone forgives very
 * long detours because the minutes look small next to an hour's walk. The two
 * figures are product decisions — tune them here, never at the call site.
 */

export const TRANSIT_DOMINANCE_MAX_RATIO = 2;

export const TRANSIT_DOMINANCE_SLACK_SEC = 15 * 60;

/**
 * True when the transit offer takes longer than both twice the quickest walk
 * and the quickest walk plus fifteen minutes. Invalid or missing seconds are
 * never dominated: with no walk to compare against, the transit offer stays.
 */
export function transitOptionDominated(transitSec: number, walkSec: number): boolean {
  if (!Number.isFinite(transitSec) || transitSec <= 0) return false;
  if (!Number.isFinite(walkSec) || walkSec <= 0) return false;
  return (
    transitSec >
    Math.max(TRANSIT_DOMINANCE_MAX_RATIO * walkSec, walkSec + TRANSIT_DOMINANCE_SLACK_SEC)
  );
}
