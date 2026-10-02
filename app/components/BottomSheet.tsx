import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";
import DirectionsScrollDecor from "./DirectionsScrollDecor";

// No peek band: the trip sheet is either hidden or open (#162). Hidden leaves
// the map, the timeline and the Trip reopen button.
export type SnapPoint = "hidden" | "mid" | "full";

interface BottomSheetProps {
  snap: SnapPoint;
  onSnapChange: (snap: SnapPoint) => void;
  children: ReactNode;
  /** Reset content to its first instruction when the panel changes purpose. */
  contentKey?: string;
  rainMode?: boolean;
  windFromDeg?: number | null;
  windSpeedMs?: number | null;
}

const SNAP_HEIGHTS: Record<SnapPoint, number> = {
  hidden: 0, // fully off-screen; the caller renders a reopen affordance
  mid: 50,   // percentage of vh
  full: 90,  // percentage of vh
};

function snapToPixels(snap: SnapPoint, viewportHeight: number): number {
  switch (snap) {
    case "hidden": return 0;
    case "mid": return viewportHeight * (SNAP_HEIGHTS.mid / 100);
    case "full": return viewportHeight * (SNAP_HEIGHTS.full / 100);
  }
}

function nearestSnap(heightPx: number, viewportHeight: number): SnapPoint {
  const snaps: SnapPoint[] = ["hidden", "mid", "full"];
  let best: SnapPoint = "hidden";
  let bestDist = Infinity;
  for (const s of snaps) {
    const d = Math.abs(heightPx - snapToPixels(s, viewportHeight));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

export default function BottomSheet({ snap, onSnapChange, children, contentKey, rainMode = false, windFromDeg = null, windSpeedMs = null }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const velocityRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    const content = scrollRef.current;
    if (content && contentKey !== undefined) content.scrollTop = 0;
  }, [contentKey]);

  // Drive height from snap prop when not dragging
  useEffect(() => {
    if (draggingRef.current) return;
    setHeight(snapToPixels(snap, window.innerHeight));
  }, [snap]);

  // Animate to target height
  const animateTo = useCallback((targetH: number, targetSnap: SnapPoint) => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    const STIFFNESS = 0.15;
    const DAMPING = 0.75;
    let vel = velocityRef.current * 0.3; // seed with drag velocity

    const step = () => {
      setHeight((prev) => {
        const current = prev ?? targetH;
        const force = (targetH - current) * STIFFNESS;
        vel = (vel + force) * DAMPING;
        const next = current + vel;
        if (Math.abs(next - targetH) < 0.5 && Math.abs(vel) < 0.5) {
          animRef.current = null;
          return targetH;
        }
        animRef.current = requestAnimationFrame(step);
        return next;
      });
    };
    animRef.current = requestAnimationFrame(step);
    onSnapChange(targetSnap);
  }, [onSnapChange]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only respond to the handle's own 44px band, so a tap on the content
    // below it never starts a drag.
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (e.clientY < rect.top || e.clientY > rect.top + 44) return;

    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height ?? snapToPixels(snap, window.innerHeight);
    velocityRef.current = 0;
    lastYRef.current = e.clientY;
    lastTRef.current = performance.now();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height, snap]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dy = startYRef.current - e.clientY; // positive = dragging up = taller
    const vh = window.innerHeight;
    const maxH = vh * (SNAP_HEIGHTS.full / 100);
    const newH = Math.max(0, Math.min(maxH, startHeightRef.current + dy));
    setHeight(newH);

    // EMA velocity (px/ms, positive = dragging up)
    const now = performance.now();
    const dt = now - lastTRef.current;
    if (dt > 0) {
      const instantV = (lastYRef.current - e.clientY) / dt;
      velocityRef.current = velocityRef.current * 0.3 + instantV * 0.7;
    }
    lastYRef.current = e.clientY;
    lastTRef.current = now;
  }, []);

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;

    const vh = window.innerHeight;
    const currentH = height ?? 0;

    // Use velocity to bias snap direction
    const velocityBias = velocityRef.current * 150; // project 150ms ahead
    const projected = currentH + velocityBias;
    const targetSnap = nearestSnap(projected, vh);
    const targetH = snapToPixels(targetSnap, vh);
    animateTo(targetH, targetSnap);
  }, [height, animateTo]);

  // Clean up animation on unmount
  useEffect(() => {
    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  const displayHeight = height ?? snapToPixels(snap, typeof window !== "undefined" ? window.innerHeight : 800);
  // At the hidden snap the sheet is off-screen; a settled height of 0 must not
  // leave a 1px hairline riding the viewport's bottom edge.
  const isHidden = snap === "hidden" && !draggingRef.current;

  return (
    <div
      data-testid="bottom-sheet"
      ref={sheetRef}
      /* absolute (not fixed) inside the map overlay container, which is sized
         by h-dvh in AppShell — so the sheet clears mobile Chrome's bottom
         toolbar instead of anchoring to the layout viewport behind it. The
         safe-area bottom offset lifts it over the iOS home indicator. */
      className="absolute bottom-0 left-0 right-0 z-20 md:hidden flex flex-col"
      style={{
        height: displayHeight,
        bottom: "env(safe-area-inset-bottom)",
        touchAction: "none",
        willChange: "height",
        background: "var(--color-panel)",
        // Square, with the timeline card's 2px ink rule for an edge: the panel
        // fill alone barely parts from either basemap in glare.
        borderTop: isHidden ? "none" : "2px solid var(--color-ink)",
        pointerEvents: isHidden ? "none" : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Drag handle — the 44px band onPointerDown accepts drags in */}
      <div className="flex h-11 items-center justify-center cursor-grab active:cursor-grabbing shrink-0">
        <div className="w-8 h-1" style={{ background: "var(--color-ink)" }} />
      </div>

      <div ref={scrollRef} id="directions-phone-scroll" className={`relative flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-3 ${contentKey === "DIRECTIONS" ? "directions-scroll" : "px-3 umbra-scrollbar"}`}>
        {contentKey === "DIRECTIONS" && <DirectionsScrollDecor scrollRef={scrollRef} rainMode={rainMode} windFromDeg={windFromDeg} windSpeedMs={windSpeedMs} />}
        {children}
      </div>
    </div>
  );
}
