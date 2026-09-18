import { useEffect, useRef, useState, memo } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { stationConnectors, type TrainDrawData } from "../lib/trainGraph";
import type { LatLng, SketchPoint } from "../lib/routing";
import SunCalc from "suncalc";
import { sunriseSunset } from "../lib/sunTimes";
import { getFoursquareApiStatus, getPlaceDetails, getPlaceInfoFromAddress, isFoursquareRateLimited, type FoursquarePlaceInfo } from "../services/foursquare";
import { escapeHtml, renderPlaceInfoHtml } from "./placePopup";
import { createShadowLayer } from "../lib/shadow/createShadowLayer";
import type { IShadowLayer } from "../lib/shadow/IShadowLayer";
import { attachCanopyLayer, type CanopyLayerHandle, type CanopyLegendState } from "../lib/canopyRaster/canopyLayer";
import CanopyLegend from "./CanopyLegend";
import { DebugFieldLayer } from "../lib/shadowV2Debug/DebugFieldLayer";
import { isShadowV2DebugEnabled, RemoteTileService } from "../lib/shadowV2Debug/RemoteTileService";
import type { DebugAccounting } from "../lib/shadowV2Debug/protocol";
import { ShadowV2DebugPanel } from "./ShadowV2DebugPanel";

export interface AccumulationOptions {
  enabled: boolean;
  startDate: Date;
  endDate: Date;
  iterations: number;
}

interface MapViewProps {
  date: Date;
  accumulation: AccumulationOptions;
  onMapReady?: (map: maplibregl.Map) => void;
  onShadowLayerReady?: (layer: IShadowLayer | null) => void;
  navMode?: boolean;
  onMapClick?: (coord: { lng: number; lat: number }, originalEvent?: MouseEvent) => void;
  navWaypoints?: { a?: [number, number]; b?: [number, number] };
  navRoute?: GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.FeatureCollection | null;
  showSunLines?: boolean;
  mapClickActive?: boolean;
  onMarkerDragEnd?: (slot: 'A' | 'B', coord: { lng: number; lat: number }) => void;
  navTrainDrawData?: TrainDrawData | null;
  navMrtEntrances?: [[number, number], [number, number]] | null;
  additionalWaypoints?: [number, number][];
  userLocation?: [number, number] | null;
  /** Itinerary pins dropped by the AI assistant (numbered, labeled). */
  assistantPins?: { lng: number; lat: number; label?: string }[];
  drawMode?: boolean;
  sketchPoints?: SketchPoint[];
  onSketchPointClick?: (coord: LatLng) => void;
  onSketchPointDrag?: (index: number, coord: LatLng) => void;
  onSketchFinish?: () => void;
  simplifiedWaypoints?: LatLng[] | null;
}

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY ?? "";
const SHADOW_V2_DEBUG = isShadowV2DebugEnabled();
// The proxy is intentionally dev-only. Production continues to use the Worker
// directly, preserving its existing CORS policy.
const SHADOW_DEBUG_BASE = import.meta.env.DEV ? "/__shadow" : (import.meta.env.VITE_SHADOW_API_BASE ?? "").replace(/\/$/, "");
const EMPTY_DEBUG_ACCOUNTING: DebugAccounting = { cacheBytes: 0, compressedBytes: 0, workerBytes: 0, stagingBytes: 0, gpuBytes: 0, requested: 0, inFlight: 0, ready: 0, incomplete: 0, error: 0, evicted: 0 };

/**
 * Ensure nav overlays stay visible.
 *
 * The shadow layer draws the tilted buildings itself, and it writes depth doing
 * so, so a building between the camera and the route would occlude the line.
 * Route, transit and sketch overlays belong on top of it.
 *
 * We defensively move key overlay layers to the top whenever we (re)apply them.
 * Note this list deliberately omits `local-shadow-layer`: it has to stay below
 * the overlays, and this runs on every shadow recompute.
 */
/**
 * Vector-tile source layers whose symbols are *places* — what a person is looking
 * for on the map, not what the map is made of.
 *
 * These are lifted above the shadow layer so a building never hides them. The
 * layers left behind (`transportation_name`, `water_name`, contours) are the ones
 * whose whole job is to label the ground, and seeing a street name printed across
 * the tower standing on it is a large part of what reads as "transparent
 * buildings".
 */
const PLACE_LABEL_SOURCE_LAYERS = new Set([
  "poi",
  "outdoor_poi",
  "place",
  "park",
  "aerodrome_label",
  "mountain_peak",
]);

/**
 * A place-label layer and the layer it originally sat immediately below.
 *
 * Capture this before *any* of our own layers are added, so no successor is one of
 * them. `bringNavOverlaysToFront` reshuffles ours on every shadow recompute, and a
 * slot anchored to one would restore its label above the buildings rather than
 * below — which, since the style's last layers are a solid run of place labels,
 * strands the whole run. A label that was last in the basemap has no successor and
 * restores to just under the shadow layer, the top of the basemap now.
 */
type PlaceLabelSlot = { id: string; beforeId: string | undefined };

/** The place-label layers of the current style, each with the slot it came from. */
function findPlaceLabelSlots(map: maplibregl.Map): PlaceLabelSlot[] {
  const order = map.getLayersOrder();
  const slots: PlaceLabelSlot[] = [];
  for (let i = 0; i < order.length; i++) {
    const layer = map.getLayer(order[i]);
    if (layer?.type !== "symbol") continue;
    if (!PLACE_LABEL_SOURCE_LAYERS.has(layer.sourceLayer ?? "")) continue;
    slots.push({ id: order[i], beforeId: order[i + 1] });
  }
  return slots;
}

/**
 * Float the basemap's place labels over the buildings, or put them back.
 *
 * Only while the camera is tilted. Everything above the first 3D layer is drawn
 * by MapLibre with depth testing off, so a layer lifted up here is unconditionally
 * visible over the extrusions — but flat-on there are no extrusions to hide behind,
 * and the flat view is the one the shadow sampler reads back off the canvas
 * (invariant #5), where an untinted label over a shadowed sidewalk would score as
 * open sun. Restoring walks the slots backwards so each layer's recorded successor
 * is already home by the time it is used.
 */
function setPlaceLabelsAboveBuildings(
  map: maplibregl.Map,
  slots: PlaceLabelSlot[],
  shadowLayerId: string,
  above: boolean
) {
  const move = (id: string, beforeId?: string) => {
    if (!map.getLayer(id)) return;
    if (beforeId && !map.getLayer(beforeId)) return;
    map.moveLayer(id, beforeId);
  };
  if (above) {
    for (const slot of slots) move(slot.id);
  } else {
    for (let i = slots.length - 1; i >= 0; i--) {
      move(slots[i].id, slots[i].beforeId ?? shadowLayerId);
    }
  }
  bringNavOverlaysToFront(map);
}

