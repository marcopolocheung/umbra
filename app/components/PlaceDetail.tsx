import type { PlaceInfo } from "../hooks/useAppState";

interface PlaceDetailProps {
  place: PlaceInfo;
  onDirections: () => void;
  onBack: () => void;
}

export default function PlaceDetail({ place, onDirections, onBack }: PlaceDetailProps) {
  const reviewCount = place.reviewCount ?? 0;
  const price = place.priceLevel ?? "$$";

  const photos: string[] = place.photo ? [place.photo] : [];

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Back */}
      <button type="button"
        onClick={onBack}
        className="flex items-center gap-2 text-[13px] hover:underline self-start"
        style={{ color: "var(--color-ink-muted)" }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back
      </button>

      {/* Hero */}
      <div>
        <div className="font-display text-verdict font-semibold leading-tight tracking-[-0.02em]" style={{ color: "var(--color-ink)" }}>
          {place.name}
        </div>
        <div className="text-[13px] mt-1" style={{ color: "var(--color-ink-muted)" }}>
          {place.category ?? "Place"}
        </div>

        <div className="flex items-center gap-2 mt-2 text-[13px]" style={{ color: "var(--color-ink)" }}>
          <div className="flex items-center gap-1">
            <span className="font-semibold">{place.rating != null ? place.rating.toFixed(1) : "4.4"}</span>
            <span style={{ color: "var(--color-sun)" }}>★</span>
          </div>
          <span style={{ color: "var(--color-ink-faint)" }}>·</span>
          <span style={{ color: "var(--color-ink-muted)" }}>{reviewCount > 0 ? `${reviewCount} reviews` : "(reviews unavailable)"}</span>
          <span style={{ color: "var(--color-ink-faint)" }}>·</span>
          <span style={{ color: "var(--color-ink-muted)" }}>{price}</span>
        </div>
      </div>

      {/* Action buttons row (FEATURE.md) */}
      <div className="flex gap-2 overflow-x-auto -mx-1 px-1 pb-1">
        <ActionPill label="Directions" onClick={onDirections} icon="directions" />
        <ActionPill label="Start" onClick={() => {}} icon="start" />
        <ActionPill label="Save" onClick={() => {}} icon="save" />
        <ActionPill label="Nearby" onClick={() => {}} icon="nearby" />
        <ActionPill label="Share" onClick={() => {}} icon="share" />
      </div>

      {/* Photo strip */}
      <div className="flex gap-2 overflow-x-auto">
        {photos.length > 0 ? (
          photos.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={place.name}
              className="h-20 w-28 object-cover rounded-xl border"
              style={{ borderColor: "var(--color-hairline)" }}
            />
          ))
        ) : (
          [0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 w-28 rounded-xl border flex items-center justify-center text-[11px]"
              style={{ borderColor: "var(--color-hairline)", color: "var(--color-ink-faint)", background: "var(--color-canvas)" }}
            >
              Photo
            </div>
          ))
        )}
      </div>

      {/* Info rows */}
      <div className="flex flex-col border rounded-2xl overflow-hidden" style={{ borderColor: "var(--color-hairline)" }}>
        <InfoRow
          icon="pin"
          label={place.address ?? "Address unavailable"}
          rightAction={place.address ? (
            <button type="button"
              onClick={async () => {
                try { await navigator.clipboard.writeText(place.address ?? ""); } catch { /* ignore */ }
              }}
              className="text-[12px] px-2 py-1 rounded-lg"
              style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
            >
              Copy
            </button>
          ) : undefined}
        />
        <Divider />
        <InfoRow icon="clock" label={place.hours ?? "Hours unavailable"} rightText="" />
        <Divider />
        <InfoRow icon="phone" label={place.phone ?? "Phone unavailable"} rightText={place.phone ? "Call" : ""} />
        <Divider />
        <InfoRow icon="link" label={place.website ?? "Website unavailable"} rightText={place.website ? "Open" : ""} />
        <Divider />
        <InfoRow icon="wheelchair" label="Accessibility info" rightText="" />
      </div>

      {/* Reviews section (placeholder) */}
      <section>
        <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-ink)" }}>Reviews</h3>
        <div className="mt-2 border rounded-2xl p-3" style={{ borderColor: "var(--color-hairline)", background: "var(--color-raised)" }}>
          <div className="text-[12px]" style={{ color: "var(--color-ink-muted)" }}>
            Reviews are not available from the current data source. Showing placeholders.
          </div>
          <div className="mt-3 grid grid-cols-5 gap-1">
            {[5,4,3,2,1].map((s, idx) => (
              <div key={s} className="flex flex-col items-start gap-1">
                <div className="text-[10px]" style={{ color: "var(--color-ink-muted)" }}>{s}★</div>
                <div className="w-full h-1.5 rounded-full" style={{ background: "var(--color-hairline)" }}>
                  <div className="h-1.5 rounded-full" style={{ width: `${[65,18,10,5,2][idx]}%`, background: "var(--color-sun)" }} />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="border rounded-2xl p-3" style={{ borderColor: "var(--color-hairline)", background: "var(--color-raised)" }}>
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full" style={{ background: "var(--color-hairline)" }} />
                  <div className="flex-1">
                    <div className="text-[13px] font-semibold" style={{ color: "var(--color-ink)" }}>User</div>
                    <div className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>2 weeks ago</div>
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--color-ink-muted)" }}>★★★★★</div>
                </div>
                <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-muted)" }}>
                  Great place. Placeholder review text.
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* About / From the owner */}
      <section>
        <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-ink)" }}>About</h3>
        <div className="mt-2 border rounded-2xl p-3" style={{ borderColor: "var(--color-hairline)" }}>
          <div className="text-[12px] leading-relaxed" style={{ color: "var(--color-ink-muted)" }}>
            {place.description ?? "No description available. (Placeholder)"}
          </div>
        </div>
      </section>

      {/* People also search for */}
      <section>
        <h3 className="text-[14px] font-semibold" style={{ color: "var(--color-ink)" }}>People also search for</h3>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {["Coffee", "Lunch", "Bars", "Parks", "Museums"].map((t) => (
            <button type="button"
              key={t}
              className="px-3 py-2 rounded-full text-[12px] whitespace-nowrap"
              style={{ background: "var(--color-canvas)", color: "var(--color-ink-muted)" }}
            >
              {t}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Divider() {
  return <div className="h-px" style={{ background: "var(--color-hairline)" }} />;
}

function ActionPill({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: "directions" | "start" | "save" | "nearby" | "share";
  onClick: () => void;
}) {
  const Icon = () => {
    const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    switch (icon) {
      case "directions":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M12 2l8 10-8 10L4 12 12 2z" />
            <path d="M12 8v8" />
            <path d="M9 11h3" />
          </svg>
        );
      case "start":
        return (
          <svg {...common} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M10 8l6 4-6 4V8z" />
          </svg>
        );
      case "save":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M6 3h12v18l-6-4-6 4V3z" />
          </svg>
        );
      case "nearby":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
        );
      case "share":
        return (
          <svg {...common} aria-hidden="true">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.7" y1="11" x2="15.3" y2="6.8" />
            <line x1="8.7" y1="13" x2="15.3" y2="17.2" />
          </svg>
        );
    }
  };

  return (
    <button type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center shrink-0 px-3 py-2 rounded-2xl"
      style={{ background: "var(--color-canvas)", color: "var(--color-ink)", minWidth: 74 }}
    >
      <Icon />
      <div className="mt-1 text-[11px]">{label}</div>
    </button>
  );
}

