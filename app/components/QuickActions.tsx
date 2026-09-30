interface QuickActionsProps {
  onNavigate: () => void;
  onDrawRoute: () => void;
  drawMode: boolean;
}

export default function QuickActions({ onNavigate, onDrawRoute, drawMode }: QuickActionsProps) {
  return (
    <div className="p-4 rounded-xl" style={{ background: "var(--color-panel)", border: "1px solid var(--color-rule)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-ink-muted animate-pulse" />
        <span className="text-[11px] uppercase tracking-widest font-bold text-ink-muted">Device Idle</span>
      </div>
      <h3 className="text-sm font-bold mb-2" style={{ color: "var(--color-ink)" }}>Quick Entry</h3>
      <div className="grid grid-cols-2 gap-2">
        <button type="button"
          onClick={onNavigate}
          className="flex flex-col items-center justify-center p-3 bg-panel shadow-hard-1 rounded-xl hover:bg-ground transition-colors"
        >
          <span className="material-symbols-outlined text-ink mb-1">route</span>
          <span className="text-[11px] font-bold" style={{ color: "var(--color-ink)" }}>Directions</span>
        </button>
        <button type="button"
          onClick={onDrawRoute}
          className={`flex flex-col items-center justify-center p-3 shadow-sm rounded-xl transition-colors ${
            drawMode ? "bg-ground ring-1 ring-rule-strong" : "bg-panel hover:bg-ground"
          }`}
        >
          <span className="material-symbols-outlined text-ink mb-1">draw</span>
          <span className="text-[11px] font-bold" style={{ color: "var(--color-ink)" }}>Draw Route</span>
        </button>
      </div>
    </div>
  );
}
