# Assistant memory — the typed-slot store (S3a)

Added 2026-10-02 by Track S checkpoint S3a. This note documents the store's contract only —
the loop integration is S3b and the evaluation program belongs to Track C (C13 / S3c).

## What it is

`app/lib/memory/` — a **typed-slot** memory for the assistant, persisted to `localStorage`
(`umbra:memory`). Not free text, not embeddings, not a vector store (ROADMAP anti-goal). Six
slot kinds exist: `lodging`, `origin`, `sunTolerance`, `avoidPlace`, `tripDates`,
`departureTime`. Each kind validates its value's shape (`slotShape.ts`); a value whose shape
doesn't match the slot is refused at write time.

## Bi-temporal values, provenance, supersede-not-delete

Every stored value (`SlotValue` in `types.ts`) carries:

- `validFrom` / `validUntil` — the wall-clock window the fact is true for (`null` until = no
  known end), so "I'm at this hotel until the 5th" is first-class;
- `recordedAt` — when the write happened;
- `turnId` + `source` — **provenance**: which turn wrote it, and whether the authority was a
  direct user statement, a confirmed tool result, or a user edit of the memory panel.

A new write to the same slot **supersedes, never deletes**: the old value stays in history,
closed (`supersededBy` id + `validUntil` clipped to the new value's `validFrom`). The only
hard delete is `deleteSlot`, reserved for the user's memory panel.

**Resolution is deterministic code, not the model** (`resolve(slot, now)`): the value whose
validity window contains `now`, latest `validFrom` wins. Nothing stored → `null` → the
assistant must ask, not invent. A superseded value whose replacement is not yet valid still
resolves until the replacement becomes valid — supersession is a fact about the future
timeline, not a retroactive erasure.

## Write policy (the poison boundary, aligned with C10)

Only three sources may write: a **direct user statement**, a **confirmed tool result**, or a
**user edit**. Confirmed tool results are an allowlist (`locate_user`, `plot_points`,
`set_time`) of tools that confirm the user's own facts. Provider-text tools — `search_places`
(Foursquare/OSM), `geocode_place` (Nominatim) — are rejected outright, as is any unknown tool
name: third-party prose can never acquire memory authority, the same boundary C10 enforces for
tool authority. This is the defense against the known memory-poisoning class (ChatGPT's 2024
exfil, the July 2026 email-borne false-memory attack).

## What it must beat (measured later, not here)

S3c measures this store in Track C's harness against the **no-memory baseline** and the
**full-history-in-prompt baseline** (slot-write precision/recall, latest-value accuracy,
false-use rate). On LoCoMo the full-history baseline (72.9%) beat Mem0's own published score,
so a tie at a few dozen facts is a likely and reportable outcome. S3a ships the store; it
claims no evaluation result.
