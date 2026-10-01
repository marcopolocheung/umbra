import type { VerifiedAnswer } from "./receipts";

export interface GuideNote {
  text: string;
  claimIds: string[];
  action?: { label: "View route" | "View partial route"; mapObjectId: string };
}

/** Called only with the current, re-verified answer and map identities. */
export function guideNote(
  answer: VerifiedAnswer,
  stopIds: readonly string[],
  routeIds: readonly string[],
): GuideNote | null {
  const visibleClaims = new Set(
    answer.blocks.flatMap((block) => block.kind === "claim" ? [block.claimId] : []),
  );
  const verified = answer.receipts.filter(
    (receipt) => receipt.verification === "verified" && visibleClaims.has(receipt.claimId),
  );
  if (verified.length === 0) return null;

  const numbered = verified.flatMap((receipt) => {
    if (receipt.kind !== "place") return [];
    const index = stopIds.indexOf(receipt.mapObjectId);
    return index < 0 ? [] : [{ number: index + 1, claimId: receipt.claimId }];
  });
  numbered.sort((a, b) => a.number - b.number);
  const stops = numbered.filter((stop, index) => index === 0 || stop.number !== numbered[index - 1].number);
  const route = verified.find((receipt) =>
    receipt.kind === "route" &&
    receipt.mapObjectId === `route:${receipt.requestId}:${receipt.actionId}:${receipt.planRevision}` &&
    routeIds.includes(receipt.mapObjectId),
  );

  const parts: string[] = [];
  const claimIds = stops.map((stop) => stop.claimId);
  if (stops.length) {
    const numbers = stops.map((stop) => stop.number);
    const list = numbers.length === 1
      ? `${numbers[0]}`
      : `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
    parts.push(`${stops.length === 1 ? "Stop" : "Stops"} ${list} ${stops.length === 1 ? "is" : "are"} pinned. Tap a number to find ${stops.length === 1 ? "it" : "them"} on the map.`);
  }
  if (route?.kind === "route") {
    claimIds.push(route.claimId);
    parts.push(route.value.status === "partial"
      ? "A leg could not be routed; the route on the map is partial."
      : "The route is ready on the map.");
    return {
      text: parts.join(" "),
      claimIds,
      action: {
        label: route.value.status === "partial" ? "View partial route" : "View route",
        mapObjectId: route.mapObjectId,
      },
    };
  }
  if (parts.length) return { text: parts.join(" "), claimIds };

  // A verified shadow or time check still gets a short guide to its receipt.
  const shadowChecks = verified.filter((receipt) => receipt.kind === "shadow");
  const checks = shadowChecks.length
    ? shadowChecks
    : verified.filter((receipt) => receipt.kind === "time");
  if (!checks.length) return null;
  return {
    text: shadowChecks.length
      ? "The checked shadow is in the receipt above."
      : "The selected time is in the receipt above.",
    claimIds: checks.map((receipt) => receipt.claimId),
  };
}
