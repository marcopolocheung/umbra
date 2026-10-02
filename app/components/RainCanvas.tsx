import { useEffect, useRef, useState, type RefObject } from "react";

interface RainCanvasProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  rainMode: boolean;
  /** Meteorological wind-from bearing: the forecast's, or the manual wind. */
  windFromDeg: number | null;
  windSpeedMs: number | null;
}

/** Velocities are px/ms; a drop's `vx` leans toward `vy * slope`. */
export interface Drop { x: number; y: number; vx: number; vy: number }
/** Splash droplets and drips: short-lived, gravity-bound. */
export interface Particle { x: number; y: number; vx: number; vy: number; life: number }
/** A drop resting on a control's top edge, sliding along it until it drips off the end. */
export interface Bead { x: number; y: number; left: number; right: number; v: number; life: number }
/** The top edge of a control, in canvas pixels. */
export interface Surface { left: number; right: number; top: number }

export interface RainState { drops: Drop[]; particles: Particle[]; beads: Bead[] }

export interface RainStepOptions {
  width: number;
  height: number;
  capacity: number;
  slope: number;
  random?: () => number;
}

const GRAVITY = 0.0011;
const BEAD_CHANCE = 0.18;
const BEAD_LIFE_MS = 900;
const POUR_MS = 2500;
/** On Sun, falling rain gets this long to clear before the canvas goes. */
const DRAIN_LIMIT_MS = 1600;

export function rainCapacity(lowEnd: boolean, pouring: boolean): number {
  return lowEnd ? (pouring ? 75 : 24) : (pouring ? 150 : 48);
}

/** Meteorological bearings point to the source; screen x follows the destination. */
export function downwindDrift(windFromDeg: number | null, windSpeedMs: number | null): number {
  if (windFromDeg == null || !Number.isFinite(windFromDeg)) return 0;
  const downwind = (windFromDeg + 180) * Math.PI / 180;
  return Math.sin(downwind) * Math.min(5, Math.max(0, windSpeedMs ?? 3)) * .55;
}

/** Drift as a lean: horizontal px per vertical px (at most about 20°). */
export function rainSlope(windFromDeg: number | null, windSpeedMs: number | null): number {
  return downwindDrift(windFromDeg, windSpeedMs) / 7.5;
}

function spawnDrop(drop: Drop, opts: RainStepOptions, fresh: boolean, random: () => number): Drop {
  const span = opts.height * Math.abs(opts.slope);
  drop.vy = 0.55 + random() * 0.3;
  drop.vx = drop.vy * opts.slope;
  drop.x = random() * (opts.width + span) - (opts.slope > 0 ? span : 0);
  drop.y = fresh ? -random() * opts.height : -10 - random() * 60;
  return drop;
}

/**
 * One frame of rain. Pure apart from `random`: a drop that crosses a surface's
 * top edge splashes into droplets and sometimes leaves a bead, which slides
 * along that edge and drips off its end, so nothing passes through a control.
 */
export function stepRain(state: RainState, dt: number, surfaces: Surface[], opts: RainStepOptions): void {
  const random = opts.random ?? Math.random;
  const { drops, particles, beads } = state;
  let fresh = drops.length === 0;
  while (drops.length < opts.capacity) drops.push(spawnDrop({ x: 0, y: 0, vx: 0, vy: 0 }, opts, fresh || drops.length < opts.capacity / 2, random));
  fresh = false;
  const ease = Math.min(1, dt / 300);
  for (let i = drops.length - 1; i >= 0; i--) {
    const drop = drops[i];
    drop.vx += (drop.vy * opts.slope - drop.vx) * ease;
    const nx = drop.x + drop.vx * dt;
    const ny = drop.y + drop.vy * dt;
    let hit = false;
    for (const surface of surfaces) {
      if (drop.y < surface.top && ny >= surface.top) {
        const ix = drop.x + (surface.top - drop.y) / drop.vy * drop.vx;
        if (ix >= surface.left && ix <= surface.right) {
          const count = 3 + Math.floor(random() * 3);
          for (let k = 0; k < count; k++) {
            particles.push({ x: ix, y: surface.top - 1, vx: (random() - .5) * .22 + drop.vx * .25, vy: -(.1 + random() * .16), life: 260 + random() * 200 });
          }
          if (random() < BEAD_CHANCE) {
            beads.push({ x: ix, y: surface.top, left: surface.left, right: surface.right, v: drop.vx * .12 + (random() - .5) * .02, life: BEAD_LIFE_MS });
          }
          hit = true;
          break;
        }
      }
    }
    if (hit || ny > opts.height + 20) {
      if (drops.length > opts.capacity) drops.splice(i, 1);
      else spawnDrop(drop, opts, false, random);
    } else {
      drop.x = nx;
      drop.y = ny;
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0 || p.y > opts.height) particles.splice(i, 1);
  }
  for (let i = beads.length - 1; i >= 0; i--) {
    const b = beads[i];
    b.x += b.v * dt;
    b.life -= dt;
    if (b.x < b.left || b.x > b.right) {
      // Off the end of the edge: it drips down beside the control, never into it.
      particles.push({ x: b.x, y: b.y + 1, vx: b.v, vy: .02, life: 500 });
      beads.splice(i, 1);
    } else if (b.life <= 0) {
      beads.splice(i, 1);
    }
  }
}

