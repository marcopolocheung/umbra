// app/lib/memory/memoryStore.ts — S3a the store.
// Deterministic resolution in code, not the model. Superseded values are closed,
// not deleted. localStorage only; accounts stay declined (ROADMAP "Not doing").

import { SLOT_SHAPES } from "./slotShape";
import type { MemorySnapshot, SlotEntry, SlotKind, SlotValue, WriteSource } from "./types";

const STORAGE_KEY = "umbra:memory";
export const MEMORY_STORAGE_KEY = STORAGE_KEY;

const SLOT_KINDS: SlotKind[] = [
  "lodging",
  "origin",
  "sunTolerance",
  "avoidPlace",
  "tripDates",
  "departureTime",
];

/** Text that can never reach the provenance field: the write policy is what
 * keeps third-party strings (Foursquare, Nominatim, OSM display_name) from
 * poisoning the store. Provider text may enter no slot, from no source.
 * Unknown tool names are rejected too — a confirmed tool result must name a
 * tool Umbra's agent actually runs (agentLoop.ts's executor set). */
export const PROVIDER_TOOL_NAMES = new Set([
  "search_places", // Foursquare / OSM provider text
  "geocode_place", // Nominatim provider text
]);
export const CONFIRMABLE_TOOL_NAMES = new Set([
  "locate_user", // device position — the user's own confirmed fact
  "plot_points", // coordinates the user placed on the canvas
  "set_time", // a time change the user made in the UI
]);

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Injectable for tests. Defaults to the browser's localStorage. */
export function createMemoryStore(storage: StorageLike = globalThis.localStorage) {
  return {
    /** Read the snapshot, tolerating a missing or corrupt payload. */
    load(): MemorySnapshot {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return { version: 1, entries: [] };
        const parsed = JSON.parse(raw) as MemorySnapshot;
        return isSnapshot(parsed) ? parsed : { version: 1, entries: [] };
      } catch {
        return { version: 1, entries: [] };
      }
    },

    /** Write a slot value. Returns the stored value id, or null when the write
     * is refused by the write policy or fails validation. */
    write(input: {
      slot: SlotKind;
      value: unknown;
      /** Validity window, epoch ms. Defaults: valid from now, no known end. */
      validFrom?: number;
      validUntil?: number | null;
      recordedAt: number;
      turnId: string;
      source: WriteSource;
    }): string | null {
      if (input.source.kind === "confirmedToolResult") {
        if (!CONFIRMABLE_TOOL_NAMES.has(input.source.toolName)) {
          return null; // provider text or an unknown tool can never write
        }
      }
      if (!SLOT_KINDS.includes(input.slot)) return null;
      if (!SLOT_SHAPES[input.slot].isValid(input.value)) return null;
      if (
        input.validUntil !== undefined &&
        input.validUntil !== null &&
        input.validFrom !== undefined &&
        input.validUntil < input.validFrom
      ) {
        return null;
      }
      const snapshot = this.load();
      const entry = entryFor(snapshot, input.slot);
      const value: SlotValue = {
        value: input.value,
        validFrom: input.validFrom ?? input.recordedAt,
        validUntil: input.validUntil ?? null,
        recordedAt: input.recordedAt,
        turnId: input.turnId,
        source: input.source,
      };
      // Supersede-not-delete: the previously open value stays, closed.
      const open = entry.values.find((v) => v.supersededBy === undefined);
      const id = `${input.slot}:${entry.values.length}`;
      entry.values.push(value);
      if (open) {
        open.supersededBy = id;
        // A superseding write also closes the old value's validity at the new
        // value's start, so resolution has one unambiguous timeline per slot.
        open.validUntil = Math.min(open.validUntil ?? Number.POSITIVE_INFINITY, value.validFrom);
        if (!Number.isFinite(open.validUntil)) open.validUntil = null;
      }
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        return null; // full/corrupt storage: refuse, keep the in-memory truth
      }
      return id;
    },

    /** Deterministic current-value resolution: the open, unexpired value with
     * the latest validFrom at `now`. No model involvement. */
    resolve(slot: SlotKind, now: number): SlotValue | null {
      const entry = this.load().entries.find((e) => e.slot === slot);
      if (!entry) return null;
      let best: SlotValue | null = null;
      for (const v of entry.values) {
        // Superseded values are closed via validUntil (the new value's start),
        // so resolution is purely temporal — a superseded value whose
        // replacement is not yet valid still resolves until it becomes so.
        if (v.validFrom > now) continue; // not yet valid
        if (v.validUntil !== null && v.validUntil < now) continue; // expired
        if (best === null || v.validFrom > best.validFrom) best = v;
      }
      return best;
    },

    /** All values for a slot, newest-recorded first. Closed values included —
     * the panel (S3b) shows history; nothing is ever hard-deleted by writes. */
    history(slot: SlotKind): SlotValue[] {
      const entry = this.load().entries.find((e) => e.slot === slot);
      return entry ? [...entry.values].sort((a, b) => b.recordedAt - a.recordedAt) : [];
    },

    /** The user deleting an entry from the memory panel (S3b) is the one
     * explicit remove — it deletes the whole slot, history included. */
    deleteSlot(slot: SlotKind): void {
      const snapshot = this.load();
      snapshot.entries = snapshot.entries.filter((e) => e.slot !== slot);
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // refused; the stored copy stands
      }
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;

function entryFor(snapshot: MemorySnapshot, slot: SlotKind): SlotEntry {
  const existing = snapshot.entries.find((e) => e.slot === slot);
  if (existing) return existing;
  const entry: SlotEntry = { slot, id: slot, values: [] };
  snapshot.entries.push(entry);
  return entry;
}

function isSnapshot(value: unknown): value is MemorySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snap = value as MemorySnapshot;
  return snap.version === 1 && Array.isArray(snap.entries);
}
