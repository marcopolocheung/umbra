import { useRef, type ReactNode } from "react";
import DirectionsScrollDecor from "./DirectionsScrollDecor";

export type SideNavTab = "map" | "directions" | "history" | "saved" | "settings";

interface SideNavProps {
  activeTab: SideNavTab;
  onTabChange: (tab: SideNavTab) => void;
  children: ReactNode;
  rainMode?: boolean;
  windFromDeg?: number | null;
  windSpeedMs?: number | null;
}

const tabs: { id: SideNavTab; icon: string; label: string }[] = [
  { id: "map", icon: "map", label: "Map" },
  { id: "directions", icon: "directions", label: "Directions" },
  { id: "history", icon: "history", label: "Shadow History" },
  { id: "saved", icon: "bookmark", label: "Saved Routes" },
  { id: "settings", icon: "settings", label: "Settings" },
];

export default function SideNav({ activeTab, onTabChange, children, rainMode = false, windFromDeg = null, windSpeedMs = null }: SideNavProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col h-full pt-20 px-4 pb-4">
      {/* Navigation tabs — horizontal row */}
      <nav className="flex gap-1">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button type="button"
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-col items-center gap-0.5 px-2 py-2 text-[11px] tracking-tight flex-1 transition-colors duration-150 ${
                active
                  ? "text-on-ink font-bold bg-ink"
                  : "text-ink-muted font-medium hover:bg-ground hover:text-ink"
              }`}
            >
              <span
                className="material-symbols-outlined text-xl"
                style={active ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {tab.icon}
              </span>
              <span className="leading-tight">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Phase-dependent content */}
      <div ref={scrollRef} id="directions-desktop-scroll" className={`relative mt-6 flex-1 overflow-y-auto overflow-x-hidden min-h-0 ${activeTab === "directions" ? "-mx-4 directions-scroll" : "umbra-scrollbar"}`}>
        {activeTab === "directions" && <DirectionsScrollDecor scrollRef={scrollRef} rainMode={rainMode} windFromDeg={windFromDeg} windSpeedMs={windSpeedMs} />}
        {children}
      </div>
    </div>
  );
}
