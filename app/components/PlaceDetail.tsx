import { type ReactNode, useState } from "react";
import type { PlaceInfo } from "../hooks/useAppState";
import Kicker from "./ui/Kicker";

interface PlaceDetailProps {
  place: PlaceInfo;
  onDirections: () => void;
  onBack: () => void;
}

/**
 * A place as a guidebook entry: category plate, the name as its heading, then
 * ruled lines for only the facts this entry holds. A fact it does not hold is
 * named as missing once, never drawn as an empty row or a fallback value (a
 * "$$" price, placeholder photos and no-op actions used to stand in for data
 * nobody had). The caption says "not shown here", not "not returned": the
 * search can carry hours and a rating that the selection does not pass on yet.
 */
export default function PlaceDetail({ place, onDirections, onBack }: PlaceDetailProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const missing = [
    !place.hours && "hours",
    !place.phone && "phone",
    !place.website && "website",
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <article className="flex flex-col gap-4 p-4" style={{ color: "var(--color-ink)" }}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 flex min-h-11 items-center gap-1 self-start px-2 font-semibold hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
        style={{ fontSize: "var(--text-small)" }}
      >
        <span className="material-symbols-outlined text-lg" aria-hidden="true">chevron_left</span>
        Back
      </button>

      <header className="flex flex-col items-start gap-2">
        <Kicker plated>{place.category || "Place"}</Kicker>
        <h2 className="font-display text-verdict font-semibold leading-tight">{place.name}</h2>
      </header>

      {/* Directly under the heading, so the action sits inside the sheet's first snap
          point however many lines the entry grows. */}
      <button type="button" onClick={onDirections} className="umbra-start-button">
        Directions
      </button>

      <dl className="m-0 border-y-2" style={{ borderColor: "var(--color-ink)" }}>
        <EntryLine term="Address">
          {place.address ? (
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0">{place.address}</span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(place.address ?? "");
                    setCopyState("copied");
                  } catch {
                    setCopyState("failed");
                  }
                }}
                aria-label="Copy address"
                className="min-h-11 shrink-0 px-2 font-extrabold uppercase tracking-wider underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
                style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}
              >
                <span aria-live="polite">{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}</span>
              </button>
            </span>
          ) : (
            <span style={{ color: "var(--color-ink-muted)" }}>No address on file</span>
          )}
        </EntryLine>
        {place.hours && <EntryLine term="Hours">{place.hours}</EntryLine>}
        {place.phone && (
          <EntryLine term="Phone">
            <a href={`tel:${place.phone.replace(/\s+/g, "")}`} className="inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current">
              {place.phone}
            </a>
          </EntryLine>
        )}
        {place.website && (
          <EntryLine term="Website">
            <a href={place.website} target="_blank" rel="noopener noreferrer" className="break-all inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current">
              {place.website}
            </a>
          </EntryLine>
        )}
        {place.rating != null && (
          <EntryLine term="Rating">
            <span className="tabular-nums font-extrabold" style={{ fontFamily: "var(--font-numeric)" }}>
              {place.rating.toFixed(1)}/10
            </span>
            <span style={{ color: "var(--color-ink-muted)" }}>
              {(place.reviewCount ?? 0) > 0 && ` · ${place.reviewCount} reviews`} · Foursquare
            </span>
          </EntryLine>
        )}
        {place.priceLevel && <EntryLine term="Price">{place.priceLevel}</EntryLine>}
      </dl>

      {missing.length > 0 && (
        <p className="m-0" style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
          Not shown here: {missing.join(", ")}.
        </p>
      )}

      {place.photo && (
        <img
          src={place.photo}
          alt=""
          className="aspect-video w-full border-2 object-cover"
          style={{ borderColor: "var(--color-ink)" }}
        />
      )}

      {place.description && (
        <section>
          <h3 className="umbra-kicker m-0">About</h3>
          <p className="mt-1 leading-relaxed" style={{ fontSize: "var(--text-small)" }}>{place.description}</p>
        </section>
      )}
    </article>
  );
}

/** One ruled guidebook line: a stamped term over or beside its value. */
function EntryLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline gap-2 border-b py-2 last:border-b-0" style={{ borderColor: "var(--color-rule)" }}>
      <dt className="umbra-kicker">{term}</dt>
      <dd className="m-0 min-w-0" style={{ fontSize: "var(--text-body)" }}>{children}</dd>
    </div>
  );
}
