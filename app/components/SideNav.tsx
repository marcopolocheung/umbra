import type { ReactNode } from "react";

export type SideNavTab = "map" | "directions" | "history" | "saved" | "settings";

interface SideNavProps {
  activeTab: SideNavTab;
  onTabChange: (tab: SideNavTab) => void;
  children: ReactNode;
}

const tabs: { id: SideNavTab; icon: string; label: string }[] = [
  { id: "map", icon: "map", label: "Map" },
  { id: "directions", icon: "directions", label: "Directions" },
  { id: "history", icon: "history", label: "Shadow History" },
  { id: "saved", icon: "bookmark", label: "Saved Routes" },
  { id: "settings", icon: "settings", label: "Settings" },
];

export default function SideNav({ activeTab, onTabChange, children }: SideNavProps) {
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
              className={`flex flex-col items-center gap-0.5 px-2 py-2 rounded-xl text-[11px] tracking-tight flex-1 transition-all duration-150 active:scale-95 ${
                active
                  ? "text-chrome font-bold bg-chrome-soft"
                  : "text-ink-muted font-medium hover:bg-chrome-soft hover:text-chrome"
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
      <div className="mt-6 flex-1 overflow-y-auto overflow-x-hidden strata-scrollbar min-h-0">
        {children}
      </div>
    </div>
  );
}
