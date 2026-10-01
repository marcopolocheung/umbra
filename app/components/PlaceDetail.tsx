import type { ReactNode } from "react";
import type { PlaceInfo } from "../hooks/useAppState";
import Kicker from "./ui/Kicker";

interface PlaceDetailProps {
  place: PlaceInfo;
  onDirections: () => void;
  onBack: () => void;
}

/**
 * A place as a guidebook entry: category plate, the name as its heading, then
 * ruled lines for only the facts the search actually returned. A fact the
 * provider did not give is named as missing once, never drawn as an empty row
 * or a fallback value (a "$$" price, placeholder photos and no-op actions used
 * to stand in for data nobody had).
 */
export default function PlaceDetail({ place, onDirections, onBack }: PlaceDetailProps) {
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

      {place.photo && (
        <img
          src={place.photo}
          alt={place.name}
          className="aspect-video w-full border-2 object-cover"
          style={{ borderColor: "var(--color-ink)" }}
        />
      )}

      <dl className="m-0 border-y-2" style={{ borderColor: "var(--color-ink)" }}>
        <EntryLine term="Address">
          {place.address ? (
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0">{place.address}</span>
              <button
                type="button"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(place.address ?? ""); } catch { /* ignore */ }
                }}
                className="min-h-11 shrink-0 px-2 font-extrabold uppercase tracking-wider underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current"
                style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}
              >
                Copy
              </button>
            </span>
          ) : (
            <span style={{ color: "var(--color-ink-muted)" }}>Not in the search result</span>
          )}
        </EntryLine>
        {place.hours && <EntryLine term="Hours">{place.hours}</EntryLine>}
        {place.phone && (
          <EntryLine term="Phone">
            <a href={`tel:${place.phone}`} className="underline">{place.phone}</a>
          </EntryLine>
        )}
        {place.website && (
          <EntryLine term="Website">
            <a href={place.website} target="_blank" rel="noopener noreferrer" className="break-all underline">
              {place.website}
            </a>
          </EntryLine>
        )}
        {place.rating != null && (
          <EntryLine term="Rating">
            <span className="tabular-nums font-extrabold" style={{ fontFamily: "var(--font-numeric)" }}>
              {place.rating.toFixed(1)}/10
            </span>
            {(place.reviewCount ?? 0) > 0 && (
              <span style={{ color: "var(--color-ink-muted)" }}> · {place.reviewCount} reviews</span>
            )}
          </EntryLine>
        )}
        {place.priceLevel && <EntryLine term="Price">{place.priceLevel}</EntryLine>}
      </dl>

      <button type="button" onClick={onDirections} className="umbra-start-button">
        Directions
      </button>

      {missing.length > 0 && (
        <p className="m-0" style={{ fontSize: "var(--text-caption)", color: "var(--color-ink-muted)" }}>
          This entry holds what the search returned. Not listed: {missing.join(", ")}.
        </p>
      )}

      {place.description && (
        <section>
          <Kicker>About</Kicker>
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
