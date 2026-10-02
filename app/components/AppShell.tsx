import { useRef, useEffect, useCallback, type ReactNode } from "react";
import type maplibregl from "maplibre-gl";

interface AppShellProps {
  /** Content for the desktop sidebar (SideNav wrapping phase content) */
  sidebar: ReactNode;
  /** The MapView element */
  map: ReactNode;
  /** Overlays rendered on top of the map (search, timeline, controls, route cards) */
  mapOverlays?: ReactNode;
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  /** Whether the desktop sidebar is open */
  sidebarOpen: boolean;
  /** Called to toggle the sidebar open/closed */
  onSidebarToggle: () => void;
}

/**
 * Responsive layout shell.
 *
 * Desktop (>=768px): collapsible solid sidebar (slides in/out) | map (flex-1)
 * Mobile (<768px):   full-screen map with overlays + BottomSheet (rendered by caller)
 */
export default function AppShell({
  sidebar,
  map,
  mapRef,
  mapOverlays,
  sidebarOpen,
  onSidebarToggle,
}: AppShellProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);

  const resizeMap = useCallback(() => {
    mapRef.current?.resize();
  }, [mapRef]);

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(resizeMap);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resizeMap]);

  return (
    /* h-dvh (with an h-screen fallback) tracks the *visible* viewport, so
       mobile Chrome's bottom toolbar / new-tab bar no longer sits on top of
       the timeline and bottom sheet pinned to the container's bottom edge. */
    <div className="relative flex h-screen supports-[height:100dvh]:h-dvh w-screen overflow-hidden" style={{ background: "var(--color-ground)" }}>
      {/* Collapsible sidebar — desktop only */}
      <aside
        className="hidden md:flex flex-col fixed left-0 top-0 h-full z-40 w-sidebar"
        style={{
          background: "var(--color-panel)",
          borderRight: "1px solid var(--color-rule)",
          boxShadow: "var(--shadow-hard-2)",
          transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 300ms ease-in-out",
        }}
      >
        {/* Inner wrapper clips sidebar content without clipping the pull-tab */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {sidebar}
        </div>

        {/* Pull-tab — outside overflow-hidden wrapper so it isn't clipped */}
        <button type="button"
          onClick={onSidebarToggle}
          className="absolute top-1/2 right-0 -translate-y-1/2 translate-x-full w-8 h-16 flex items-center justify-center hover:brightness-95 transition-[filter]"
          style={{
            background: "var(--color-panel)",
            boxShadow: "var(--shadow-hard-1)",
          }}
          aria-label={sidebarOpen ? "Close panel" : "Open panel"}
        >
          <span
            className="material-symbols-outlined text-base"
            style={{ color: "var(--color-ink-muted)" }}
          >
            {sidebarOpen ? "chevron_left" : "chevron_right"}
          </span>
        </button>
      </aside>

      {/* Map area — padding shifts content right when sidebar opens. Desktop
          only: the sidebar is hidden on phones, where 408px of padding widened
          the map area past a narrow screen and pushed its right edge off (#162). */}
      <div
        className={`relative flex-1 min-h-0 overflow-hidden ${sidebarOpen ? "md:pl-sidebar" : ""}`}
        style={{ transition: "padding-left 300ms ease-in-out" }}
      >
        <div ref={mapContainerRef} className="absolute inset-0 overflow-hidden" style={{ zIndex: 0 }}>
          {map}
          {mapOverlays}
        </div>
      </div>
    </div>
  );
}