function isLowEnd(): boolean {
  const device = navigator as Navigator & { deviceMemory?: number };
  return (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4)
    || (device.deviceMemory != null && device.deviceMemory <= 4);
}

const SURFACES = "button,.directions-waypoint,.directions-conditions,.directions-kicker,.directions-preference-value";

export default function RainCanvas({ scrollRef, rainMode, windFromDeg, windSpeedMs }: RainCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slopeRef = useRef(rainSlope(windFromDeg, windSpeedMs));
  const rainingRef = useRef(rainMode);
  const [active, setActive] = useState(rainMode);
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));

  // Wind changes retarget the drops in flight; they never restart the shower.
  slopeRef.current = rainSlope(windFromDeg, windSpeedMs);
  rainingRef.current = rainMode;
  if (rainMode && !active) setActive(true);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) return;
    const scroll = scrollRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!scroll || !canvas || !context) return;
    const activeScroll = scroll;
    const activeCanvas = canvas;
    const ctx = context;

    const lowEnd = isLowEnd();
    const state: RainState = { drops: [], particles: [], beads: [] };
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastFrame = 0;
    let started = 0;
    let stoppedAt = 0;
    let surfaces: Surface[] = [];
    let surfacesDirty = true;
    let dropColor = "";
    let splashColor = "";

    function resize() {
      width = activeScroll.clientWidth;
      height = activeScroll.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      activeCanvas.width = Math.max(1, Math.round(width * ratio));
      activeCanvas.height = Math.max(1, Math.round(height * ratio));
      activeCanvas.style.width = `${width}px`;
      activeCanvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      surfacesDirty = true;
    }

    function refreshSurfaces() {
      surfacesDirty = false;
      const origin = activeCanvas.getBoundingClientRect();
      const out: Surface[] = [];
      for (const element of activeScroll.querySelectorAll<HTMLElement>(SURFACES)) {
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const top = rect.top - origin.top;
        if (top < 0 || top > height) continue;
        out.push({ left: rect.left - origin.left, right: rect.right - origin.left, top });
      }
      surfaces = out;
      const styles = getComputedStyle(activeCanvas);
      dropColor = styles.getPropertyValue("--color-directions-rain-drop").trim();
      splashColor = styles.getPropertyValue("--color-directions-rain-splash").trim();
    }

    function draw(now: number) {
      frame = requestAnimationFrame(draw);
      const box = activeCanvas.getBoundingClientRect();
      if (document.hidden || box.bottom < 0 || box.top > window.innerHeight) { lastFrame = 0; return; }
      if (lowEnd && lastFrame && now - lastFrame < 1000 / 30) return;
      const dt = Math.min(40, now - (lastFrame || now - 16.67));
      lastFrame = now;
      if (!started) started = now;
      const raining = rainingRef.current;
      if (!raining && !stoppedAt) stoppedAt = now;
      if (raining) stoppedAt = 0;
      if (surfacesDirty) refreshSurfaces();
      const capacity = raining ? rainCapacity(lowEnd, now - started < POUR_MS) : 0;
      stepRain(state, dt, surfaces, { width, height, capacity, slope: slopeRef.current });

      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = dropColor;
      ctx.lineWidth = 1.3;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const drop of state.drops) {
        const speed = Math.hypot(drop.vx, drop.vy);
        ctx.moveTo(drop.x - drop.vx / speed * 13, drop.y - drop.vy / speed * 13);
        ctx.lineTo(drop.x, drop.y);
      }
      ctx.stroke();
      ctx.fillStyle = splashColor;
      for (const p of state.particles) ctx.fillRect(p.x - .9, p.y - .9, 1.8, 1.8);
      for (const b of state.beads) { ctx.beginPath(); ctx.arc(b.x, b.y - 1.5, 2, 0, Math.PI * 2); ctx.fill(); }

      const drained = !state.drops.length && !state.particles.length && !state.beads.length;
      if (!raining && (drained || now - stoppedAt > DRAIN_LIMIT_MS)) {
        cancelAnimationFrame(frame);
        frame = 0;
        setActive(false);
      }
    }

    function resume() { if (!frame) frame = requestAnimationFrame(draw); }
    function pause() { if (frame) cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
    function onVisibilityChange() { if (document.hidden) pause(); else resume(); }
    function markDirty() { surfacesDirty = true; }

    const sizer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    sizer?.observe(activeScroll);
    const mutations = new MutationObserver(markDirty);
    mutations.observe(activeScroll, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-objective", "data-ready", "data-filled", "class"] });
    activeScroll.addEventListener("scroll", markDirty, { passive: true });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    resize();
    resume();
    return () => {
      pause();
      sizer?.disconnect();
      mutations.disconnect();
      activeScroll.removeEventListener("scroll", markDirty);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      ctx.clearRect(0, 0, width, height);
    };
  }, [scrollRef, active, reducedMotion]);

  if (!active || reducedMotion) return null;
  return <div className="directions-rain-layer" aria-hidden="true"><canvas ref={canvasRef} className="directions-rain-canvas" data-testid="directions-rain-canvas" /></div>;
}