function bringNavOverlaysToFront(map: maplibregl.Map) {
  const layerIds = [
    // Main walking route
    "nav-route-line",
    // Train routing overlays
    "train-route-lines-layer",
    "train-route-stops-layer",
    "train-route-transfers-outer",
    "train-route-transfers-inner",
    // MRT connector
    "mrt-entrance-connector-line",
    // Sketch overlays (when active)
    "sketch-line-layer",
    "sketch-preview-layer",
  ];

  for (const id of layerIds) {
    if (map.getLayer(id)) {
      try {
        // No `beforeId` moves it to the top of the layer stack.
        map.moveLayer(id);
      } catch {
        // moveLayer can throw transiently while the style is updating; ignore.
      }
    }
  }
}

function waitForMapLoad(map: maplibregl.Map): Promise<void> {
  return new Promise((resolve) => {
    function check() {
      if (map.loaded()) { resolve(); return; }
      map.once("render", check);
    }
    check();
  });
}

// ---------------------------------------------------------------------------
// Solar math
// ---------------------------------------------------------------------------

function computeSolarAzimuth(date: Date, latDeg: number, lngDeg: number): number {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * (Math.PI / 180);
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * (Math.PI / 180);
  const epsilon = (23.439 - 0.0000004 * n) * (Math.PI / 180);
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const GMST = (280.46061837 + 360.98564736629 * n) % 360;
  const RA = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) * (180 / Math.PI);
  const HA = ((GMST + lngDeg - RA) % 360) * (Math.PI / 180);
  const latRad = latDeg * (Math.PI / 180);
  const sinElev = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(HA);
  const cosElev = Math.sqrt(1 - sinElev * sinElev);
  if (cosElev < 1e-10) return 0;
  const sinAz = -Math.cos(dec) * Math.sin(HA) / cosElev;
  const cosAz = (Math.sin(dec) - Math.sin(latRad) * sinElev) / (Math.cos(latRad) * cosElev);
  return (Math.atan2(sinAz, cosAz) * (180 / Math.PI) + 360) % 360;
}

/**
 * Compass bearings of sunrise and sunset, for the sun compass.
 *
 * Both instants come from `app/lib/sunTimes.ts`, so the compass and the timeline
 * markers can no longer disagree. This was a private copy of the same orbital
 * math anchored on `noon.setHours(12, 0, 0, 0)` — the *browser's* local noon, not
 * the map's — which slipped a solar day whenever the map was far from the viewer
 * (#225). The error was small, at most ~0.5° near an equinox, but it was real and
 * it was invisible.
 */
function computeSunriseSetAzimuths(
  date: Date,
  latDeg: number,
  lngDeg: number
): { rise: number; set: number } | null {
  const t = sunriseSunset(date, latDeg, lngDeg);
  if (!t) return null; // polar day or polar night
  // SunCalc measures azimuth in radians from south; the map wants compass degrees.
  const compass = (at: Date) =>
    (SunCalc.getPosition(at, latDeg, lngDeg).azimuth * (180 / Math.PI) + 180) % 360;
  return { rise: compass(t.sunrise), set: compass(t.sunset) };
}

// ---------------------------------------------------------------------------
// Solar math caching — avoid recomputing trig when inputs barely changed
// ---------------------------------------------------------------------------

let _azCache: { dateMs: number; lat: number; lng: number; az: number } | null = null;

function computeSolarAzimuthCached(date: Date, latDeg: number, lngDeg: number): number {
  const dateMs = date.getTime();
  if (_azCache &&
      Math.abs(_azCache.dateMs - dateMs) < 60000 &&
      Math.abs(_azCache.lat - latDeg) < 0.01 &&
      Math.abs(_azCache.lng - lngDeg) < 0.01) {
    return _azCache.az;
  }
  const az = computeSolarAzimuth(date, latDeg, lngDeg);
  _azCache = { dateMs, lat: latDeg, lng: lngDeg, az };
  return az;
}

let _rsCache:
  { dateMs: number; lat: number; lng: number; rise: number | null; set: number | null } | null = null;

function computeSunriseSetAzimuthsCached(
  date: Date,
  latDeg: number,
  lngDeg: number
): { rise: number; set: number } | null {
  const dateMs = date.getTime();
  // Longitude is part of the key: the bearings genuinely depend on it now, so a
  // key without it would serve a stale compass after an east-west pan.
  if (_rsCache &&
      Math.abs(_rsCache.dateMs - dateMs) < 60000 &&
      Math.abs(_rsCache.lat - latDeg) < 0.01 &&
      Math.abs(_rsCache.lng - lngDeg) < 0.01) {
    if (_rsCache.rise === null || _rsCache.set === null) return null;
    return { rise: _rsCache.rise, set: _rsCache.set };
  }
  const rs = computeSunriseSetAzimuths(date, latDeg, lngDeg);
  _rsCache = { dateMs, lat: latDeg, lng: lngDeg, rise: rs?.rise ?? null, set: rs?.set ?? null };
  return rs;
}

// ---------------------------------------------------------------------------
// SVG geometry helpers (screen-space: 0° = up, clockwise)
// ---------------------------------------------------------------------------

