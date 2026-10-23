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
import { type CachedReach, mergeRegion, type ReachRegion } from "../lib/reach/mergeRegion";
import { buildSunReachGraph, searchSunReachGraph } from "../lib/reach/sunBudgetClient";
import { type BuiltReachGraph, nodeMap } from "../lib/reach/sunBudgetWorkerProtocol";
import type { SunReachOutcome } from "../lib/sunReach";

export type SunBudgetStatus = "off" | "picking" | "loading" | "uncovered" | "ready" | "error" | "sun-down";

/** The graph is built for the longest walk the panel offers, so changing walk time never refetches. */
export const SUN_BUDGET_WALK_MINUTES = [10, 20, 30] as const;
const GRAPH_WALK_SEC = Math.max(...SUN_BUDGET_WALK_MINUTES) * 60;
const SLIDER_DEBOUNCE_MS = 150;
/** While the timeline plays, wait for the clock to settle before rebuilding. */
const DEPARTURE_SETTLE_MS = 600;
const SLOT_MS = 15 * 60_000;

/** A graph the worker built and keeps; the main thread holds its id and node positions. */
type OkGraph = Extract<BuiltReachGraph, { status: "ok" }>;
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
  /** The region was cut at the edge of the shade data (#380). */
  clipped: boolean;
  /** Changes once per start, when its first region is drawn: the moment to fit the map (#378). */
  fitKey: number | null;
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
  build: typeof buildSunReachGraph = buildSunReachGraph,
  search: typeof searchSunReachGraph = searchSunReachGraph,
): SunBudgetState {
  const [active, setActive] = useState(false);
  const [start, setStartState] = useState<[number, number] | null>(null);
  const [sunMin, setSunMin] = useState(8);
  const [walkMin, setWalkMin] = useState(20);
  const [graph, setGraph] = useState<BuiltReachGraph | "loading" | "error" | null>(null);
  // A search error on a kept graph means the worker lost it (it failed and
  // restarted): rebuild once rather than leave the user on an error.
  const [rebuild, setRebuild] = useState(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [currentKey, setCurrentKey] = useState<{ graph: OkGraph; sunSec: number; timeSec: number } | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  // Read for the cache hit only: a new entry landing must not start another search.
  const entriesRef = useRef(entries);
  // One automatic rebuild per question (start + departure), not per graph: a
  // rebuild makes a new graph, so a per-graph guard would rebuild forever.
  const rebuiltRef = useRef(false);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new question (start, departure) resets the guard
  useEffect(() => {
    rebuiltRef.current = false;
  }, [start, settledSlot]);

  const enter = useCallback(() => setActive(true), []);
  const exit = useCallback(() => {
    setActive(false);
    setStartState(null);
  }, []);

  // A new start or departure slot is a new graph.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rebuild` re-asks for the same graph after the worker lost it
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
    // Always walking (the worker builds at walk pace): the panel speaks in walking minutes.
    build(
      { center: start, timeBudgetSec: GRAPH_WALK_SEC, departure: new Date(settledSlot * SLOT_MS) },
      { signal: controller.signal },
    ).then(
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
  }, [active, start, settledSlot, sunDown, build, rebuild]);

  const okGraph = graph && typeof graph !== "string" && graph.status === "ok" ? graph : null;
  // Rebuilt once per graph from the arrays the worker handed over.
  const nodes = useMemo(() => (okGraph ? nodeMap(okGraph) : null), [okGraph]);

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
        okGraph.graphId,
        { sunBudgetSec: sunSec, timeBudgetSec: timeSec, travelMode: "walk" },
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
          // Once per graph: the worker may have restarted and lost it.
          if (!rebuiltRef.current) {
            rebuiltRef.current = true;
            setRebuild((n) => n + 1);
          } else {
            setSearchFailed(true);
          }
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
    // A graph cut at the data's edge may miss streets past it: never "every street".
    outcome: current ? (okGraph?.clipped && current.result.outcome === "exact" ? "approximate" : current.result.outcome) : null,
    clipped: okGraph?.clipped ?? false,
    fitKey: current && okGraph ? okGraph.graphId : null,
    nodes,
    enter,
    exit,
    setStart: setStartState,
    setSunMin,
    setWalkMin,
  };
}