function InfoRow({
  icon,
  label,
  rightText,
  rightAction,
}: {
  icon: "pin" | "clock" | "phone" | "link" | "wheelchair";
  label: string;
  rightText?: string;
  rightAction?: React.ReactNode;
}) {
  const Icon = () => {
    const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    switch (icon) {
      case "pin":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M12 21s7-4.5 7-11a7 7 0 0 0-14 0c0 6.5 7 11 7 11z" />
            <circle cx="12" cy="10" r="2.5" />
          </svg>
        );
      case "clock":
        return (
          <svg {...common} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6l4 2" />
          </svg>
        );
      case "phone":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7c.1.8.3 1.6.6 2.4a2 2 0 0 1-.5 2.1L9 10.4a16 16 0 0 0 4.6 4.6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.6.5 2.4.6a2 2 0 0 1 1.7 2z" />
          </svg>
        );
      case "link":
        return (
          <svg {...common} aria-hidden="true">
            <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1" />
            <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1" />
          </svg>
        );
      case "wheelchair":
        return (
          <svg {...common} aria-hidden="true">
            <circle cx="8" cy="8" r="2" />
            <path d="M8 10v6a4 4 0 0 0 4 4" />
            <path d="M12 14h6l-1 4" />
            <circle cx="12" cy="20" r="2" />
          </svg>
        );
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="shrink-0" style={{ color: "var(--color-ink-muted)" }}>
        <Icon />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] truncate" style={{ color: "var(--color-ink)" }}>{label}</div>
      </div>
      {rightAction ? (
        <div className="shrink-0">{rightAction}</div>
      ) : rightText ? (
        <div className="shrink-0 text-[12px]" style={{ color: "var(--color-route)" }}>{rightText}</div>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-ink-faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </div>
  );
}
