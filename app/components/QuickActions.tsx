interface QuickActionsProps {
  onNavigate: () => void;
  onDrawRoute: () => void;
  drawMode: boolean;
}

export default function QuickActions({ onNavigate, onDrawRoute, drawMode }: QuickActionsProps) {
  return (
    <div className="p-4 rounded-xl" style={{ background: "var(--color-raised)", border: "1px solid var(--color-hairline)" }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-ink-faint animate-pulse" />
        <span className="text-[10px] uppercase tracking-widest font-bold text-ink-faint">Device Idle</span>
      </div>
      <h3 className="text-sm font-bold mb-2" style={{ color: "var(--color-ink)" }}>Quick Entry</h3>
      <div className="grid grid-cols-2 gap-2">
        <button type="button"
          onClick={onNavigate}
          className="flex flex-col items-center justify-center p-3 bg-raised shadow-level-1 rounded-xl hover:bg-chrome-soft transition-colors"
        >
          <span className="material-symbols-outlined text-chrome mb-1">route</span>
          <span className="text-[10px] font-bold" style={{ color: "var(--color-ink)" }}>Directions</span>
        </button>
        <button type="button"
          onClick={onDrawRoute}
          className={`flex flex-col items-center justify-center p-3 shadow-sm rounded-xl transition-colors ${
            drawMode ? "bg-chrome-soft ring-1 ring-chrome-mid" : "bg-raised hover:bg-chrome-soft"
          }`}
        >
          <span className="material-symbols-outlined text-chrome mb-1">draw</span>
          <span className="text-[10px] font-bold" style={{ color: "var(--color-ink)" }}>Draw Route</span>
        </button>
      </div>
    </div>
  );
}
