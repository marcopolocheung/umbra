/**
 * H3b — Sun Budget: pick a start, then see every street reachable on at most
 * `sunMin` minutes of direct sun and `walkMin` minutes of walking, one way.
 *
 * One graph per (start, departure, mode); budget changes only re-search it.
 * Every result for that graph is cached, and the map paints `mergeRegion`
 * over them, so widening a budget never removes a proven street.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildReachGraph, type ReachGraph } from "../lib/navigationData/reachGraph";
import { type CachedReach, mergeRegion, type ReachRegion } from "../lib/reach/mergeRegion";
import { searchSunReach } from "../lib/routingWorkerClient";
import type { SunReachOutcome } from "../lib/sunReach";
import type { TravelModeId } from "../lib/travelMode";

export type SunBudgetStatus = "off" | "picking" | "loading" | "uncovered" | "ready" | "error";

/** The graph is built for the longest walk the panel offers, so changing walk time never refetches. */
export const SUN_BUDGET_WALK_MINUTES = [10, 20, 30] as const;
const GRAPH_WALK_SEC = Math.max(...SUN_BUDGET_WALK_MINUTES) * 60;
const SLIDER_DEBOUNCE_MS = 150;

export interface SunBudgetState {
  status: SunBudgetStatus;
  start: [number, number] | null;
  sunMin: number;
  walkMin: number;
  region: ReachRegion | null;
  outcome: SunReachOutcome | null;
  /** Graph nodes, for drawing edges; null until a graph is built. */
  nodes: Map<number, { lat: number; lon: number }> | null;
  enter: () => void;
  exit: () => void;
  setStart: (coord: [number, number]) => void;
  setSunMin: (minutes: number) => void;
  setWalkMin: (minutes: number) => void;
}

export function useSunBudget(
  departure: Date,
  travelMode: TravelModeId,
  // Injected so tests need no network or worker; module functions, so stable.
  build: typeof buildReachGraph = buildReachGraph,
  search: typeof searchSunReach = searchSunReach,
): SunBudgetState {
  const [active, setActive] = useState(false);
  const [start, setStartState] = useState<[number, number] | null>(null);
  const [sunMin, setSunMin] = useState(8);
  const [walkMin, setWalkMin] = useState(20);
  const [graph, setGraph] = useState<ReachGraph | "loading" | "error" | null>(null);
  const [current, setCurrent] = useState<CachedReach | null>(null);
  const cacheRef = useRef<CachedReach[]>([]);
  // The shade table is clock-slotted at 15 minutes; a departure inside the
  // same slot asks the same question.
  const departureSlot = Math.floor(departure.getTime() / (15 * 60_000));

  const enter = useCallback(() => setActive(true), []);
  const exit = useCallback(() => {
    setActive(false);
    setStartState(null);
  }, []);

  // A new start, departure slot or mode is a new graph: drop every cached result.
  useEffect(() => {
    cacheRef.current = [];
    setCurrent(null);
    if (!active || !start) {
      setGraph(null);
      return;
    }
    const controller = new AbortController();
    setGraph("loading");
    build({
      center: start,
      timeBudgetSec: GRAPH_WALK_SEC,
      departure: new Date(departureSlot * 15 * 60_000),
      travelMode,
      signal: controller.signal,
    }).then(
      (built) => setGraph(built),
      (error) => {
        if (!controller.signal.aborted) {
          console.warn("[sun budget] graph failed", error);
          setGraph("error");
        }
      },
    );
    return () => controller.abort();
  }, [active, start, departureSlot, travelMode, build]);

  // Re-search on a budget change, debounced; a newer change aborts the older search.
  useEffect(() => {
    if (!graph || typeof graph === "string" || graph.status !== "ok") return;
    const sunSec = sunMin * 60;
    const timeSec = walkMin * 60;
    const hit = cacheRef.current.find((c) => c.sunSec === sunSec && c.timeSec === timeSec);
    if (hit) {
      setCurrent(hit);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(
        graph.graph,
        graph.startId,
        { sunBudgetSec: sunSec, timeBudgetSec: timeSec, travelMode, timeAware: graph.timeAware },
        { signal: controller.signal },
      ).then(
        (result) => {
          const entry = { sunSec, timeSec, result };
          cacheRef.current.push(entry);
          setCurrent(entry);
        },
        (error) => {
          if (!controller.signal.aborted) console.warn("[sun budget] search failed", error);
        },
      );
    }, SLIDER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [graph, sunMin, walkMin, travelMode, search]);

  const region = useMemo(() => (current ? mergeRegion(cacheRef.current, current) : null), [current]);

  const status: SunBudgetStatus = !active
    ? "off"
    : !start
      ? "picking"
      : graph === "error"
        ? "error"
        : graph && typeof graph !== "string" && graph.status === "uncovered"
          ? "uncovered"
          : current
            ? "ready"
            : "loading";

  return {
    status,
    start,
    sunMin,
    walkMin,
    region,
    outcome: current?.result.outcome ?? null,
    nodes: graph && typeof graph !== "string" && graph.status === "ok" ? graph.graph.nodes : null,
    enter,
    exit,
    setStart: setStartState,
    setSunMin,
    setWalkMin,
  };
}
