import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import RainCanvas from "./RainCanvas";

interface DirectionsScrollDecorProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  rainMode: boolean;
  windFromDeg: number | null;
  windSpeedMs: number | null;
}

interface RailPosition {
  height: number;
  progress: number;
  section: string;
  hasFind: boolean;
}

const TAG_LINGER_MS = 600;

const initialPosition: RailPosition = { height: 0, progress: 0, section: "Start", hasFind: false };

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

export default function DirectionsScrollDecor({ scrollRef, rainMode, windFromDeg, windSpeedMs }: DirectionsScrollDecorProps) {
  const [position, setPosition] = useState(initialPosition);
  const [dragging, setDragging] = useState(false);
  // The station tag shows while you scroll and fades soon after the last scroll.
  const [live, setLive] = useState(false);
  const liveTimer = useRef<number | null>(null);
  const flashTag = useCallback(() => {
    setLive(true);
    if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => { setLive(false); liveTimer.current = null; }, TAG_LINGER_MS);
  }, []);
  const railRef = useRef<HTMLDivElement>(null);
  const previousUserSelect = useRef<string | null>(null);

  const update = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const progress = max > 0 ? clamp(scroll.scrollTop / max) : 0;
    const viewport = scroll.getBoundingClientRect();
    // The reading line travels down the viewport as the stop travels down the
    // rail. Names come from whichever form/results sections are mounted now.
    const readingLine = scroll.scrollTop + progress * scroll.clientHeight;
    let section = "Start";
    for (const element of scroll.querySelectorAll<HTMLElement>("[data-directions-section]")) {
      const top = element.getBoundingClientRect().top - viewport.top + scroll.scrollTop;
      if (top <= readingLine + 16) section = element.dataset.directionsSection ?? section;
    }
    setPosition({
      height: scroll.clientHeight,
      progress,
      section,
      hasFind: Boolean(scroll.querySelector('.directions-planning[data-ready="true"]')),
    });
  }, [scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    update();
    const onScroll = () => { update(); flashTag(); };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    resize?.observe(scroll);
    const mutations = new MutationObserver(update);
    mutations.observe(scroll, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "data-directions-section"] });
    window.addEventListener("resize", update);
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [scrollRef, update, flashTag]);

  useEffect(() => () => {
    if (previousUserSelect.current !== null) document.body.style.userSelect = previousUserSelect.current;
    if (liveTimer.current !== null) window.clearTimeout(liveTimer.current);
  }, []);

  function scrollToPointer(clientY: number) {
    const rail = railRef.current;
    const scroll = scrollRef.current;
    if (!rail || !scroll) return;
    const rect = rail.getBoundingClientRect();
    const fraction = clamp((clientY - rect.top - 9) / Math.max(1, rect.height - 18));
    scroll.scrollTop = fraction * Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    update();
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    previousUserSelect.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    scrollToPointer(event.clientY);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (previousUserSelect.current !== null) document.body.style.userSelect = previousUserSelect.current;
    previousUserSelect.current = null;
    setDragging(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const step = Math.max(44, scroll.clientHeight / 8);
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = scroll.scrollTop + step; break;
      case "ArrowUp": next = scroll.scrollTop - step; break;
      case "PageDown": next = scroll.scrollTop + scroll.clientHeight; break;
      case "PageUp": next = scroll.scrollTop - scroll.clientHeight; break;
      case "Home": next = 0; break;
      case "End": next = max; break;
      default: return;
    }
    event.preventDefault();
    scroll.scrollTop = Math.max(0, Math.min(max, next));
    update();
  }

  const railHeight = Math.max(44, position.height - (position.hasFind ? 138 : 34));
  return <>
    <div className="directions-rain-host" style={{ height: position.height, marginBottom: -position.height }}>
      <RainCanvas scrollRef={scrollRef} rainMode={rainMode} windFromDeg={windFromDeg} windSpeedMs={windSpeedMs} />
    </div>
    <div className="directions-rail-host" style={{ height: position.height, marginBottom: -position.height }}><div
      ref={railRef}
      className="directions-rail"
      data-testid="directions-rail"
      data-live={dragging || live}
      data-dragging={dragging}
      role="scrollbar"
      aria-label="Directions sections"
      aria-controls={scrollRef.current?.id}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position.progress * 100)}
      aria-valuetext={position.section}
      tabIndex={0}
      style={{ height: railHeight }}
      onPointerDown={beginDrag}
      onPointerMove={(event) => { if (dragging) { event.preventDefault(); scrollToPointer(event.clientY); } }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <span className="directions-rail-stop" style={{ top: `${position.progress * Math.max(0, railHeight - 18)}px` }}><span className="directions-rail-tag">{position.section}</span></span>
    </div></div>
  </>;
}
