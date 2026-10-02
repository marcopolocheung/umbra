import { useEffect, useRef, useState, type RefObject } from "react";

interface RainCanvasProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  rainMode: boolean;
  windFromDeg: number | null;
  windSpeedMs: number | null;
  height: number;
}

interface Drop { x: number; y: number; vx: number; vy: number; length: number; bead: number }

export function rainCapacity(lowEnd: boolean, pouring: boolean): number {
  return lowEnd ? (pouring ? 75 : 24) : (pouring ? 150 : 48);
}

/** Meteorological bearings point to the source; screen x follows the destination. */
export function downwindDrift(windFromDeg: number | null, windSpeedMs: number | null): number {
  if (windFromDeg == null || !Number.isFinite(windFromDeg)) return 0;
  const downwind = (windFromDeg + 180) * Math.PI / 180;
  return Math.sin(downwind) * Math.min(5, Math.max(0, windSpeedMs ?? 3)) * .55;
}

function isLowEnd(): boolean {
  const device = navigator as Navigator & { deviceMemory?: number };
  return (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4)
    || (device.deviceMemory != null && device.deviceMemory <= 4);
}

export default function RainCanvas({ scrollRef, rainMode, windFromDeg, windSpeedMs, height }: RainCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!rainMode || reducedMotion || height <= 0) return;
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!scroll || !canvas || !context) return;
    const activeScroll = scroll;
    const activeCanvas = canvas;
    const activeContext = context;

    const lowEnd = isLowEnd();
    const drift = downwindDrift(windFromDeg, windSpeedMs);
    const drops: Drop[] = [];
    let elapsed = 0;
    let width = 0;
    let viewportHeight = 0;
    let frame = 0;
    let lastFrame = 0;
    let inView = typeof IntersectionObserver === "undefined";

    function reset(drop: Drop, above = true) {
      drop.x = Math.random() * width;
      drop.y = above ? -Math.random() * viewportHeight : Math.random() * viewportHeight;
      drop.vx = drift + (Math.random() - .5) * .6;
      drop.vy = 5 + Math.random() * 5;
      drop.length = 6 + Math.random() * 9;
      drop.bead = 0;
    }

    function resize() {
      width = activeScroll.clientWidth;
      viewportHeight = activeScroll.clientHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      activeCanvas.width = Math.max(1, Math.round(width * pixelRatio));
      activeCanvas.height = Math.max(1, Math.round(viewportHeight * pixelRatio));
      activeCanvas.style.width = `${width}px`;
      activeCanvas.style.height = `${viewportHeight}px`;
      activeContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      for (const drop of drops) reset(drop, false);
    }

    function draw(now: number) {
      frame = 0;
      if (!inView || document.hidden) return;
      if (lowEnd && now - lastFrame < 1000 / 30) { frame = requestAnimationFrame(draw); return; }
      const frameDuration = now - (lastFrame || now - 16.67);
      const step = Math.min(2, Math.max(.5, frameDuration / 16.67));
      elapsed += Math.min(100, frameDuration);
      lastFrame = now;
      const pouring = elapsed < 2500;
      const capacity = rainCapacity(lowEnd, pouring);
      while (drops.length < capacity) { const drop: Drop = { x: 0, y: 0, vx: 0, vy: 0, length: 0, bead: 0 }; reset(drop, false); drops.push(drop); }
      drops.length = capacity;
      activeContext.clearRect(0, 0, width, viewportHeight);
      const canvasRect = activeCanvas.getBoundingClientRect();
      const surfaces = [...activeScroll.querySelectorAll<HTMLElement>("button,.directions-waypoint,.directions-conditions")]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.bottom > canvasRect.top && rect.top < canvasRect.bottom)
        .map((rect) => ({ left: rect.left - canvasRect.left, right: rect.right - canvasRect.left, top: rect.top - canvasRect.top }));
      const styles = getComputedStyle(activeCanvas);
      activeContext.strokeStyle = styles.getPropertyValue("--color-directions-rain-drop").trim();
      activeContext.fillStyle = styles.getPropertyValue("--color-directions-rain-splash").trim();
      activeContext.lineWidth = 1;
      activeContext.beginPath();
      for (const drop of drops) {
        const previousY = drop.y;
        if (drop.bead > 0) { drop.bead -= step; drop.x += drift * .2 * step; drop.y += .6 * step; }
        else { drop.x += drop.vx * step; drop.y += drop.vy * step; }
        if (drop.y > viewportHeight || drop.x < -20 || drop.x > width + 20) { reset(drop); continue; }
        if (!drop.bead) {
          for (const surface of surfaces) {
            if (previousY < surface.top && drop.y >= surface.top && drop.x >= surface.left && drop.x <= surface.right) {
              activeContext.moveTo(drop.x - 3, surface.top); activeContext.lineTo(drop.x + 3, surface.top);
              if (Math.random() < .25) { drop.y = surface.top; drop.bead = 8; }
              else reset(drop);
              break;
            }
          }
        }
        activeContext.moveTo(drop.x, drop.y); activeContext.lineTo(drop.x - drop.vx * 2, drop.y - drop.length);
      }
      activeContext.stroke();
      frame = requestAnimationFrame(draw);
    }

    function resume() { if (!frame && inView && !document.hidden) frame = requestAnimationFrame(draw); }
    function pause() { if (frame) cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
    function onVisibilityChange() { if (document.hidden) pause(); else resume(); }
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting && activeScroll.clientHeight > 0;
      if (inView) resume(); else pause();
    }) : null;
    resize();
    observer?.observe(activeScroll);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    resume();
    return () => {
      pause();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      activeContext.clearRect(0, 0, width, viewportHeight);
    };
  }, [scrollRef, rainMode, reducedMotion, windFromDeg, windSpeedMs, height]);

  if (!rainMode || reducedMotion || height <= 0) return null;
  return <div className="directions-rain-layer" aria-hidden="true"><canvas ref={canvasRef} className="directions-rain-canvas" data-testid="directions-rain-canvas" /></div>;
}
