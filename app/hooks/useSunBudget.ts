/**
 * H3b — Sun Budget: pick a start, then see every street reachable on at most
 * `sunMin` minutes of direct sun and `walkMin` minutes of walking, one way.
 *
 * One graph per (start, departure slot); budget changes only re-search it.
 * Every result is cached against the graph object it was computed on, and only
 * that graph's results are shown or merged — a search for an old start that
 * lands after the start moved can never paint into the new region. The map
 * paints `mergeRegion` over them, so widening a budget never removes a street.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildReachGraph, type ReachGraph } from "../lib/navigationData/reachGraph";
import { type CachedReach, mergeRegion, type ReachRegion } from "../lib/reach/mergeRegion";
import { searchSunReach } from "../lib/routingWorkerClient";
import type { SunReachOutcome } from "../lib/sunReach";

export type SunBudgetStatus = "off" | "picking" | "loading" | "uncovered" | "ready" | "error" | "sun-down";

/** The graph is built for the longest walk the panel offers, so changing walk time never refetches. */
export const SUN_BUDGET_WALK_MINUTES = [10, 20, 30] as const;
const GRAPH_WALK_SEC = Math.max(...SUN_BUDGET_WALK_MINUTES) * 60;
const SLIDER_DEBOUNCE_MS = 150;
/** While the timeline plays, wait for the clock to settle before rebuilding. */
const DEPARTURE_SETTLE_MS = 600;
const SLOT_MS = 15 * 60_000;

type OkGraph = Extract<ReachGraph, { status: "ok" }>;
/** A result, and the graph it is a result for. */
type Entry = CachedReach & { graph: OkGraph };

export interface SunBudgetState {
  status: SunBudgetStatus;
  start: [number, number] | null;
  /** Where the search starts: the snapped point on the street. */
  startPoint: [number, number] | null;
  sunMin: number;
  walkMin: number;
  /** The budgets of the region on screen — they trail the sliders while a search runs. */
  shown: { sunMin: number; walkMin: number } | null;
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
  sunDown: boolean,
  // Injected so tests need no network or worker; module functions, so stable.
  build: typeof buildReachGraph = buildReachGraph,
  search: typeof searchSunReach = searchSunReach,
): SunBudgetState {
  const [active, setActive] = useState(false);
  const [start, setStartState] = useState<[number, number] | null>(null);
  const [sunMin, setSunMin] = useState(8);
  const [walkMin, setWalkMin] = useState(20);
  const [graph, setGraph] = useState<ReachGraph | "loading" | "error" | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentKey, setCurrentKey] = useState<{ graph: OkGraph; sunSec: number; timeSec: number } | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  // Read for the cache hit only: a new entry landing must not start another search.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // The shade table is clock-slotted at 15 minutes; round to the nearest slot,
  // as routing does (`shadeSlotsForDeparture`). Debounced so a playing
  // timeline does not rebuild the graph on every slot it passes.
  const slot = Math.round(departure.getTime() / SLOT_MS);
  const [settledSlot, setSettledSlot] = useState(slot);
  useEffect(() => {
    const timer = setTimeout(() => setSettledSlot(slot), DEPARTURE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [slot]);

  const enter = useCallback(() => setActive(true), []);
  const exit = useCallback(() => {
    setActive(false);
    setStartState(null);
  }, []);

  // A new start or departure slot is a new graph.
  useEffect(() => {
    setEntries([]);
    setCurrentKey(null);
    setSearchFailed(false);
    if (!active || !start || sunDown) {
      setGraph(null);
      return;
    }
    const controller = new AbortController();
    setGraph("loading");
    build({
      center: start,
      timeBudgetSec: GRAPH_WALK_SEC,
      departure: new Date(settledSlot * SLOT_MS),
      // The panel speaks in walking minutes, so the region is a walking one.
      travelMode: "walk",
      signal: controller.signal,
    }).then(
      (built) => {
        if (!controller.signal.aborted) setGraph(built);
      },
      (error) => {
        if (controller.signal.aborted) return;
        console.warn("[sun budget] graph failed", error);
        setGraph("error");
      },
    );
    return () => controller.abort();
  }, [active, start, settledSlot, sunDown, build]);

  const okGraph = graph && typeof graph !== "string" && graph.status === "ok" ? graph : null;

  // Re-search on a budget change, debounced; a newer change aborts the older search.
  useEffect(() => {
    if (!okGraph) return;
    const sunSec = sunMin * 60;
    const timeSec = walkMin * 60;
    const key = { graph: okGraph, sunSec, timeSec };
    if (entriesRef.current.some((e) => e.graph === okGraph && e.sunSec === sunSec && e.timeSec === timeSec)) {
      setCurrentKey(key);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(
        okGraph.graph,
        okGraph.startId,
        { sunBudgetSec: sunSec, timeBudgetSec: timeSec, travelMode: "walk", timeAware: okGraph.timeAware },
        { signal: controller.signal },
      ).then(
        (result) => {
          if (controller.signal.aborted) return;
          setSearchFailed(false);
          setEntries((prev) => [...prev, { graph: okGraph, sunSec, timeSec, result }]);
          setCurrentKey(key);
        },
        (error) => {
          if (controller.signal.aborted) return;
          console.warn("[sun budget] search failed", error);
          setSearchFailed(true);
        },
      );
    }, SLIDER_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [okGraph, sunMin, walkMin, search]);

  // Only the current graph's results: a stale entry for another graph is never read.
  const ownEntries = useMemo(() => entries.filter((e) => e.graph === okGraph), [entries, okGraph]);
  const current =
    currentKey && currentKey.graph === okGraph
      ? (ownEntries.find((e) => e.sunSec === currentKey.sunSec && e.timeSec === currentKey.timeSec) ?? null)
      : null;
  const region = useMemo(() => (current ? mergeRegion(ownEntries, current) : null), [ownEntries, current]);

  const status: SunBudgetStatus = !active
    ? "off"
    : !start
      ? "picking"
      : sunDown
        ? "sun-down"
        : graph === "error" || (searchFailed && !current)
          ? "error"
          : graph && typeof graph !== "string" && graph.status === "uncovered"
            ? "uncovered"
            : current
              ? "ready"
              : "loading";

  return {
    status,
    start,
    startPoint: okGraph?.startPoint ?? null,
    sunMin,
    walkMin,
    shown: current ? { sunMin: current.sunSec / 60, walkMin: current.timeSec / 60 } : null,
    region,
    outcome: current?.result.outcome ?? null,
    nodes: okGraph?.graph.nodes ?? null,
    enter,
    exit,
    setStart: setStartState,
    setSunMin,
    setWalkMin,
  };
}