/** Convert a screen-space angle (deg, CW from up) to an SVG [x,y] on a circle. */
function svgPt(cx: number, cy: number, r: number, screenDeg: number): [number, number] {
  const rad = (screenDeg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
}

/**
 * SVG path for a pie sector from startScreen to endScreen (clockwise).
 * Returns empty string for degenerate arcs.
 */
function sectorPath(
  cx: number, cy: number, r: number,
  startScreen: number, endScreen: number
): string {
  const arc = ((endScreen - startScreen) + 360) % 360;
  if (arc < 0.01 || arc > 359.99) return "";
  const [sx, sy] = svgPt(cx, cy, r, startScreen);
  const [ex, ey] = svgPt(cx, cy, r, endScreen);
  const laf = arc > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${laf} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z`;
}

// ---------------------------------------------------------------------------
// Sun viz state type
// ---------------------------------------------------------------------------

interface SunViz {
  sunAz: number;
  riseAz: number | null;
  setAz: number | null;
  bearing: number;
}

// ---------------------------------------------------------------------------
// Sun compass — memoized so sunViz changes don't re-render MapView's heavy tree
// ---------------------------------------------------------------------------

const SunCompass = memo(function SunCompass({ sunViz, showSunLines }: { sunViz: SunViz; showSunLines: boolean }) {
  if (!showSunLines) return null;

  const CX = 200, CY = 200, R = 160;
  const sunScreen  = sunViz.sunAz  - sunViz.bearing;
  const riseScreen = sunViz.riseAz !== null ? sunViz.riseAz - sunViz.bearing : null;
  const setScreen  = sunViz.setAz  !== null ? sunViz.setAz  - sunViz.bearing : null;

  const dayPath   = (riseScreen !== null && setScreen !== null)
    ? sectorPath(CX, CY, R, riseScreen, setScreen)   : null;
  const nightPath = (riseScreen !== null && setScreen !== null)
    ? sectorPath(CX, CY, R, setScreen, riseScreen)   : null;

  const [riseGx, riseGy] = riseScreen !== null ? svgPt(CX, CY, R, riseScreen) : [CX, CY - R];
  const [setGx,  setGy]  = setScreen  !== null ? svgPt(CX, CY, R, setScreen)  : [CX, CY + R];
  const [riseLx, riseLy] = riseScreen !== null ? svgPt(CX, CY, R, riseScreen) : [CX, CY];
  const [setLx,  setLy]  = setScreen  !== null ? svgPt(CX, CY, R, setScreen)  : [CX, CY];

  const ARROW_GAP = 8;
  const [tipX, tipY]     = svgPt(CX, CY, R + ARROW_GAP + 20, sunScreen);
  const [b1x, b1y]       = svgPt(CX, CY, R + ARROW_GAP,      sunScreen - 6);
  const [b2x, b2y]       = svgPt(CX, CY, R + ARROW_GAP,      sunScreen + 6);
  const [sunEmX, sunEmY] = svgPt(CX, CY, R + ARROW_GAP + 44, sunScreen);

  return (
    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
      <svg aria-hidden="true" focusable="false" width="400" height="400" viewBox="0 0 400 400" style={{ overflow: "visible" }}>
        <defs>
          <linearGradient
            id="sunDayGrad"
            gradientUnits="userSpaceOnUse"
            x1={riseGx} y1={riseGy}
            x2={setGx}  y2={setGy}
          >
            <stop offset="0%"   stopColor="#c2410c" stopOpacity="0.30" />
            <stop offset="100%" stopColor="#1e3a8a" stopOpacity="0.30" />
          </linearGradient>
        </defs>
        {nightPath
          ? <path d={nightPath} fill="#374151" fillOpacity="0.22" />
          : <circle cx={CX} cy={CY} r={R} fill="#374151" fillOpacity="0.22" />
        }
        {dayPath && <path d={dayPath} fill="url(#sunDayGrad)" />}
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
        {riseScreen !== null && (
          <line x1={CX} y1={CY} x2={riseLx} y2={riseLy} stroke="#c2410c" strokeWidth="1.5" strokeOpacity="0.75" />
        )}
        {setScreen !== null && (
          <line x1={CX} y1={CY} x2={setLx} y2={setLy} stroke="#1e40af" strokeWidth="1.5" strokeOpacity="0.75" />
        )}
        <polygon
          points={`${tipX.toFixed(2)},${tipY.toFixed(2)} ${b1x.toFixed(2)},${b1y.toFixed(2)} ${b2x.toFixed(2)},${b2y.toFixed(2)}`}
          fill="#fde047" fillOpacity="0.92"
        />
        <text
          x={sunEmX.toFixed(2)} y={sunEmY.toFixed(2)}
          textAnchor="middle" dominantBaseline="middle" fontSize="18"
          style={{ userSelect: "none" }}
        >
          ☀
        </text>
      </svg>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapView({
  date,
  accumulation,
  onMapReady,
  onShadowLayerReady,
  onMapClick,
  navWaypoints,
  navRoute,
  showSunLines = false,
  mapClickActive = false,
  onMarkerDragEnd,
  navTrainDrawData,
  navMrtEntrances,
  additionalWaypoints,
  userLocation,
  assistantPins,
  drawMode = false,
  sketchPoints = [],
  onSketchPointClick,
  onSketchPointDrag,
  onSketchFinish,
  simplifiedWaypoints,
}: MapViewProps) {
  const containerRef    = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<maplibregl.Map | null>(null);
  const shadowRef        = useRef<IShadowLayer | null>(null);
  const initRef         = useRef(false);
  const dateRef         = useRef(date);
  const shadowUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMapClickRef      = useRef(onMapClick);
  const onMarkerDragEndRef = useRef(onMarkerDragEnd);
  const markerARef         = useRef<maplibregl.Marker | null>(null);
  const markerBRef         = useRef<maplibregl.Marker | null>(null);
  const markerBoardRef     = useRef<maplibregl.Marker | null>(null);
  const markerAlightRef    = useRef<maplibregl.Marker | null>(null);
  const markerWpRefs          = useRef<maplibregl.Marker[]>([]);
  const assistantPinRefs      = useRef<maplibregl.Marker[]>([]);
  const userLocationMarkerRef = useRef<maplibregl.Marker | null>(null);
  const showSunLinesRef       = useRef(showSunLines);
  const drawModeRef             = useRef(drawMode);
  const sketchPointsRef         = useRef<SketchPoint[]>([]);
  const onSketchPointClickRef   = useRef(onSketchPointClick);
  const onSketchPointDragRef    = useRef(onSketchPointDrag);
  const onSketchFinishRef       = useRef(onSketchFinish);
  const sketchMarkerRefs        = useRef<maplibregl.Marker[]>([]);
  const sketchPinnedPopupRef    = useRef<maplibregl.Popup | null>(null);
  const sketchPinnedMarkerElRef = useRef<HTMLElement | null>(null);
  const simplifiedMarkerRefs  = useRef<maplibregl.Marker[]>([]);
  const simplifiedPinnedPopupRef = useRef<maplibregl.Popup | null>(null);
  const simplifiedPinnedMarkerElRef = useRef<HTMLElement | null>(null);
  const navRouteRef           = useRef<typeof navRoute>(navRoute);

  // Foursquare place-info popup for draw-mode markers
  const placePopupRef         = useRef<maplibregl.Popup | null>(null);
  const placePopupMarkerElRef = useRef<HTMLElement | null>(null);
  // Guards against late async responses overwriting a newer popup click.
  const placePopupRequestIdRef = useRef(0);
  // Persist fsq_id lookups across marker re-creation. Keyed by exact coord string.
  const fsqIdByCoordRef       = useRef<Map<string, string>>(new Map());

  const [sunViz, setSunViz] = useState<SunViz>({
    sunAz: 180, riseAz: null, setAz: null, bearing: 0,
  });
  // Local UI state: whether the estimated-canopy fill is on screen, for its legend.
  const [canopyLegend, setCanopyLegend] = useState<CanopyLegendState | null>(null);
  const [debugAccounting, setDebugAccounting] = useState<DebugAccounting>(EMPTY_DEBUG_ACCOUNTING);
  const [debugGeneration, setDebugGeneration] = useState<string>();
  const [debugCacheSource, setDebugCacheSource] = useState<string>();
  const canopyRef = useRef<CanopyLayerHandle | null>(null);
  // Read at map load, which can come after Sun Exposure was toggled — the mount-time
  // `accumulation` prop would be stale by then.
  const accumulationOnRef = useRef(accumulation.enabled);

  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { onSketchPointClickRef.current = onSketchPointClick; }, [onSketchPointClick]);
  useEffect(() => { onSketchPointDragRef.current = onSketchPointDrag; }, [onSketchPointDrag]);
  useEffect(() => { onSketchFinishRef.current = onSketchFinish; }, [onSketchFinish]);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  useEffect(() => { onMarkerDragEndRef.current = onMarkerDragEnd; }, [onMarkerDragEnd]);

  const getSketchAddressForCoord = (coord: LatLng): string | null => {
    // Match exact coordinates; simplifyPolyline returns a subset of original points.
    const pts = sketchPointsRef.current;
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      if (p.coord[0] === coord[0] && p.coord[1] === coord[1]) {
        return p.address;
      }
    }
    return null;
  };

  const ensurePlacePopup = (): maplibregl.Popup => {
    if (!placePopupRef.current) {
      placePopupRef.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        anchor: "bottom-left",
        offset: 14,
        className: "nav-place-popup nav-place-popup--pinned",
      });
    }
    return placePopupRef.current;
  };

  const renderPlacePopupHtml = (
    info: FoursquarePlaceInfo | null,
    fallbackAddress: string,
    loading: boolean
  ): string => {
    if (loading) {
      return `<div class="text-xs text-white/90">Loading…</div>`;
    }

    // If Foursquare isn't available/configured, show a friendly inline message.
    if (!info) {
      if (isFoursquareRateLimited()) {
        return `<div class="text-xs text-white/85">Foursquare rate limit reached. Try again shortly.</div>`;
      }
      const status = getFoursquareApiStatus();
      if (status === "missing_key") {
        return `<div class="text-xs text-white/85">Foursquare API key not configured.</div>`;
      }
      if (status === "unauthorized" || status === "forbidden") {
        return `<div class="text-xs text-white/85">Foursquare API key unauthorized.</div>`;
      }
      if (fallbackAddress) {
        return `<div class="text-xs text-white/90 font-medium">${escapeHtml(fallbackAddress)}</div>`;
      }
      return `<div class="text-xs text-white/85">No place found.</div>`;
    }

    return renderPlaceInfoHtml(info, fallbackAddress);
  };

  const openPlacePopupForAddress = (map: maplibregl.Map, markerEl: HTMLElement, coord: LatLng, address: string) => {
    const popup = ensurePlacePopup();
    popup.setLngLat(coord).setHTML(renderPlacePopupHtml(null, address, true)).addTo(map);
    placePopupMarkerElRef.current = markerEl;

    const reqId = ++placePopupRequestIdRef.current;

    const coordKey = `${coord[0]},${coord[1]}`;
    const existingFsqId = markerEl.dataset.fsqId || fsqIdByCoordRef.current.get(coordKey) || "";
    if (existingFsqId) {
      // Mirror onto the element dataset for dev inspection.
      markerEl.dataset.fsqId = existingFsqId;
    }

    (async () => {
      try {
        // If we already know the fsq_id for this marker, skip search and go
        // straight to Place Details.
        let info: FoursquarePlaceInfo | null = null;
        if (existingFsqId) {
          info = await getPlaceDetails(existingFsqId);
        } else {
          info = await getPlaceInfoFromAddress(address, coord[1], coord[0]);
          const newId = info?.fsqId;
          if (newId) {
            fsqIdByCoordRef.current.set(coordKey, newId);
            markerEl.dataset.fsqId = newId;
          }
        }

        // Only update if this is still the latest click for this popup.
        if (placePopupRequestIdRef.current !== reqId) return;
        if (!placePopupRef.current || !placePopupRef.current.isOpen()) return;
        if (placePopupMarkerElRef.current !== markerEl) return;
        popup.setHTML(renderPlacePopupHtml(info, address, false));
      } catch (e) {
        if (placePopupRequestIdRef.current !== reqId) return;
        if (!placePopupRef.current || !placePopupRef.current.isOpen()) return;
        if (placePopupMarkerElRef.current !== markerEl) return;
        popup.setHTML(renderPlacePopupHtml(null, address, false));
      }
    })();
  };

  // Close any address-only draw popups, since draw markers now show Foursquare
  // info in `placePopupRef`.
  const closeDrawAddressPopups = () => {
    sketchPinnedPopupRef.current?.remove();
    simplifiedPinnedPopupRef.current?.remove();
    sketchPinnedMarkerElRef.current = null;
    simplifiedPinnedMarkerElRef.current = null;
  };

  // -------------------------------------------------------------------------
  // Initialize map once
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || initRef.current) return;
    initRef.current = true;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center: [0, 20],
      zoom: 2,
      maxTileCacheSize: 50,
      // @ts-expect-error — property exists at runtime but is missing from MapLibre types
      maxParallelImageRequests: 6,
      // antialias enables MSAA on the main drawing buffer → smooths building /
      // vector-geometry edges. Coexists with preserveDrawingBuffer in WebGL2.
      // (Shadow-layer edges are AA'd separately via FBO supersampling — see
      // LocalShadowAdapter.ensureFBO; MSAA can't touch a pre-rasterized texture.)
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    mapRef.current = map;
    onMapReady?.(map);

    // Close pinned point popups when clicking anywhere else.
    // Use a document-level capture handler so it works even when the map is draggable.
    const onDocPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;

      const maybeClose = (
        popupRef: { current: maplibregl.Popup | null },
        markerElRef: { current: HTMLElement | null }
      ) => {
        const p = popupRef.current;
        if (!p || !p.isOpen()) return;

        const markerEl = markerElRef.current;
        if (markerEl && markerEl.contains(target)) return;

        // MapLibre Popup exposes getElement() in mapbox-gl / maplibre-gl.
        const popupEl = (p as unknown as { getElement?: () => HTMLElement }).getElement?.();
        if (popupEl && popupEl.contains(target)) return;

        p.remove();
        markerElRef.current = null;
      };

      maybeClose(simplifiedPinnedPopupRef, simplifiedPinnedMarkerElRef);
      maybeClose(sketchPinnedPopupRef, sketchPinnedMarkerElRef);
      maybeClose(placePopupRef, placePopupMarkerElRef);
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);

    map.on("click", (e) => {
      if (drawModeRef.current) {
        const pt: LatLng = [e.lngLat.lng, e.lngLat.lat];
        onSketchPointClickRef.current?.(pt);
        return;
      }
      onMapClickRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat }, e.originalEvent);
    });

    // Rubber band preview line: updates on every mouse move during draw mode
    map.on("mousemove", (e) => {
      const points = sketchPointsRef.current;
      if (drawModeRef.current && points.length >= 1) {
        const cursor: LatLng = [e.lngLat.lng, e.lngLat.lat];
        const lastPt = points[points.length - 1].coord;
        const src = map.getSource("sketch-preview") as maplibregl.GeoJSONSource | undefined;
        src?.setData({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [lastPt, cursor] },
        });
      }
    });

    // Recompute all sun viz state (bearing + azimuths)
    const refreshSunViz = () => {
      if (!showSunLinesRef.current) return;
      const { lng, lat } = map.getCenter();
      const sunAz = computeSolarAzimuthCached(dateRef.current, lat, lng);
      const rs    = computeSunriseSetAzimuthsCached(dateRef.current, lat, lng);
      setSunViz({
        sunAz,
        riseAz:  rs?.rise ?? null,
        setAz:   rs?.set  ?? null,
        bearing: map.getBearing(),
      });
    };

    // rotate only changes bearing; azimuth values are unchanged.
    // Throttled to one React state update per animation frame to avoid
    // triggering dozens of re-renders per second during smooth rotation gestures.
    let rotateRafPending = false;
    const rotateHandler = () => {
      if (!showSunLinesRef.current) return;
      if (rotateRafPending) return;
      rotateRafPending = true;
      requestAnimationFrame(() => {
        rotateRafPending = false;
        setSunViz((prev) => ({ ...prev, bearing: map.getBearing() }));
      });
    };
    map.on("rotate", rotateHandler);

    map.on("moveend", refreshSunViz);

    let debugService: RemoteTileService | undefined;
    let debugLayer: DebugFieldLayer | undefined;
    const updateDebugViewport = () => {
      const center = map.getCenter();
      debugService?.updateViewport({ lng: center.lng, lat: center.lat, zoom: map.getZoom() });
    };

    map.on("load", async () => {
      // Captured first, while the style still holds nothing but the basemap — see
      // `PlaceLabelSlot`.
      const placeLabelSlots = findPlaceLabelSlots(map);

      if (SHADOW_V2_DEBUG && SHADOW_DEBUG_BASE) {
        debugLayer = new DebugFieldLayer();
        debugLayer.onGpuBytes = (bytes) => debugService?.setGpuBytes(bytes);
        map.addLayer(debugLayer);
        debugService = new RemoteTileService(SHADOW_DEBUG_BASE);
        debugService.onGenerationReady = (root) => {
          setDebugGeneration(root.generation);
          updateDebugViewport();
        };
        debugService.onTileUpdate = (update) => {
          // A service already suppresses stale generations; the layer receives only
          // cropped 256² staging textures, never decoded source planes or gutters.
          debugLayer?.setTile(update.tile, update.pixels);
          setDebugCacheSource(update.complete ? update.cacheSource : "incomplete");
          map.triggerRepaint();
        };
        debugService.onTileEvicted = (tile) => {
          debugLayer?.removeTile(tile);
          map.triggerRepaint();
        };
        debugService.onTileReleased = (tile) => {
          debugLayer?.removeTile(tile);
          map.triggerRepaint();
        };
        debugService.onGenerationReset = () => {
          debugLayer?.clearTiles();
          map.triggerRepaint();
        };
        debugService.onAccounting = setDebugAccounting;
        map.on("moveend", updateDebugViewport);
      }

      // Sketch drawing layer — always present, hidden by default
      map.addSource("sketch-line", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "sketch-line-layer",
        type: "line",
        source: "sketch-line",
        layout: { visibility: "none" },
        paint: {
          "line-color": "#facc15",
          "line-width": 2.5,
          "line-dasharray": [4, 3],
          "line-opacity": 0.85,
        },
      });

      // Rubber band preview line — from last sketch point to cursor
      map.addSource("sketch-preview", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "sketch-preview-layer",
        type: "line",
        source: "sketch-preview",
        layout: { visibility: "none" },
        paint: {
          "line-color": "#facc15",
          "line-width": 1.5,
          "line-opacity": 0.45,
        },
      });

      // Nav route line — added at load so we only ever setData from the effect (avoids
      // addSource/addLayer timing issues when route is computed after style is ready).
      map.addSource("nav-route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "nav-route-line",
        type: "line",
        source: "nav-route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#f59e0b", "line-width": 4, "line-opacity": 0.9 },
      });
      const navSrc = map.getSource("nav-route") as maplibregl.GeoJSONSource;
      const current = navRouteRef.current;
      navSrc.setData(
        current ? (current as GeoJSON.GeoJSON) : { type: "FeatureCollection", features: [] }
      );
      if (current) bringNavOverlaysToFront(map);

      // There is deliberately no terrain here. Terrain replaces the ground with a
      // displaced mesh while the shadow layer's triangles stay at z = 0, so shadows
      // float over valleys and sink into rises. Fixing that means sampling the DEM in
      // the shadow vertex shader; elevation adds nothing to urban pedestrian shadow, so
      // the feature is gone rather than broken.

      // Create local shadow layer
      const shadowLayer = createShadowLayer(map, {
        date: dateRef.current,
      });

      shadowRef.current = shadowLayer;
      onShadowLayerReady?.(shadowLayer);

      // If local renderer (CustomLayer), register it as a map layer
      const maybeCustom = shadowLayer as unknown as maplibregl.CustomLayerInterface;
      if (maybeCustom?.type === 'custom' && typeof maybeCustom?.render === 'function') {
        if (!map.getLayer(maybeCustom.id)) {
          // Topmost, because this one layer draws both the ground shadow and the
          // tilted buildings, in that order and in one pass — so the buildings cover
          // the ground shadow without needing a separate style layer above it.
          // `bringNavOverlaysToFront` then lifts the route back over both.
          map.addLayer(maybeCustom);

          // Place labels ride above the extrusions, but only while tilted.
          //
          // On `pitch`, not `pitchend`: the 3D toggle is a 400 ms ease, and Pass E
          // starts drawing buildings the moment pitch leaves 0, so waiting for the
          // ease to settle buries the labels for the whole tilt. The remembered
          // state makes every frame of that ease free — the layer moves happen once,
          // as pitch crosses 0, rather than on each of the ~24 events it fires.
          let labelsLifted: boolean | null = null;
          const updateLabelDepth = () => {
            const lift = map.getPitch() > 0;
            if (lift === labelsLifted) return;
            labelsLifted = lift;
            setPlaceLabelsAboveBuildings(map, placeLabelSlots, maybeCustom.id, lift);
          };
          map.on("pitch", updateLabelDepth);
          map.on("pitchend", updateLabelDepth);
          updateLabelDepth();
        }

        // Estimated canopy from the raster the route card already quotes (#275).
        // Beneath the shadow layer, never above it — see `canopyLayer.ts`.
        canopyRef.current = attachCanopyLayer(map, {
          belowLayerId: maybeCustom.id,
          enabled: !accumulationOnRef.current,
          onChange: setCanopyLegend,
        });
      }

      shadowLayer.on('idle', () => bringNavOverlaysToFront(map));
      const resizeHandler = () => { shadowRef.current?.setDate(dateRef.current); };
      map.on("resize", resizeHandler);

      bringNavOverlaysToFront(map);

      if (accumulation.enabled) {
        shadowLayer.setSunExposure(true, {
          startDate: accumulation.startDate,
          endDate: accumulation.endDate,
          iterations: accumulation.iterations,
        });
      }

      // Seed sun viz after full map load
      refreshSunViz();
    });

    return () => {
      if (shadowUpdateTimerRef.current) clearTimeout(shadowUpdateTimerRef.current);
      placePopupRef.current?.remove();
      placePopupRef.current = null;
      canopyRef.current?.remove();
      canopyRef.current = null;
      shadowRef.current?.remove();
      shadowRef.current = null;
      onShadowLayerReady?.(null);
      markerARef.current?.remove();      markerARef.current = null;
      markerBRef.current?.remove();     markerBRef.current = null;
      markerBoardRef.current?.remove(); markerBoardRef.current = null;
      markerAlightRef.current?.remove();markerAlightRef.current = null;
      map.off("rotate", rotateHandler);
      map.off("moveend", refreshSunViz);
      map.off("moveend", updateDebugViewport);
      debugService?.shutdown();
      debugService = undefined;
      debugLayer = undefined;
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      map.remove();
      mapRef.current = null;
      initRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Date changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    dateRef.current = date;
    if (shadowUpdateTimerRef.current) clearTimeout(shadowUpdateTimerRef.current);
    shadowUpdateTimerRef.current = setTimeout(() => { shadowRef.current?.setDate(date); }, 1);

    const map = mapRef.current;
    if (map?.isStyleLoaded() && showSunLinesRef.current) {
      const { lng, lat } = map.getCenter();
      const sunAz = computeSolarAzimuthCached(date, lat, lng);
      const rs    = computeSunriseSetAzimuthsCached(date, lat, lng);
      setSunViz({
        sunAz,
        riseAz:  rs?.rise ?? null,
        setAz:   rs?.set  ?? null,
        bearing: map.getBearing(),
      });
    }
  }, [date]);

  // -------------------------------------------------------------------------
  // showSunLines toggle
  // -------------------------------------------------------------------------
  useEffect(() => {
    showSunLinesRef.current = showSunLines;
    if (!showSunLines) return;
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const { lng, lat } = map.getCenter();
    const sunAz = computeSolarAzimuthCached(dateRef.current, lat, lng);
    const rs    = computeSunriseSetAzimuthsCached(dateRef.current, lat, lng);
    setSunViz({
      sunAz,
      riseAz:  rs?.rise ?? null,
      setAz:   rs?.set  ?? null,
      bearing: map.getBearing(),
    });
  }, [showSunLines]);

  // -------------------------------------------------------------------------
  // Accumulation mode
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Sun Exposure's GeoTIFF export writes the canvas as drawn; keep the fill out of it.
    accumulationOnRef.current = accumulation.enabled;
    canopyRef.current?.setEnabled(!accumulation.enabled);
    if (!shadowRef.current) return;
    if (accumulation.enabled) {
      shadowRef.current.setSunExposure(true, {
        startDate: accumulation.startDate,
        endDate: accumulation.endDate,
        iterations: accumulation.iterations,
      });
    } else {
      shadowRef.current.setSunExposure(false);
    }
  }, [accumulation]);

  // -------------------------------------------------------------------------
  // Navigation waypoint markers — reuse existing markers via setLngLat
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Marker A
    if (navWaypoints?.a) {
      if (markerARef.current) {
        markerARef.current.setLngLat(navWaypoints.a);
      } else {
        const mA = new maplibregl.Marker({ color: "#22c55e", draggable: true })
          .setLngLat(navWaypoints.a)
          .addTo(map);
        mA.on('dragend', () => {
          const ll = mA.getLngLat();
          onMarkerDragEndRef.current?.('A', { lng: ll.lng, lat: ll.lat });
        });
        markerARef.current = mA;
      }
    } else {
      markerARef.current?.remove();
      markerARef.current = null;
    }
    // Marker B
    if (navWaypoints?.b) {
      if (markerBRef.current) {
        markerBRef.current.setLngLat(navWaypoints.b);
      } else {
        const mB = new maplibregl.Marker({ color: "#ef4444", draggable: true })
          .setLngLat(navWaypoints.b)
          .addTo(map);
        mB.on('dragend', () => {
          const ll = mB.getLngLat();
          onMarkerDragEndRef.current?.('B', { lng: ll.lng, lat: ll.lat });
        });
        markerBRef.current = mB;
      }
    } else {
      markerBRef.current?.remove();
      markerBRef.current = null;
    }
  }, [navWaypoints]);

  // -------------------------------------------------------------------------
  // Intermediate waypoint markers (numbered grey circles)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mapRef.current) return;
    markerWpRefs.current.forEach(m => m.remove());
    markerWpRefs.current = [];
    (additionalWaypoints ?? []).forEach((wp, i) => {
      const el = document.createElement("div");
      el.style.cssText = `
        width:22px;height:22px;border-radius:50%;
        background:#6b7280;border:2px solid white;
        display:flex;align-items:center;justify-content:center;
        font-size:10px;font-weight:700;color:white;cursor:pointer;
      `;
      el.textContent = String(i + 1);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(wp)
        .addTo(mapRef.current!);
      markerWpRefs.current.push(marker);
    });
  }, [additionalWaypoints]);

  // -------------------------------------------------------------------------
  // Assistant itinerary pins (numbered amber teardrops with label popups)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mapRef.current) return;
    assistantPinRefs.current.forEach((m) => m.remove());
    assistantPinRefs.current = [];
    (assistantPins ?? []).forEach((pin, i) => {
      const el = document.createElement("div");
      el.style.cssText = `
        width:26px;height:26px;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        background:#d97706;border:2px solid white;
        box-shadow:0 2px 6px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;cursor:pointer;
      `;
      const inner = document.createElement("span");
      inner.style.cssText = `transform:rotate(45deg);font-size:11px;font-weight:700;color:white;`;
      inner.textContent = String(i + 1);
      el.appendChild(inner);

      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([pin.lng, pin.lat]);
      if (pin.label) {
        marker.setPopup(
          new maplibregl.Popup({ offset: 28, closeButton: false }).setText(
            `${i + 1}. ${pin.label}`
          )
        );
      }
      marker.addTo(mapRef.current!);
      assistantPinRefs.current.push(marker);
    });
  }, [assistantPins]);

  // -------------------------------------------------------------------------
  // User location dot (pulsing blue) — reuse marker via setLngLat
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!mapRef.current || !userLocation) {
      userLocationMarkerRef.current?.remove();
      userLocationMarkerRef.current = null;
      return;
    }

    if (userLocationMarkerRef.current) {
      userLocationMarkerRef.current.setLngLat(userLocation);
      return;
    }

    const el = document.createElement("div");
    el.style.cssText = `
      width: 18px; height: 18px; position: relative;
      display: flex; align-items: center; justify-content: center;
    `;

    const pulse = document.createElement("div");
    pulse.style.cssText = `
      position: absolute;
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(59, 130, 246, 0.25);
      animation: userLocationPulse 1.8s ease-out infinite;
    `;

    const dot = document.createElement("div");
    dot.style.cssText = `
      width: 14px; height: 14px; border-radius: 50%;
      background: #3b82f6; border: 2.5px solid white;
      box-shadow: 0 0 6px rgba(59,130,246,0.7);
      position: relative; z-index: 1;
    `;

    if (!document.getElementById("user-location-keyframes")) {
      const style = document.createElement("style");
      style.id = "user-location-keyframes";
      style.textContent = `
        @keyframes userLocationPulse {
          0%   { transform: scale(0.6); opacity: 0.8; }
          70%  { transform: scale(1.6); opacity: 0; }
          100% { transform: scale(0.6); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    el.appendChild(pulse);
    el.appendChild(dot);

    userLocationMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(userLocation)
      .addTo(mapRef.current);
  }, [userLocation]);

  // -------------------------------------------------------------------------
  // Draw mode: cursor management
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = drawMode ? "crosshair" : "";
  }, [drawMode]);

  // -------------------------------------------------------------------------
  // Draw mode: sync sketch points ref for rubber band and hover
  // -------------------------------------------------------------------------
  useEffect(() => {
    sketchPointsRef.current = sketchPoints;
  }, [sketchPoints]);

  // -------------------------------------------------------------------------
  // Draw mode: update sketch line GeoJSON + sketch-points layer + last-point marker + preview
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("sketch-line") as maplibregl.GeoJSONSource | undefined;
    const previewSrc = map.getSource("sketch-preview") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const coords = sketchPoints.map((p) => p.coord);

    if (coords.length >= 2 && !navRoute) {
      map.setLayoutProperty("sketch-line-layer", "visibility", "visible");
      src.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    } else {
      map.setLayoutProperty("sketch-line-layer", "visibility", "none");
      src.setData({ type: "FeatureCollection", features: [] });
    }

    // Preview rubber band: show when drawing with ≥1 point, hide otherwise
    if (drawMode && sketchPoints.length >= 1) {
      map.setLayoutProperty("sketch-preview-layer", "visibility", "visible");
    } else {
      map.setLayoutProperty("sketch-preview-layer", "visibility", "none");
      previewSrc?.setData({ type: "FeatureCollection", features: [] });
    }
  }, [sketchPoints, drawMode, navRoute]);

  // -------------------------------------------------------------------------
  // Draw mode: sketch points as DOM markers (larger hit target, consistent click/hover)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // When simplified waypoints are shown, remove all sketch markers
    if (simplifiedWaypoints && simplifiedWaypoints.length > 0) {
      sketchMarkerRefs.current.forEach((m) => m.remove());
      sketchMarkerRefs.current = [];
      return;
    }

    const existing = sketchMarkerRefs.current;
    const newCount = sketchPoints.length;

    // Reuse existing markers — just update position (no destroy/recreate)
    for (let i = 0; i < Math.min(existing.length, newCount); i++) {
      const cur = existing[i].getLngLat();
      const target = sketchPoints[i].coord;
      if (cur.lng !== target[0] || cur.lat !== target[1]) {
        existing[i].setLngLat(target);
      }
    }

    // Create new markers only for newly added points
    for (let i = existing.length; i < newCount; i++) {
      const marker = new maplibregl.Marker({ color: "#facc15" })
        .setLngLat(sketchPoints[i].coord)
        .addTo(map);

      const idx = i;
      const el = marker.getElement();
      el.style.cursor = "grab";

      // Custom DOM-level drag handling via pointer events.
      // We use stopPropagation on pointerdown to prevent the map click handler
      // from adding a duplicate point AND to prevent map panning during drag.
      let isDragging = false;
      let skipNextClick = false;

      el.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        el.setPointerCapture(ev.pointerId);
        isDragging = false;
        map.dragPan.disable();
      });

      el.addEventListener("pointermove", (ev) => {
        if (!el.hasPointerCapture(ev.pointerId)) return;
        isDragging = true;
        const rect = map.getContainer().getBoundingClientRect();
        const lngLat = map.unproject([ev.clientX - rect.left, ev.clientY - rect.top]);
        marker.setLngLat(lngLat);
      });

      el.addEventListener("pointerup", (ev) => {
        if (el.hasPointerCapture(ev.pointerId)) {
          el.releasePointerCapture(ev.pointerId);
        }
        map.dragPan.enable();
        if (isDragging) {
          skipNextClick = true;
          const lngLat = marker.getLngLat();
          onSketchPointDragRef.current?.(idx, [lngLat.lng, lngLat.lat]);
          isDragging = false;
        }
      });

      // Foursquare click — reads address from ref at click time (always current)
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (skipNextClick) { skipNextClick = false; return; }
        const pt = sketchPointsRef.current[idx];
        const address = pt?.address ?? "";
        if (!address.trim()) return;
        closeDrawAddressPopups();
        openPlacePopupForAddress(map, el, pt.coord, address);
      });

      existing.push(marker);
    }

    // Remove excess markers if points were deleted
    while (existing.length > newCount) {
      existing.pop()!.remove();
    }
  }, [sketchPoints, simplifiedWaypoints]);

  // -------------------------------------------------------------------------
  // Draw mode: simplified waypoint dots after sketch finish
  // -------------------------------------------------------------------------
  useEffect(() => {
    simplifiedMarkerRefs.current.forEach((m) => m.remove());
    simplifiedMarkerRefs.current = [];
    const map = mapRef.current;
    if (!map || !simplifiedWaypoints || simplifiedWaypoints.length === 0) return;

    for (const wp of simplifiedWaypoints) {
      const addr = getSketchAddressForCoord(wp);
      const marker = new maplibregl.Marker({ color: "#facc15" })
        .setLngLat(wp)
        .addTo(map);

      const el = marker.getElement();
      el.style.pointerEvents = "auto";
      if (addr) {
        el.style.cursor = "pointer";

        el.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          // Close the old address-only popup if it's open.
          closeDrawAddressPopups();

          openPlacePopupForAddress(map, el, wp, addr);
        });

        // Prevent starting a map drag from the marker; makes clicking more reliable.
        el.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
        });
      }

      simplifiedMarkerRefs.current.push(marker);
    }

  }, [simplifiedWaypoints, sketchPoints]);

  // -------------------------------------------------------------------------
  // Nav route GeoJSON layer — source/layer are created in map.on("load"); we only setData here.
  // -------------------------------------------------------------------------
  useEffect(() => {
    navRouteRef.current = navRoute;

    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource("nav-route") as maplibregl.GeoJSONSource | undefined;
    if (!source) return; // style not loaded yet; load handler will set initial data from ref

    const data: GeoJSON.GeoJSON = navRoute
      ? (navRoute as GeoJSON.GeoJSON)
      : { type: "FeatureCollection", features: [] };
    source.setData(data);
    if (navRoute) bringNavOverlaysToFront(map);
  }, [navRoute]);

  // -------------------------------------------------------------------------
  // Train route layers: multi-colored polylines, station dots, transfer markers
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const LAYERS = [
      "train-route-lines-layer",
      "train-route-stops-layer",
      "train-route-transfers-inner",
      "train-route-transfers-outer",
    ] as const;
    const SOURCES = [
      "train-route-lines",
      "train-route-stops",
      "train-route-transfers",
    ] as const;

    const apply = () => {
      if (!navTrainDrawData) {
        // Remove all layers and sources when no train data
        for (const l of LAYERS) if (map.getLayer(l)) map.removeLayer(l);
        for (const s of SOURCES) if (map.getSource(s)) map.removeSource(s);
        return;
      }

      const { polylines, stops, transfers } = navTrainDrawData;
      const transferIds = new Set(transfers.map((t) => t.at.id));

      // Line polylines — one color per train line segment
      const linesFC: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: polylines.map((pl) => ({
          type: "Feature" as const,
          properties: { color: pl.color },
          geometry: { type: "LineString" as const, coordinates: pl.coords },
        })),
      };
      if (map.getSource("train-route-lines")) {
        (map.getSource("train-route-lines") as maplibregl.GeoJSONSource).setData(linesFC);
      } else if (polylines.length > 0) {
        map.addSource("train-route-lines", { type: "geojson", data: linesFC });
        map.addLayer({
          id: "train-route-lines-layer",
          type: "line",
          source: "train-route-lines",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": 5,
            "line-opacity": 0.9,
          },
        });
      }

      // Station stop dots (exclude transfer stations — they get distinct markers)
      const stopFeatures = stops
        .filter((s) => !transferIds.has(s.id))
        .map((s) => ({
          type: "Feature" as const,
          properties: { name: s.name },
          geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        }));
      const stopsFC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: stopFeatures };
      if (map.getSource("train-route-stops")) {
        (map.getSource("train-route-stops") as maplibregl.GeoJSONSource).setData(stopsFC);
      } else if (stopFeatures.length > 0) {
        map.addSource("train-route-stops", { type: "geojson", data: stopsFC });
        map.addLayer({
          id: "train-route-stops-layer",
          type: "circle",
          source: "train-route-stops",
          paint: {
            "circle-radius": 6,
            "circle-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#555555",
          },
        });
      }

      // Transfer / interchange markers (larger double-ring)
      const transfersFC: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: transfers.map((t) => ({
          type: "Feature" as const,
          properties: { fromLine: t.fromLine, toLine: t.toLine },
          geometry: { type: "Point" as const, coordinates: [t.at.lon, t.at.lat] },
        })),
      };
      if (map.getSource("train-route-transfers")) {
        (map.getSource("train-route-transfers") as maplibregl.GeoJSONSource).setData(transfersFC);
      } else if (transfers.length > 0) {
        map.addSource("train-route-transfers", { type: "geojson", data: transfersFC });
        map.addLayer({
          id: "train-route-transfers-outer",
          type: "circle",
          source: "train-route-transfers",
          paint: {
            "circle-radius": 12,
            "circle-color": "#ffffff",
            "circle-stroke-width": 3,
            "circle-stroke-color": "#333333",
          },
        });
        map.addLayer({
          id: "train-route-transfers-inner",
          type: "circle",
          source: "train-route-transfers",
          paint: {
            "circle-radius": 5,
            "circle-color": "#333333",
          },
        });
      }

      bringNavOverlaysToFront(map);
    };

    if (map.isStyleLoaded()) {
      apply();
    } else {
      // `load` fires once, when the map first comes up — long before any route
      // exists. Waiting on it here means waiting for an event that has already
      // happened, so the train layers were never added at all. `styledata`
      // recurs, which is why the MRT connector below has always worked.
      map.once("styledata", apply);
      return () => { map.off("styledata", apply); };
    }
  }, [navTrainDrawData]);

  // -------------------------------------------------------------------------
  // MRT entrance pins (DOM markers) + dotted connector (GeoJSON layer)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove previous markers and connector
    markerBoardRef.current?.remove();  markerBoardRef.current = null;
    markerAlightRef.current?.remove(); markerAlightRef.current = null;
    if (map.getLayer("mrt-entrance-connector-line")) map.removeLayer("mrt-entrance-connector-line");
    if (map.getSource("mrt-entrance-connector"))     map.removeSource("mrt-entrance-connector");

    if (!navMrtEntrances) return;

    const makeMEl = () => {
      const el = document.createElement("div");
      el.style.cssText = [
        "width:26px", "height:26px", "border-radius:50%",
        "background:#ffffff", "border:3px solid #3b82f6",
        "box-shadow:0 0 0 5px rgba(59,130,246,0.25)",
        "display:flex", "align-items:center", "justify-content:center",
        "font-size:11px", "font-weight:700", "color:#1d4ed8",
        "font-family:sans-serif", "cursor:default",
      ].join(";");
      el.textContent = "M";
      return el;
    };

    markerBoardRef.current = new maplibregl.Marker({ element: makeMEl(), anchor: "center" })
      .setLngLat(navMrtEntrances[0])
      .addTo(map);
    markerAlightRef.current = new maplibregl.Marker({ element: makeMEl(), anchor: "center" })
      .setLngLat(navMrtEntrances[1])
      .addTo(map);

    // Dotted door-to-train links — only add once style is loaded (decorative, not critical)
    const connectors = navTrainDrawData ? stationConnectors(navMrtEntrances, navTrainDrawData) : [];
    const addConnector = () => {
      if (map.getLayer("mrt-entrance-connector-line")) map.removeLayer("mrt-entrance-connector-line");
      if (map.getSource("mrt-entrance-connector"))     map.removeSource("mrt-entrance-connector");
      map.addSource("mrt-entrance-connector", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: connectors.map((coordinates) => ({
            type: "Feature", properties: {}, geometry: { type: "LineString", coordinates },
          })),
        },
      });
      map.addLayer({
        id: "mrt-entrance-connector-line",
        type: "line",
        source: "mrt-entrance-connector",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#3b82f6", "line-width": 2.5, "line-dasharray": [0, 3], "line-opacity": 0.8 },
      });

      bringNavOverlaysToFront(map);
    };

    if (map.isStyleLoaded()) {
      addConnector();
    } else {
      map.once("styledata", addConnector);
    }
  }, [navMrtEntrances, navTrainDrawData]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className={`w-full h-full${mapClickActive ? ' cursor-crosshair' : ''}`} />
      <SunCompass sunViz={sunViz} showSunLines={showSunLines} />
      <CanopyLegend state={canopyLegend} />
      {SHADOW_V2_DEBUG && <ShadowV2DebugPanel generation={debugGeneration} accounting={debugAccounting} cacheSource={debugCacheSource} />}
    </div>
  );
}
