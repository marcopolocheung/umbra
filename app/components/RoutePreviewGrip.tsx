import type { PointerEvent } from "react";

interface RoutePreviewGripProps {
  docked: boolean;
  dragging?: boolean;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onToggle: () => void;
}

/** One full-width grab area; a short click or Enter/Space is the non-drag alternative. */
export default function RoutePreviewGrip({
  docked,
  dragging = false,
  onPointerDown,
  onToggle,
}: RoutePreviewGripProps) {
  const destination = docked ? "map" : "trip panel";

  return (
    <button
      type="button"
      className="umbra-route-preview-grip"
      data-testid={docked ? "route-preview-dock-grip" : "route-preview-float-grip"}
      data-dragging={dragging || undefined}
      aria-label={`Drag route options to the ${destination}; click or press Enter to move them`}
      onPointerDown={onPointerDown}
      onClick={onToggle}
    >
      <span>ROUTE OPTIONS</span>
      <span className="material-symbols-outlined text-xl" aria-hidden="true">
        drag_indicator
      </span>
    </button>
  );
}
