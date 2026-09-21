import { useRef, useCallback, useEffect, useState, type ReactNode } from "react";

export type SnapPoint = "hidden" | "collapsed" | "mid" | "full";

interface BottomSheetProps {
  snap: SnapPoint;
  onSnapChange: (snap: SnapPoint) => void;
  children: ReactNode;
  /** Height in px for collapsed state */
  collapsedHeight?: number;
}

const SNAP_HEIGHTS: Record<SnapPoint, number> = {
  hidden: 0, // fully off-screen; the caller renders a reopen affordance
  collapsed: 80,
  mid: 50,   // percentage of vh
  full: 90,  // percentage of vh
};

function snapToPixels(snap: SnapPoint, viewportHeight: number, collapsedHeight: number): number {
  switch (snap) {
    case "hidden": return 0;
    case "collapsed": return collapsedHeight;
    case "mid": return viewportHeight * (SNAP_HEIGHTS.mid / 100);
    case "full": return viewportHeight * (SNAP_HEIGHTS.full / 100);
  }
}

function nearestSnap(heightPx: number, viewportHeight: number, collapsedHeight: number): SnapPoint {
  const snaps: SnapPoint[] = ["hidden", "collapsed", "mid", "full"];
  let best: SnapPoint = "collapsed";
  let bestDist = Infinity;
  for (const s of snaps) {
    const d = Math.abs(heightPx - snapToPixels(s, viewportHeight, collapsedHeight));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

export default function BottomSheet({ snap, onSnapChange, children, collapsedHeight = 80 }: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const velocityRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const animRef = useRef<number | null>(null);

  // Drive height from snap prop when not dragging
  useEffect(() => {
    if (draggingRef.current) return;
    const vh = window.innerHeight;
    setHeight(snapToPixels(snap, vh, collapsedHeight));
    // Collapsing with a stale scroll position would leave the collapsed
    // band showing mid-content (the browser preserves scrollTop); the band
    // is exactly one trip bar tall, so it always starts at the top (U4).
    if (snap === "collapsed" && sheetRef.current) {
      const content = sheetRef.current.querySelector<HTMLDivElement>("div.flex-1");
      if (content) content.scrollTop = 0;
    }
  }, [snap, collapsedHeight]);

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
    // Only respond to drag handle area — the handle's own band, so a tap on
    // the content below it (the trip bar, prime thumb zone) never starts a
    // drag. At the collapsed snap that band is 36px; the sheet's top 44px
    // otherwise. The 36px band is still the drag affordance; the content's
    // own 44px targets sit below it untouched (U4).
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gate = snap === "collapsed" ? 36 : 44;
    if (e.clientY < rect.top || e.clientY > rect.top + gate) return;

    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height ?? snapToPixels(snap, window.innerHeight, collapsedHeight);
    velocityRef.current = 0;
    lastYRef.current = e.clientY;
    lastTRef.current = performance.now();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [height, snap, collapsedHeight]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dy = startYRef.current - e.clientY; // positive = dragging up = taller
    const vh = window.innerHeight;
    const maxH = vh * (SNAP_HEIGHTS.full / 100);
    // The floor is 0, not the collapsed band: dragging (or flinging) past
    // collapsed must be able to carry the sheet to the hidden snap (U4).
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
    const currentH = height ?? collapsedHeight;

    // Use velocity to bias snap direction
    const velocityBias = velocityRef.current * 150; // project 150ms ahead
    const projected = currentH + velocityBias;
    const targetSnap = nearestSnap(projected, vh, collapsedHeight);
    const targetH = snapToPixels(targetSnap, vh, collapsedHeight);
    animateTo(targetH, targetSnap);
  }, [height, collapsedHeight, animateTo]);

  // Clean up animation on unmount
  useEffect(() => {
    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  const displayHeight = height ?? snapToPixels(snap, typeof window !== "undefined" ? window.innerHeight : 800, collapsedHeight);
  // The collapsed band is prime thumb-zone (Fitts) and carries the trip bar.
  // At 80px a 44px handle would leave the bar 36px — clipped — so the handle
  // yields to a 36px row when settled at collapsed, giving the bar its full
  // 44px target inside the band. Any taller snap keeps the 44px handle.
  const isCollapsed = snap === "collapsed" && !draggingRef.current;
  const handleBandPx = isCollapsed ? 36 : 44;
  // At the hidden snap the sheet is off-screen; a settled height of 0 must not
  // leave a 1px hairline riding the viewport's bottom edge.
  const isHidden = snap === "hidden" && !draggingRef.current;

  return (
    <div
      ref={sheetRef}
      className="fixed bottom-0 left-0 right-0 z-20 md:hidden flex flex-col"
      style={{
        height: displayHeight,
        touchAction: "none",
        willChange: "height",
        background: "var(--color-raised)",
        borderTop: isHidden ? "none" : "1px solid var(--color-hairline)",
        borderRadius: "20px 20px 0 0",
        pointerEvents: isHidden ? "none" : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Drag handle — the band height above; the pointer-drag gate in
          onPointerDown still accepts drags started anywhere in its top 44px */}
      <div
        className="flex items-center justify-center cursor-grab active:cursor-grabbing shrink-0 transition-[height]"
        style={{ height: handleBandPx }}
      >
        <div className="w-8 h-1 rounded-full" style={{ background: "var(--color-hairline)" }} />
      </div>

      {/* Content — the bottom padding yields to the collapsed band (U4): at
          80px the trip bar needs the full 36+44, so pb-3 would clip it. */}
      <div
        className={`flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 umbra-scrollbar ${isCollapsed ? "" : "pb-3"}`}
      >
        {children}
      </div>
    </div>
  );
}
