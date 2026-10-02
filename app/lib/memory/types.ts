// app/lib/memory/types.ts — S3a typed-slot memory store.
// Typed slots only: no free text, no embeddings, no vector store (ROADMAP anti-goal).

/** Slot kinds the store can hold. Fixed union — extending it is a deliberate act. */
export type SlotKind =
  | "lodging" // where the walker is staying (S3b/S4b consume this)
  | "origin" // where the walker last started from
  | "sunTolerance" // stated sun tolerance; S2b uses it as the prior override
  | "avoidPlace" // a place to route around (coordinate + radius)
  | "tripDates" // first/last day of the current trip
  | "departureTime"; // usual preferred departure, minutes past local midnight

/** How a value was written — the trust boundary (aligned with C10). */
export type WriteSource =
  | { kind: "userStatement"; turnId: string }
  | { kind: "confirmedToolResult"; toolName: string; resultId: string; turnId: string }
  // Third-party text (Foursquare, Nominatim, OSM display_name) may never appear
  // here: the store refuses such writes outright (see memoryStore.ts).
  | { kind: "userEdit" }; // the user editing the memory panel (S3b)

export interface SlotValue {
  /** What was written. Shape is per-kind; see slotShape(). */
  value: unknown;
  /** Validity window, epoch ms. Until `null` = still valid (no known end). */
  validFrom: number;
  validUntil: number | null;
  /** When this write happened, epoch ms. */
  recordedAt: number;
  /** Which turn wrote it. */
  turnId: string;
  /** Provenance: only a direct user statement, a confirmed tool result, or a user edit. */
  source: WriteSource;
  /** A later write superseded this one; the value stays closed, not deleted. */
  supersededBy?: string;
}

export interface SlotEntry {
  slot: SlotKind;
  /** Stable id: `${slot}` — one open value per slot at a time. */
  id: string;
  values: SlotValue[];
}

export interface MemorySnapshot {
  version: 1;
  entries: SlotEntry[];
}
