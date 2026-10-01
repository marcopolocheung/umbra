import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";

type Point = { x: number; y: number };
type Surface = "dock" | "float";
type DragPreview = { overDock: boolean; position: Point };

const SIDEBAR_WIDTH = 408;
const CLOSED_SIDEBAR_TARGET = 40;
const FLOAT_WIDTH = 320;
const FLOAT_MARGIN = 24;
const FLOAT_BOTTOM = 96;
const FLOAT_MIN_HEIGHT = 240;
const DRAG_THRESHOLD = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function clampPosition(position: Point, viewport: Point): Point {
  return {
    x: clamp(
      position.x,
      FLOAT_MARGIN,
      Math.max(FLOAT_MARGIN, viewport.x - FLOAT_WIDTH - FLOAT_MARGIN),
    ),
    y: clamp(
      position.y,
      FLOAT_MARGIN,
      Math.max(FLOAT_MARGIN, viewport.y - FLOAT_BOTTOM - FLOAT_MIN_HEIGHT),
    ),
  };
}

/** The sidebar's full face accepts a drop; its exposed pull tab accepts one while closed. */
function overSidebar(x: number, y: number, sidebarOpen: boolean, height: number): boolean {
  return (
    x >= 0 && x <= (sidebarOpen ? SIDEBAR_WIDTH : CLOSED_SIDEBAR_TARGET) && y >= 0 && y <= height
  );
}

interface Args {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  viewport: Point;
}

export function useRoutePreviewDrag({ sidebarOpen, setSidebarOpen, viewport }: Args) {
  const [preferDockedOnWideDesktop, setPreferDockedOnWideDesktop] = useState(false);
  const [savedFloatPosition, setSavedFloatPosition] = useState<Point | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const sidebarOpenRef = useRef(sidebarOpen);
  const viewportRef = useRef(viewport);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  sidebarOpenRef.current = sidebarOpen;
  viewportRef.current = viewport;

  const wideDesktop = viewport.x >= 1200;
  const committedDocked = sidebarOpen && (!wideDesktop || preferDockedOnWideDesktop);
  const docked = dragPreview?.overDock ?? committedDocked;
  const floatingPosition =
    dragPreview && !dragPreview.overDock
      ? dragPreview.position
      : savedFloatPosition && clampPosition(savedFloatPosition, viewport);

  const dock = useCallback(() => {
    setPreferDockedOnWideDesktop(true);
    sidebarOpenRef.current = true;
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const float = useCallback(
    (origin: Surface, position?: Point, autoOpened = false) => {
      setPreferDockedOnWideDesktop(false);
      if (position) setSavedFloatPosition(clampPosition(position, viewportRef.current));
      if (origin === "dock" || viewportRef.current.x < 1200 || autoOpened) {
        sidebarOpenRef.current = false;
        setSidebarOpen(false);
      }
    },
    [setSidebarOpen],
  );

  const activateGrip = useCallback(
    (surface: Surface) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (surface === "dock") float("dock");
      else dock();
    },
    [dock, float],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, origin: Surface) => {
      if (!event.isPrimary || event.button !== 0 || viewportRef.current.x < 768) return;
      event.stopPropagation();
      cleanupRef.current?.();
      suppressClickRef.current = false;

      const handleRect = event.currentTarget.getBoundingClientRect();
      const floatRect = event.currentTarget
        .closest("[data-route-preview-surface='float']")
        ?.getBoundingClientRect();
      const offsetX = floatRect
        ? event.clientX - floatRect.left
        : clamp(event.clientX - handleRect.left + 12, 0, FLOAT_WIDTH);
      const offsetY = floatRect
        ? event.clientY - floatRect.top
        : event.clientY - handleRect.top + 12;
      const pointerId = event.pointerId;
      const start = { x: event.clientX, y: event.clientY };
      const sidebarWasOpen = sidebarOpenRef.current;
      let autoOpened = false;
      let moved = false;
      let overDock = origin === "dock";
      let position = clampPosition(
        { x: start.x - offsetX, y: start.y - offsetY },
        viewportRef.current,
      );

      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("blur", cancel);
        document.body.style.userSelect = previousUserSelect;
        cleanupRef.current = null;
      };
      const move = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        if (
          !moved &&
          Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < DRAG_THRESHOLD
        )
          return;
        moved = true;
        suppressClickRef.current = true;
        overDock = overSidebar(
          pointer.clientX,
          pointer.clientY,
          sidebarOpenRef.current,
          viewportRef.current.y,
        );
        if (overDock && !sidebarOpenRef.current) {
          autoOpened = true;
          sidebarOpenRef.current = true;
          setSidebarOpen(true);
        }
        position = clampPosition(
          { x: pointer.clientX - offsetX, y: pointer.clientY - offsetY },
          viewportRef.current,
        );
        setDragPreview({ overDock, position });
      };
      const finish = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        cleanup();
        setDragPreview(null);
        if (!moved) return;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (overDock) {
          dock();
        } else {
          float(origin, position, autoOpened);
        }
      };
      const cancel = () => {
        cleanup();
        setDragPreview(null);
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (autoOpened) {
          sidebarOpenRef.current = sidebarWasOpen;
          setSidebarOpen(sidebarWasOpen);
        }
      };
      const onKeyDown = (key: KeyboardEvent) => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        cancel();
      };
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("blur", cancel);
    },
    [dock, float, setSidebarOpen],
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  return {
    docked,
    floatingPosition,
    dragging: dragPreview !== null,
    beginDrag,
    activateGrip,
  };
}
