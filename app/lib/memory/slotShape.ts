// app/lib/memory/slotShape.ts — S3a per-slot value validation.
// Typed slots: each kind accepts one fixed primitive/record shape. This is
// what makes the store "typed slots, not free text" — the store refuses a
// value whose shape does not match its slot kind.

import type { SlotKind } from "./types";

export interface SlotShape {
  /** Human-readable contract, for the memory panel and receipts (S3b). */
  description: string;
  isValid(value: unknown): boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLatLng = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const lat = v.lat;
  const lng = v.lng;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
};

export const SLOT_SHAPES: Record<SlotKind, SlotShape> = {
  lodging: {
    description: "{lat, lng} of where the walker is staying, optional label",
    isValid: (v): boolean => {
      if (!isRecord(v)) return false;
      return isLatLng(v) && (v.label === undefined || typeof v.label === "string");
    },
  },
  origin: {
    description: "{lat, lng} of the walker's last origin",
    isValid: isLatLng,
  },
  sunTolerance: {
    description: '"low" | "moderate" | "high" — the stated sun tolerance',
    isValid: (v): boolean => v === "low" || v === "moderate" || v === "high",
  },
  avoidPlace: {
    description: "{lat, lng, radiusM} of a place to route around",
    isValid: (v): boolean => {
      if (!isRecord(v)) return false;
      return isLatLng(v) && typeof v.radiusM === "number" && v.radiusM > 0;
    },
  },
  tripDates: {
    description: '{startIso: "YYYY-MM-DD", endIso: "YYYY-MM-DD"}',
    isValid: (v) =>
      isRecord(v) &&
      typeof v.startIso === "string" &&
      typeof v.endIso === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(v.startIso) &&
      /^\d{4}-\d{2}-\d{2}$/.test(v.endIso) &&
      v.endIso >= v.startIso,
  },
  departureTime: {
    description: "minutes past local midnight, 0–1439",
    isValid: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1439,
  },
};
