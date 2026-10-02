// app/lib/memory/__tests__/memoryStore.test.ts — S3a store invariants.
import { describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "../memoryStore";
import { SLOT_SHAPES } from "../slotShape";
import type { SlotValue, WriteSource } from "../types";

function memStore(): { store: MemoryStore; dump: () => Record<string, string> } {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  };
  return { store: createMemoryStore(storage), dump: () => Object.fromEntries(backing) };
}

const T0 = 1_000_000;
const user = (turnId: string): WriteSource => ({ kind: "userStatement", turnId });

function writeLodging(store: MemoryStore, lat: number, at: number, turn = "t1"): string | null {
  return store.write({
    slot: "lodging",
    value: { lat, lng: -74, label: "hotel" },
    validFrom: at,
    recordedAt: at,
    turnId: turn,
    source: user(turn),
  });
}

describe("memory store", () => {
  it("resolves deterministically in code, not by model", () => {
    const { store } = memStore();
    expect(store.resolve("lodging", T0)).toBeNull(); // abstain: nothing stored
    writeLodging(store, 40.7, T0);
    const got = store.resolve("lodging", T0 + 10);
    expect(got?.value).toEqual({ lat: 40.7, lng: -74, label: "hotel" });
  });

  it("resolves the latest validFrom and skips not-yet-valid values", () => {
    const { store } = memStore();
    writeLodging(store, 40.7, T0); // valid from T0
    writeLodging(store, 40.8, T0 + 100); // valid from T0+100
    expect(store.resolve("lodging", T0 + 50)?.value).toEqual({
      lat: 40.7,
      lng: -74,
      label: "hotel",
    });
    expect(store.resolve("lodging", T0 + 150)?.value).toEqual({
      lat: 40.8,
      lng: -74,
      label: "hotel",
    });
  });

  it("expires values past validUntil", () => {
    const { store } = memStore();
    store.write({
      slot: "lodging",
      value: { lat: 40.7, lng: -74 },
      validFrom: T0,
      validUntil: T0 + 50,
      recordedAt: T0,
      turnId: "t1",
      source: user("t1"),
    });
    expect(store.resolve("lodging", T0 + 10)).not.toBeNull();
    expect(store.resolve("lodging", T0 + 51)).toBeNull(); // expired: abstain
  });

  it("supersedes, never deletes: the closed value stays in history", () => {
    const { store } = memStore();
    writeLodging(store, 40.7, T0, "t1");
    writeLodging(store, 40.8, T0 + 100, "t2");
    const history = store.history("lodging");
    expect(history).toHaveLength(2);
    const closed = history.find((v) => (v.value as { lat: number }).lat === 40.7) as SlotValue;
    expect(closed.supersededBy).toBe("lodging:1");
    expect(closed.validUntil).toBe(T0 + 100); // closed at the new value's start
    expect(store.resolve("lodging", T0 + 100)?.value).toEqual({
      lat: 40.8,
      lng: -74,
      label: "hotel",
    });
  });

  it("write policy: a confirmed tool result may write, with provenance kept", () => {
    const { store } = memStore();
    const id = store.write({
      slot: "origin",
      value: { lat: 40.71, lng: -74 },
      recordedAt: T0,
      turnId: "t3",
      source: {
        kind: "confirmedToolResult",
        toolName: "locate_user",
        resultId: "r9",
        turnId: "t3",
      },
    });
    expect(id).not.toBeNull();
    const got = store.resolve("origin", T0);
    expect(got?.source).toEqual({
      kind: "confirmedToolResult",
      toolName: "locate_user",
      resultId: "r9",
      turnId: "t3",
    });
    expect(got?.turnId).toBe("t3"); // which turn wrote it
  });

  it("write policy: provider-text tools (Foursquare, Nominatim) never write", () => {
    const { store } = memStore();
    for (const toolName of ["search_places", "geocode_place"]) {
      const id = store.write({
        slot: "lodging",
        value: { lat: 40.7, lng: -74, label: "Pizzeria 2 Girls" },
        recordedAt: T0,
        turnId: "t4",
        source: { kind: "confirmedToolResult", toolName, resultId: "r1", turnId: "t4" },
      });
      expect(id).toBeNull();
    }
    expect(store.resolve("lodging", T0)).toBeNull();
  });

  it("write policy: unknown tool names are not confirmed tool results", () => {
    const { store } = memStore();
    const id = store.write({
      slot: "lodging",
      value: { lat: 1, lng: 2 },
      recordedAt: T0,
      turnId: "t5",
      source: {
        kind: "confirmedToolResult",
        toolName: "made_up_tool",
        resultId: "r",
        turnId: "t5",
      },
    });
    expect(id).toBeNull();
  });

  it("refuses values whose shape does not match the slot kind", () => {
    const { store } = memStore();
    expect(
      store.write({
        slot: "sunTolerance",
        value: "sky-high",
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).toBeNull();
    expect(
      store.write({
        slot: "departureTime",
        value: 1440,
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).toBeNull();
    expect(
      store.write({
        slot: "tripDates",
        value: { startIso: "2026-10-05", endIso: "2026-10-01" },
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).toBeNull();
    expect(
      store.write({
        slot: "avoidPlace",
        value: "that pizzeria",
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).toBeNull();
    // a plausible-shaped value goes through
    expect(
      store.write({
        slot: "sunTolerance",
        value: "moderate",
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).not.toBeNull();
  });

  it("refuses a validity window that ends before it starts", () => {
    const { store } = memStore();
    expect(
      store.write({
        slot: "lodging",
        value: { lat: 40.7, lng: -74 },
        validFrom: T0 + 10,
        validUntil: T0,
        recordedAt: T0,
        turnId: "t",
        source: user("t"),
      }),
    ).toBeNull();
  });

  it("persists to localStorage and reloads from a cold store", () => {
    const { store, dump } = memStore();
    writeLodging(store, 40.7, T0);
    expect(dump()["umbra:memory"]).toContain("lodging");
    const backing = new Map([["umbra:memory", dump()["umbra:memory"]]]);
    const cold = createMemoryStore({
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
    });
    expect(cold.resolve("lodging", T0)?.value).toEqual({ lat: 40.7, lng: -74, label: "hotel" });
  });

  it("tolerates a corrupt payload by abstaining, not crashing", () => {
    const backing = new Map([["umbra:memory", "{not json"]]);
    const store = createMemoryStore({
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
    });
    expect(store.resolve("lodging", T0)).toBeNull();
    expect(store.history("lodging")).toEqual([]);
  });

  it("deleteSlot is the only hard remove, and only the user's", () => {
    const { store } = memStore();
    writeLodging(store, 40.7, T0);
    store.deleteSlot("lodging");
    expect(store.resolve("lodging", T0)).toBeNull();
    expect(store.history("lodging")).toEqual([]);
  });

  it("every slot kind has a shape description", () => {
    for (const shape of Object.values(SLOT_SHAPES)) {
      expect(shape.description.length).toBeGreaterThan(0);
    }
  });
});
