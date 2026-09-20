import type maplibregl from 'maplibre-gl';
import SunCalc from 'suncalc';
import type { BuildingShadowMask, IShadowLayer } from './IShadowLayer';
import {
  type CacheAnchor,
  coversPoint,
  shouldRebuildCache,
} from '../shadowField/cachePolicy';
import {
  type BuildingPrism,
  type PrismMesh,
  appendPrismMesh,
  buildShadowTriangles,
  metersPerDegree,
  prismsFromTileFeatures,
  triangulateRing,
} from '../shadowField/geometry';
import { buildShadowIndex } from '../shadowField/shadowIndex';
import SunWorker from '../../workers/sunPosition.worker?worker';
import {
  ceilingFieldScale,
  normalizedCeilingLift,
  normalizedShadowHeightBias,
} from './heightField';

import { directionForWindReport } from '../rain/direction';
import { rainOpacityForLightOpacity } from '../rain/opacity';
import { canopyShadowTriangles } from '../rain/canopyCast';

// Shadow-edge antialiasing via supersampling: the shadow FBO is rendered at
// SHADOW_SUPERSAMPLE× the canvas resolution, then box-downsampled by the LINEAR
// composite quad (Pass D). 2 = 4 samples/pixel. Cost is ~4× shadow fragment work
// and FBO memory, so the supersampled dimension is capped at SHADOW_FBO_MAX_DIM
// (per-axis) to avoid blowing past GPU limits / memory on hi-DPR displays.
const SHADOW_SUPERSAMPLE = 2;
const SHADOW_FBO_MAX_DIM = 4096;

/**
 * Metres spanned by one full unit of Mercator x/y at the equator — MapLibre's
 * `EARTH_CIRCUMFERENCE`. A custom layer's `mainMatrix` takes x and y in [0,1]
 * Mercator and z in the same units, so a height in metres is divided by this
 * (times cos(latitude)) before it reaches the vertex shader.
 */
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/**
 * How far off the wall the building pass samples the shadow-ceiling field.
 *
 * A prism's ground shadow starts at its own sun-facing wall and its swept quads
 * run back across its own footprint, so sampling the field directly under a wall
 * fragment reports that every wall of every building is inside its own shadow.
 * The sample is therefore nudged out of the caster before it is taken: toward the
 * sun, which clears the swept quads, and along the wall's outward normal, which
 * clears the footprint even on a wall that runs nearly parallel to the sun. That
 * second step is what stops such a wall from dithering along the edge of its own
 * shadow. Both are small enough to barely move within a *neighbour's* shadow.
 *
 * Nudging toward the sun means nudging closer to every caster, so the field reads a
 * *higher* ceiling there — by exactly the sunward part of the step times tan(alt),
 * since within any caster's shadow the ceiling falls at that slope and the per-pixel
 * MAX preserves it. The wall pass therefore raises its own threshold by the same
 * amount (`normalizedCeilingLift`, uploaded as `u_ceilLift`), which makes the nudge
 * geometrically free: the wall's terminator lands where the ground shadow at its
 * base says it should, while the sample still escapes the near cap. Left
 * uncompensated, the raised ceiling meets an unraised threshold and every wall
 * shadows 1–2 m too high — which is what made a shadow step as it crossed onto a wall.
 */
const WALL_SHADOW_SUN_OFFSET_M = 1.5;
const WALL_SHADOW_NORMAL_OFFSET_M = 1.5;

/** Light grey the extruded buildings are painted before any shading. */
const BUILDING_RGB: [number, number, number] = [0.87, 0.87, 0.88];

interface ShadowGeometry {
  shadowVerts: Float32Array;    // Mercator (x,y) shadow triangles
  /**
   * Per-vertex *shadow ceiling*, normalized by `maxH`: the highest point the
   * caster still shadows at that spot — its own height under its roofline,
   * falling to 0 at the shadow's tip. Interpolated across a triangle this is
   * exact (see `buildShadowTriangles`), which is what lets Pass C decide a roof
   * and Pass E decide a wall fragment with one screen-space texture.
   */
  shadowHeights: Float32Array;
  roofVerts: Float32Array;      // Mercator (x,y) building footprint triangles (un-offset)
  roofHeights: Float32Array;    // normalized height per roof vertex (h/maxH)
  sunBelowHorizon: boolean;
}

interface CachedBuildingGeometry {
  /** One entry per prism ring, ordered shortest building first (see `prismsFromTileFeatures`). */
  buildings: Array<{
    prism: BuildingPrism;
    normalizedH: number;
    /** Roof footprint, pre-triangulated and pre-offset to `centerMerc`. */
    mercatorRoofVerts: Float32Array;
  }>;
  maxH: number;
  centerMerc: [number, number];
  /** What this cache was built for — see `shouldRebuildCache`. */
  anchor: CacheAnchor;
  /**
   * The walls and roofs the 3D pass draws: `bldgPos` is Mercator x/y offset to
   * `centerMerc`, `bldgHeightM` the vertex's height above ground in metres, and
   * `bldgNormal` its outward normal in the same Mercator frame (roofs point up).
   * Built from the very prisms that cast the shadows, so a building and its
   * shadow can never disagree about height or footprint.
   */
  bldgPos: Float32Array;
  bldgHeightM: Float32Array;
  bldgNormal: Float32Array;
  bldgVertexCount: number;
}

/**
 * Local shadow renderer implemented as a MapLibre CustomLayer.
 *
 * This fixes the structural pan/zoom lag that occurred when we projected GeoJSON
 * into a separate 2D overlay canvas. By drawing inside MapLibre's WebGL render
 * loop with the provided camera matrix, the shadow geometry is rendered in the
 * exact same frame as tiles and other vector layers.
 */
export class LocalShadowAdapter implements IShadowLayer, maplibregl.CustomLayerInterface {
  /** MapLibre style layer id */
  id = 'local-shadow-layer';
  type: 'custom' = 'custom';
  /**
   * `'3d'` because Pass E draws depth-tested extrusions, and because MapLibre reads
   * this to place its opaque-pass cutoff: layers above the first 3D layer render
   * with depth testing off, which is what keeps the route line drawn over a
   * building instead of buried inside one.
   */
  renderingMode: '3d' = '3d';

  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  private currentDate: Date;
  private listeners: Map<string, Set<() => void>> = new Map();

  // WebGL resources
  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private a_pos = -1;
  private u_matrix: WebGLUniformLocation | null = null;
  private u_color: WebGLUniformLocation | null = null;

  // Geometry cache
  private vertexCount = 0;
  private dirty = true;
  private cachedGeometry: ShadowGeometry = {
    shadowVerts: new Float32Array(),
    shadowHeights: new Float32Array(),
    roofVerts: new Float32Array(),
    roofHeights: new Float32Array(),
    sunBelowHorizon: false,
  };

  // Phase 2: Building geometry cache — invalidated on sourcedata/moveend/zoomend
  private buildingCache: CachedBuildingGeometry | null = null;

  // Phase 3: Buffer upload versioning — skip re-upload when geometry unchanged
  private geomVersion = 0;
  private lastUploadedVersion = -1;

  // Phase 1 + 4: Sun position tracking
  private lastSunAzDeg: number | null = null;
  private lastSunAltDeg: number | null = null;
  private lastSunAzRad: number | null = null;
  private lastSunAltRad: number | null = null;
/** True (default) draws the sun rendering; false turns the canvas into a no-op. */
  private visuallyEnabled = true;

  private sunWorker: Worker | null = null;

  // Offscreen FBO for single-write shadow compositing
  private fbo: WebGLFramebuffer | null = null;
  private fboTexture: WebGLTexture | null = null;
  private fboWidth = 0;
  private fboHeight = 0;

  // Height pass (Pass B): renders the normalized shadow ceiling into a depth texture
  private heightProgram: WebGLProgram | null = null;
  private heightAttrPos = -1;
  private heightAttrH = -1;
  private heightUMatrix: WebGLUniformLocation | null = null;
  private heightUFieldScale: WebGLUniformLocation | null = null;
  private shadowHeightBuffer: WebGLBuffer | null = null;
  private heightFbo: WebGLFramebuffer | null = null;
  private heightFboTexture: WebGLTexture | null = null;

  // Roof exclusion pass (Pass C): erases self-shadow from roof footprints
  private roofProgram: WebGLProgram | null = null;
  private roofAttrPos = -1;
  private roofAttrH = -1;
  private roofUMatrix: WebGLUniformLocation | null = null;
  private roofUHeightTex: WebGLUniformLocation | null = null;
  private roofUFieldScale: WebGLUniformLocation | null = null;
  private roofUBias: WebGLUniformLocation | null = null;
  private roofPosBuffer: WebGLBuffer | null = null;
  private roofHeightBuffer: WebGLBuffer | null = null;

  // Building pass (Pass E): extruded walls + roofs, shadowed by the height field
  private bldgProgram: WebGLProgram | null = null;
  private bldgAttrPos = -1;
  private bldgAttrHeight = -1;
  private bldgAttrNormal = -1;
  private bldgUniforms: Record<string, WebGLUniformLocation | null> = {};
  private bldgPosBuffer: WebGLBuffer | null = null;
  private bldgHeightBuffer: WebGLBuffer | null = null;
  private bldgNormalBuffer: WebGLBuffer | null = null;
  /** Bumped whenever `buildingCache` is replaced, so Pass E re-uploads only then. */
  private cacheVersion = 0;
  private lastUploadedCacheVersion = -1;

  // Full-screen quad for compositing FBO texture
  private quadProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private quadAttrLoc = -1;
  private quadTexLoc: WebGLUniformLocation | null = null;
  private quadInvertLoc: WebGLUniformLocation | null = null;
  private quadAlphaScaleLoc: WebGLUniformLocation | null = null;

  // Canopy pass: the painter's only fractional casters (rain mode).
  private canopyProgram: WebGLProgram | null = null;
  private canopyAttrPos = -1;
  private canopyAttrOpacity = -1;
  private canopyUMatrix: WebGLUniformLocation | null = null;
  private canopyUColor: WebGLUniformLocation | null = null;
  private canopyPosBuffer: WebGLBuffer | null = null;
  private canopyOpacityBuffer: WebGLBuffer | null = null;
  private canopyPrisms: BuildingPrism[] = [];
  private canopyGeometry: { verts: Float32Array; opacity: Float32Array } | null = null;
  private canopyUploadedVersion = -1;
  private canopyVersion = 0;

  private hazardMode: "sun" | "rain" = "sun";
  /** Rain ray direction (radians), fed by `setRainWind`; null = windless vertical. */
  private lastRainAzRad: number | null = null;
  private lastRainAltRad: number | null = null;

  /**
   * Discard the building cache only if the camera has actually invalidated it.
   *
   * Rebuilding is the most expensive routine here, and all three map events below
   * used to force one unconditionally — so a single pan paid for two (the source
   * settles *and* the move ends), and a follow camera paid on every settle. The
   * policy in `../shadowField/cachePolicy` decides; this just applies it.
   *
   * Always repaints regardless: the sun may have moved even when the geometry
   * has not.
   */
  private invalidateIfStale() {
    const map = this.map;
    if (!map) return;
    const center = map.getCenter();
    const stale = shouldRebuildCache(this.buildingCache?.anchor ?? null, {
      centerLng: center.lng,
      centerLat: center.lat,
      zoom: map.getZoom(),
      sourceLoaded: map.isSourceLoaded('maptiler_planet'),
    });
    if (stale) {
      this.buildingCache = null;
      this.dirty = true;
    }
    map.triggerRepaint();
  }

  // Map event handlers (bound so we can unregister)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSourceData = (e: any) => {
    // Rebuild only when all tiles for the source have finished loading,
    // not on every intermediate tile update (prevents flickering).
    if (!this.map) return;
    if (e?.sourceId === 'maptiler_planet' && this.map.isSourceLoaded('maptiler_planet')) {
      this.invalidateIfStale();
    }
  };

  private onZoomEnd = () => {
    this.invalidateIfStale();
  };

  private onMoveEnd = () => {
    // Deliberately does not reset the cached sun position. Sun azimuth is a function
    // of location, but it does not meaningfully change over the distance a pan
    // covers, and `setDate`'s own 0.15-degree check already forces a recompute when
    // it does. Clearing it here forced a full solar recompute on every camera settle.
    this.invalidateIfStale();
  };

  // MapLibre expects premultiplied alpha for custom layers by default.
  // Shadow color interpolates from BASE_RGB (night/sunrise/sunset) to NOON_RGB (12:00 noon)
  // based on current sun altitude relative to its altitude at 12:00.
  private static readonly SHADOW_ALPHA = 0.7;
  // IMPORTANT: shadows MUST stay blue-dominant at every sun altitude — shadow
  // routing detects them by blue dominance (app/lib/shadowSampling.ts). A neutral
  // gray shadow is invisible to the sampler (r≈g≈b → 0% coverage, single route).
  // So BOTH endpoints below are blue. NOON is a lighter blue for midday
  // visibility, not gray. (CLAUDE.md invariant #5: change one → change both.)
  private static readonly BASE_RGB: [number, number, number] = [1 / 255, 17 / 255, 47 / 255]; // #01112f
  private static readonly NOON_RGB: [number, number, number] = [0x22 / 255, 0x46 / 255, 0x7f / 255]; // #22467f (lighter blue)

  // Rain inversion makes the covered FBO read as *exposed*: the channel the
  // composite inverts carries coverage, and the wet tint is premultiplied by the
  // same constant so the existing ONE / ONE_MINUS_SRC_ALPHA blending stays exact.
  private static readonly RAIN_WET_RGB: [number, number, number] = [0x25 / 255, 0x63 / 255, 0xeb / 255]; // #2563eb
  private static readonly RAIN_WET_ALPHA = 0.5;

  constructor(opts?: { date?: Date; id?: string }) {
    this.currentDate = opts?.date ?? new Date();
    if (opts?.id) this.id = opts.id;

    // Phase 4: Spawn sun position worker
    try {
      this.sunWorker = new SunWorker();
      this.sunWorker.onmessage = (e: MessageEvent<{
        azimuthDeg: number; altitudeDeg: number;
        azimuthRad: number; altitudeRad: number;
      }>) => {
        const { azimuthDeg, altitudeDeg, azimuthRad, altitudeRad } = e.data;
        // Phase 1: sun angle dirty check
        if (this.lastSunAzDeg != null && this.lastSunAltDeg != null
            && Math.abs(azimuthDeg - this.lastSunAzDeg) < 0.15
            && Math.abs(altitudeDeg - this.lastSunAltDeg) < 0.15) {
          return; // sun barely moved
        }
        this.lastSunAzDeg = azimuthDeg;
        this.lastSunAltDeg = altitudeDeg;
        this.lastSunAzRad = azimuthRad;
        this.lastSunAltRad = altitudeRad;
        this.dirty = true;
        this.map?.triggerRepaint();
      };
    } catch {
      // Worker unavailable (e.g. SSR) — will fall back to sync computation
      this.sunWorker = null;
    }
  }

  // ─── IShadowLayer ──────────────────────────────────────────────────────────

  setDate(date: Date) {
    this.currentDate = date;

    // Rain does not read the ephemeris; scrubbing the timeline must not spin the
    // sun worker (and its dirty check) just to compute a direction nothing draws.
    if (this.hazardMode === "rain") return;

    if (this.map && this.sunWorker) {
      // Phase 4: Delegate sun computation to worker — dirty check happens in onmessage
      const center = this.map.getCenter();
      this.sunWorker.postMessage({ lat: center.lat, lon: center.lng, timestamp: date.getTime() });
      return;
    }

    // Fallback: synchronous sun dirty check (Phase 1)
    if (this.map) {
      const center = this.map.getCenter();
      const sun = SunCalc.getPosition(date, center.lat, center.lng);
      const azDeg = sun.azimuth * 180 / Math.PI;
      const altDeg = sun.altitude * 180 / Math.PI;
      if (this.lastSunAzDeg != null && this.lastSunAltDeg != null
          && Math.abs(azDeg - this.lastSunAzDeg) < 0.15
          && Math.abs(altDeg - this.lastSunAltDeg) < 0.15) {
        return; // sun barely moved
      }
    }

    this.dirty = true;
    this.map?.triggerRepaint();
  }

  resize() {
    // FBO will be resized lazily in ensureFBO() on next render.
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setHazard(hazard: "sun" | "rain") {
    if (hazard === this.hazardMode) return;
    this.hazardMode = hazard;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setCanopyPrisms(prisms: BuildingPrism[]) {
    this.canopyPrisms = prisms;
    this.canopyGeometry = null;
    this.canopyVersion++;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setRainWind(dirDeg: number | null, windMs: number | null) {
    const direction = directionForWindReport(dirDeg, windMs);
    const azRad = ((direction.fromDeg + 180) % 360) * Math.PI / 180;
    const altRad = direction.altitudeDeg * Math.PI / 180;
    if (
      this.lastRainAzRad != null && this.lastRainAltRad != null &&
      Math.abs(azRad - this.lastRainAzRad) < 0.004 &&
      Math.abs(altRad - this.lastRainAltRad) < 0.004
    ) {
      return; // the wind did not meaningfully move
    }
    this.lastRainAzRad = azRad;
    this.lastRainAltRad = altRad;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  /**
   * The direction the canvas extrudes toward: SunCalc for the sun, the wind-fed
   * reverse-rain ray otherwise. Sun values fall back to a synchronous compute;
   * rain without a wind report is the vertical windless limit (azimuth rotates
   * by 180°, per the lee/windward convention pinned in the rain tests).
   */
  private hazardDirection(): { azimuthRad: number; altitudeRad: number; sunBelow: boolean } {
    if (this.hazardMode === "rain") {
      const altRad = this.lastRainAltRad ?? (89.5 * Math.PI) / 180;
      return { azimuthRad: this.lastRainAzRad ?? Math.PI, altitudeRad: altRad, sunBelow: false };
    }
    let azRad = this.lastSunAzRad;
    let altRad = this.lastSunAltRad;
    if (azRad == null || altRad == null) {
      const center = this.map?.getCenter() ?? { lat: 0, lng: 0 };
      const sun = SunCalc.getPosition(this.currentDate, center.lat, center.lng);
      azRad = sun.azimuth;
      altRad = sun.altitude;
    }
    return { azimuthRad: azRad, altitudeRad: altRad, sunBelow: altRad <= 0 };
  }

  remove() {
    // Remove this style layer; MapLibre will call onRemove for WebGL cleanup.
    if (!this.map) return;
    if (this.map.getLayer(this.id)) {
      try {
        this.map.removeLayer(this.id);
      } catch {
        // ignore transient style-update errors
      }
    }
  }

  setSunExposure(_enabled: boolean, _opts?: { startDate: Date; endDate: Date; iterations: number }) {
    // Accumulation mode not supported in local renderer — no-op
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.visuallyEnabled) return;
    this.visuallyEnabled = enabled;
    // The geometry cache it comes back to may be stale — a disabled layer never
    // saw the tiles or moves that happened while it was off.
    if (enabled) {
      this.buildingCache = null;
      this.dirty = true;
    }
    this.map?.triggerRepaint();
  }

  on(event: string, callback: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }

  readBuildingShadowMask(): BuildingShadowMask | null {
    const gl = this.gl as WebGL2RenderingContext | null;
    if (!gl || !this.fbo || this.fboWidth <= 0 || this.fboHeight <= 0) return null;

    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const rgba = new Uint8Array(this.fboWidth * this.fboHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, this.fboWidth, this.fboHeight, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);

    // WebGL readback is bottom-left origin; map.project and ImageData are top-left.
    // Normalize the renderer's visual alpha back to physical building coverage.
    const data = new Uint8Array(this.fboWidth * this.fboHeight);
    const alphaScale = 1 / LocalShadowAdapter.SHADOW_ALPHA;
    for (let y = 0; y < this.fboHeight; y++) {
      const sourceRow = this.fboHeight - 1 - y;
      for (let x = 0; x < this.fboWidth; x++) {
        const alpha = rgba[(sourceRow * this.fboWidth + x) * 4 + 3];
        data[y * this.fboWidth + x] = Math.min(255, Math.round(alpha * alphaScale));
      }
    }
    const canvas = this.map?.getCanvas();
    const cssWidth = canvas?.clientWidth || canvas?.width || this.fboWidth;
    const cssHeight = canvas?.clientHeight || canvas?.height || this.fboHeight;
    return {
      data,
      width: this.fboWidth,
      height: this.fboHeight,
      pixelRatioX: this.fboWidth / cssWidth,
      pixelRatioY: this.fboHeight / cssHeight,
    };
  }

  queryPointShadow(lng: number, lat: number, opts?: { date?: Date }) {
    if (!this.map) return null;
    if (!this.map.getBounds().contains([lng, lat])) return null;

    if (!this.buildingCache) {
      this.buildingCache = this.buildBuildingGeometryCache();
      this.cacheVersion++;
      this.dirty = true;
    }
    // The cache is now allowed to lag the viewport, so being inside the *viewport*
    // no longer means the cache holds buildings for this point. Answering from a
    // cache that never covered it would report open sun for ground we never looked
    // at — a confident wrong number, which is worse than a slow one. Rebuild for
    // the current camera and re-check rather than guess.
    if (!coversPoint(this.buildingCache.anchor, lng, lat)) {
      this.buildingCache = this.buildBuildingGeometryCache();
      this.cacheVersion++;
      // The extruded shadows — and Pass E's `maxH` normalization — came from the
      // cache just replaced. Without this the next frame draws a mesh scaled by the
      // new `maxH` against a height texture built with the old one.
      this.dirty = true;
      if (!coversPoint(this.buildingCache.anchor, lng, lat)) return null;
    }
    const cache = this.buildingCache;
    if (!cache) return null;

    const queryDate = opts?.date ?? this.currentDate;
    const sun = SunCalc.getPosition(queryDate, lat, lng);
    if (sun.altitude <= 0) {
      return { shadowFraction: 1, source: "geometry-cache" as const };
    }

    const { mPerLat, mPerLng } = metersPerDegree(lat);
    const prisms = cache.buildings.map(b => b.prism);
    const offsetsM: Array<[number, number]> = [
      [0, 0],
      [-4, 0],
      [4, 0],
      [0, -4],
      [0, 4],
    ];

    // One build for all five offsets. They already shared this sun and this projection
    // frame, so these are the same shadows the per-query path rebuilt five times over.
    const shadows = buildShadowIndex(prisms, sun.azimuth, sun.altitude, mPerLat, mPerLng, null);

    let shadowed = 0;
    for (const [dxM, dyM] of offsetsM) {
      const sampleLng = lng + dxM / mPerLng;
      const sampleLat = lat + dyM / mPerLat;
      if (shadows.isShadowed(sampleLng, sampleLat)) {
        shadowed++;
      }
    }

    return { shadowFraction: shadowed / offsetsM.length, source: "geometry-cache" as const };
  }

  // ─── CustomLayerInterface ──────────────────────────────────────────────────

  onAdd(map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    this.map = map;
    this.gl = gl;

    // Keep geometry cache in sync with streaming vector tiles.
    map.on('sourcedata', this.onSourceData);
    map.on('zoomend', this.onZoomEnd);
    map.on('moveend', this.onMoveEnd);

    // Compile minimal shader program
    const vsSrc = `
      attribute vec2 a_pos;
      uniform mat4 u_matrix;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
      }
    `;
    const fsSrc = `
      precision mediump float;
      uniform vec4 u_color;
      void main() {
        gl_FragColor = u_color;
      }
    `;

    this.program = createProgram(gl, vsSrc, fsSrc);
    this.positionBuffer = gl.createBuffer();
    this.a_pos = gl.getAttribLocation(this.program, 'a_pos');
    this.u_matrix = gl.getUniformLocation(this.program, 'u_matrix');
    this.u_color = gl.getUniformLocation(this.program, 'u_color');

    // Compile height shader (Pass B): writes the normalized ceiling as fragment depth.
    // `#version` has to be the first thing in the source — not every driver tolerates
    // the leading newline a normally-indented template literal would put in front of it.
    const heightVsSrc = `#version 300 es
      in vec2 a_pos;
      in float a_height;
      uniform mat4 u_matrix;
      uniform float u_fieldScale;
      out highp float v_height;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        // Zoom the field out far enough to hold the footprints of the buildings
        // Pass E draws, which under a tilted camera reach past the viewport.
        gl_Position.xy /= u_fieldScale;
        v_height = a_height;
      }
    `;
    const heightFsSrc = `#version 300 es
      precision highp float;
      in highp float v_height;
      void main() {
        gl_FragDepth = v_height;
      }
    `;
    this.heightProgram = createProgram(gl, heightVsSrc, heightFsSrc);
    this.heightAttrPos = gl.getAttribLocation(this.heightProgram, 'a_pos');
    this.heightAttrH = gl.getAttribLocation(this.heightProgram, 'a_height');
    this.heightUMatrix = gl.getUniformLocation(this.heightProgram, 'u_matrix');
    this.heightUFieldScale = gl.getUniformLocation(this.heightProgram, 'u_fieldScale');
    this.shadowHeightBuffer = gl.createBuffer();

    // Compile roof exclusion shader (Pass C): conditionally erases self-shadow
    const roofVsSrc = `
      attribute vec2 a_pos;
      attribute float a_height;
      uniform mat4 u_matrix;
      uniform float u_fieldScale;
      varying float v_height;
      varying vec4 v_fieldClip;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        // This pass erases from the screen-aligned shadow FBO but reads the widened
        // ceiling field, so the two positions are no longer the same pixel.
        v_fieldClip = gl_Position;
        v_fieldClip.xy /= u_fieldScale;
        v_height = a_height;
      }
    `;
    const roofFsSrc = `
      precision highp float;
      uniform sampler2D u_heightTex;
      uniform float u_bias;
      varying float v_height;
      varying vec4 v_fieldClip;
      void main() {
        vec2 uv = (v_fieldClip.xy / v_fieldClip.w) * 0.5 + 0.5;
        float maxIncoming = texture2D(u_heightTex, uv).r;
        if (maxIncoming <= v_height + u_bias) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
          discard;
        }
      }
    `;
    this.roofProgram = createProgram(gl, roofVsSrc, roofFsSrc);
    this.roofAttrPos = gl.getAttribLocation(this.roofProgram, 'a_pos');
    this.roofAttrH = gl.getAttribLocation(this.roofProgram, 'a_height');
    this.roofUMatrix = gl.getUniformLocation(this.roofProgram, 'u_matrix');
    this.roofUHeightTex = gl.getUniformLocation(this.roofProgram, 'u_heightTex');
    this.roofUFieldScale = gl.getUniformLocation(this.roofProgram, 'u_fieldScale');
    this.roofUBias = gl.getUniformLocation(this.roofProgram, 'u_bias');
    this.roofPosBuffer = gl.createBuffer();
    this.roofHeightBuffer = gl.createBuffer();

    // Compile building shader (Pass E): extruded walls + roofs, lit by the sun and
    // painted with the same shadow field the ground uses.
    //
    // `v_groundClip` is the vertex's *ground* position (height 0), stepped toward the
    // sun, run through the same matrix. Dividing it by w per fragment gives the pixel
    // the height FBO stored that column's shadow ceiling at, which is what makes a
    // wall halfway up a building shadowed by its neighbour but lit above the roofline.
    const bldgVsSrc = `
      attribute vec2 a_pos;
      attribute float a_heightM;
      attribute vec3 a_normal;
      uniform mat4 u_matrix;
      varying vec3 v_normal;
      uniform float u_mercZPerMeter;
      uniform float u_maxH;
      uniform vec2 u_sunOffset;
      uniform float u_normalOffset;
      uniform vec3 u_sunDir;
      uniform vec2 u_sunFlat;
      uniform vec2 u_ceilLift;
      uniform float u_fieldScale;
      varying float v_hNorm;
      varying float v_ceilLift;
      varying float v_facing;
      varying vec4 v_groundClip;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, a_heightM * u_mercZPerMeter, 1.0);
        float isWall = 1.0 - step(0.5, a_normal.z);
        vec2 sampleXY = a_pos
                      + isWall * (u_sunOffset + a_normal.xy * u_normalOffset);
        // The sample sits closer to every caster, so the ceiling it reads is higher
        // by the sunward part of that step times tan(alt). Raise the threshold to
        // match, and the nudge costs nothing: x is the sun step's share, y the
        // normal step's, projected onto the sun. Roofs take isWall = 0 and no lift.
        v_ceilLift = isWall * (u_ceilLift.x + u_ceilLift.y * dot(a_normal.xy, u_sunFlat));
        v_groundClip = u_matrix * vec4(sampleXY, 0.0, 1.0);
        // The field was rasterized zoomed out by this much, so index it the same way.
        // Without it a fragment whose footprint falls outside the viewport — every
        // near, tall building under a tilted camera — reads no ceiling and renders lit.
        v_groundClip.xy /= u_fieldScale;
        v_hNorm = a_heightM / u_maxH;
        v_facing = dot(a_normal, u_sunDir);
        v_normal = a_normal;
      }
    `;
    const bldgFsSrc = `
      precision highp float;
      uniform sampler2D u_heightTex;
      uniform vec3 u_wallColor;
      uniform vec3 u_shadowTint;
      uniform float u_sunBelow;
      uniform float u_bias;
      uniform vec2 u_sunFlat;
      varying float v_hNorm;
      varying float v_ceilLift;
      varying float v_facing;
      varying vec4 v_groundClip;
      varying vec3 v_normal;
      const float AMBIENT = 0.62;
      // Sky light a face still receives with the sun off it. A roof sees the whole
      // sky, a wall about half, and a face turned toward the sun's side of the sky
      // sees more than one turned away.
      //
      // Without this every shadowed surface takes one flat colour, and — because that
      // colour landed within a few percent of the street shadow it stands in — a
      // tilted view looking *away* from the sun showed rooftops floating on blue
      // with no walls under them. The three shadowed tones below sit above the
      // measured ground shadow (#516990) and below the lit ones, so the surfaces
      // read apart by brightness while all of them stay blue enough to read as shadow.
      const float SKY_BASE = 0.80;
      const float SKY_UP = 0.20;
      const float SKY_SUNWARD = 0.14;
      const float SHADOW_TINT = 0.46;
      void main() {
        vec2 uv = (v_groundClip.xy / v_groundClip.w) * 0.5 + 0.5;
        float onScreen = step(0.0, uv.x) * step(uv.x, 1.0)
                       * step(0.0, uv.y) * step(uv.y, 1.0)
                       * step(0.0001, v_groundClip.w);
        float ceilN = texture2D(u_heightTex, uv).r * onScreen;
        // Turned away from the sun, or something taller shadows this height.
        float shadowed = max(step(v_facing, 0.0),
                           step(v_hNorm + v_ceilLift + u_bias, ceilN));
        shadowed = max(shadowed, u_sunBelow);
        float sky = SKY_BASE
                  + SKY_UP * v_normal.z
                  + SKY_SUNWARD * max(dot(v_normal.xy, u_sunFlat), 0.0);
        vec3 lit = u_wallColor * (AMBIENT + (1.0 - AMBIENT) * max(v_facing, 0.0));
        vec3 dark = mix(u_wallColor * sky, u_shadowTint, SHADOW_TINT);
        gl_FragColor = vec4(mix(lit, dark, shadowed), 1.0);
      }
    `;
    this.bldgProgram = createProgram(gl, bldgVsSrc, bldgFsSrc);
    this.bldgAttrPos = gl.getAttribLocation(this.bldgProgram, 'a_pos');
    this.bldgAttrHeight = gl.getAttribLocation(this.bldgProgram, 'a_heightM');
    this.bldgAttrNormal = gl.getAttribLocation(this.bldgProgram, 'a_normal');
    for (const name of [
      'u_matrix', 'u_mercZPerMeter', 'u_maxH', 'u_sunOffset', 'u_normalOffset',
      'u_sunDir',
      'u_heightTex', 'u_wallColor', 'u_shadowTint', 'u_sunFlat',
      'u_sunBelow', 'u_bias', 'u_ceilLift', 'u_fieldScale',
    ]) {
      this.bldgUniforms[name] = gl.getUniformLocation(this.bldgProgram, name);
    }
    this.bldgPosBuffer = gl.createBuffer();
    this.bldgHeightBuffer = gl.createBuffer();
    this.bldgNormalBuffer = gl.createBuffer();

    // Compile canopy shader (rain fraction pass): same color seed as Pass A,
    // per-vertex coverage value written into alpha under MAX blending.
    const canopyVsSrc = `
      attribute vec2 a_pos;
      attribute float a_opacity;
      uniform mat4 u_matrix;
      varying float v_opacity;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_opacity = a_opacity;
      }
    `;
    const canopyFsSrc = `
      precision mediump float;
      uniform vec4 u_color;
      varying float v_opacity;
      void main() {
        gl_FragColor = u_color * v_opacity;
      }
    `;
    this.canopyProgram = createProgram(gl, canopyVsSrc, canopyFsSrc);
    this.canopyAttrPos = gl.getAttribLocation(this.canopyProgram, 'a_pos');
    this.canopyAttrOpacity = gl.getAttribLocation(this.canopyProgram, 'a_opacity');
    this.canopyUMatrix = gl.getUniformLocation(this.canopyProgram, 'u_matrix');
    this.canopyUColor = gl.getUniformLocation(this.canopyProgram, 'u_color');
    this.canopyPosBuffer = gl.createBuffer();
    this.canopyOpacityBuffer = gl.createBuffer();

    // Compile quad shader for FBO texture compositing
    const quadVsSrc = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;
    const quadFsSrc = `
      precision mediump float;
      uniform sampler2D u_texture;
      uniform float u_invert;
      uniform float u_alphaScale;
      varying vec2 v_uv;
      void main() {
        vec4 t = texture2D(u_texture, v_uv);
        if (u_invert > 0.5) {
          // Rain: alpha carried coverage (see Pass A), so exposed = 1 - coverage.
          float exposed = max(0.0, 1.0 - t.a / u_alphaScale);
          gl_FragColor = vec4(t.rgb * exposed, t.a * exposed);
        } else {
          gl_FragColor = t;
        }
      }
    `;
    this.quadProgram = createProgram(gl, quadVsSrc, quadFsSrc);
    this.quadAttrLoc = gl.getAttribLocation(this.quadProgram, 'a_pos');
    this.quadTexLoc = gl.getUniformLocation(this.quadProgram, 'u_texture');
    this.quadInvertLoc = gl.getUniformLocation(this.quadProgram, 'u_invert');
    this.quadAlphaScaleLoc = gl.getUniformLocation(this.quadProgram, 'u_alphaScale');
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  1, 1,
      -1, -1,  1, 1,  -1, 1,
    ]), gl.STATIC_DRAW);
  }

  render(gl: WebGL2RenderingContext | WebGLRenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.map || !this.program || !this.positionBuffer || !this.u_matrix || !this.u_color) return;
    if (!this.quadProgram || !this.quadBuffer) return;
    if (!this.visuallyEnabled) return;

    const rain = this.hazardMode === "rain";
    const hazardDir = this.hazardDirection();

    // The depth ceiling texture and gl.MAX both require WebGL2 (guaranteed by MapLibre).
    const gl2 = gl as WebGL2RenderingContext;

    if (this.dirty) {
      // Phase 2: Rebuild building cache only when map view changed
      if (!this.buildingCache) {
        this.buildingCache = this.buildBuildingGeometryCache();
        this.cacheVersion++;
      }
      this.cachedGeometry = this.extrudeShadows(this.buildingCache, hazardDir, rain);
      this.canopyGeometry = rain
        ? this.buildCanopyGeometry(hazardDir.azimuthRad, hazardDir.altitudeRad)
        : null;
      this.geomVersion++;
      this.dirty = false;
      this.emit('idle');
    }

    const geo = this.cachedGeometry;
    if (geo.shadowVerts.length === 0) return;

    // FBO passes (A/B/C) render at supersampled resolution for shadow-edge AA;
    // the final composite (Pass D) draws at the real canvas viewport, box-
    // downsampling via the LINEAR-filtered fboTexture. Cap each axis so the
    // supersampled buffer can't exceed GPU/memory limits.
    const cw = gl.canvas.width;
    const ch = gl.canvas.height;
    const ssW = Math.min(cw * SHADOW_SUPERSAMPLE, SHADOW_FBO_MAX_DIM);
    const ssH = Math.min(ch * SHADOW_SUPERSAMPLE, SHADOW_FBO_MAX_DIM);
    const w = ssW;
    const h = ssH;
    this.ensureFBO(gl2, w, h);
    if (!this.fbo) return;

    // Phase 3: Only re-upload buffers when geometry actually changed
    if (this.geomVersion !== this.lastUploadedVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geo.shadowVerts, gl.DYNAMIC_DRAW);
      this.vertexCount = geo.shadowVerts.length / 2;

      if (this.shadowHeightBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowHeightBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, geo.shadowHeights, gl.DYNAMIC_DRAW);
      }
      if (this.roofPosBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.roofPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, geo.roofVerts, gl.DYNAMIC_DRAW);
      }
      if (this.roofHeightBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.roofHeightBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, geo.roofHeights, gl.DYNAMIC_DRAW);
      }
      this.lastUploadedVersion = this.geomVersion;
    }

    // ── Save GL state ──
    const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const wasBlend = gl.isEnabled(gl.BLEND);
    const wasCull = gl.isEnabled(gl.CULL_FACE);
    const prevBlendSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB);
    const prevBlendDstRGB = gl.getParameter(gl.BLEND_DST_RGB);
    const prevBlendSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA);
    const prevBlendDstA = gl.getParameter(gl.BLEND_DST_ALPHA);
    const prevBlendEqRGB = gl.getParameter(gl.BLEND_EQUATION_RGB);
    const prevBlendEqA = gl.getParameter(gl.BLEND_EQUATION_ALPHA);
    const prevActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const wasDepthTest = gl.isEnabled(gl.DEPTH_TEST);
    const prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC);
    const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
    const prevDepthClear = gl.getParameter(gl.DEPTH_CLEAR_VALUE);
    // MapLibre narrows the depth range for a '3d' custom layer to leave room for the
    // sublayers above it. `gl_FragDepth` is clamped to that range, so Pass B has to
    // widen it or every ceiling near the top of the height scale clamps to one value.
    const prevDepthRange = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;

    // Compute adjusted projection matrix in Float64 to account for center offset.
    // Vertices are stored relative to centerMerc, so we pre-multiply a translation
    // by (cx, cy) into the matrix — done in Float64 on CPU before converting to
    // Float32 for the GPU, preserving sub-pixel precision.
    const mainMat = options.defaultProjectionData.mainMatrix;
    const [cx, cy] = this.buildingCache?.centerMerc ?? [0, 0];
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = Number(mainMat[i]);
    m[12] += m[0] * cx + m[4] * cy;
    m[13] += m[1] * cx + m[5] * cy;
    m[14] += m[2] * cx + m[6] * cy;
    m[15] += m[3] * cx + m[7] * cy;
    const matrix = new Float32Array(m);
    const heightBias = normalizedShadowHeightBias(this.buildingCache?.maxH ?? 1);
    // MapLibre scales a custom layer's z by the *centre* latitude, so this follows the
    // live centre rather than the one the cache was built at — as Pass E does.
    const mercPerMeter =
      1 / (EARTH_CIRCUMFERENCE_M * Math.cos((this.map.getCenter().lat * Math.PI) / 180));
    const fieldScale = ceilingFieldScale(m, (this.buildingCache?.maxH ?? 0) * mercPerMeter);

    // MapLibre hands a '3d' custom layer a read/write depth mode. Only Pass E wants
    // it; the ground composite is a full-screen quad at NDC z = 0, and letting that
    // write depth would put a plane in front of every building we are about to draw.
    gl2.disable(gl.DEPTH_TEST);
    gl2.depthMask(false);

    // ── Pass A: Render shadows into FBO with MAX blending ──
    gl2.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl2.viewport(0, 0, w, h);
    gl2.clearColor(0, 0, 0, 0);
    gl2.clear(gl.COLOR_BUFFER_BIT);

    gl2.useProgram(this.program);
    gl2.uniformMatrix4fv(this.u_matrix, false, matrix);
    // Rain's Pass A carries *coverage* in the alpha it writes: wet tint premultiplied
    // by RAIN_WET_ALPHA, alpha = RAIN_WET_ALPHA, so the composite can invert it.
    const raw = rain
      ? [LocalShadowAdapter.RAIN_WET_RGB[0] * LocalShadowAdapter.RAIN_WET_ALPHA,
         LocalShadowAdapter.RAIN_WET_RGB[1] * LocalShadowAdapter.RAIN_WET_ALPHA,
         LocalShadowAdapter.RAIN_WET_RGB[2] * LocalShadowAdapter.RAIN_WET_ALPHA,
         LocalShadowAdapter.RAIN_WET_ALPHA] as [number, number, number, number]
      : this.computeShadowColor(geo.sunBelowHorizon);
    gl2.uniform4f(this.u_color, raw[0], raw[1], raw[2], raw[3]);

    gl2.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl2.enableVertexAttribArray(this.a_pos);
    gl2.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl2.enable(gl.BLEND);
    gl2.blendEquation(gl2.MAX);
    gl2.blendFunc(gl.ONE, gl.ONE);
    gl2.disable(gl.CULL_FACE);

    gl2.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    // ── Canopy fraction: rain only, same MAX blend, alpha carries opacity ──
    if (rain && this.canopyGeometry && this.canopyProgram &&
        this.canopyPosBuffer && this.canopyOpacityBuffer &&
        this.canopyGeometry.verts.length > 0) {
      if (this.canopyUploadedVersion !== this.canopyVersion) {
        gl2.bindBuffer(gl.ARRAY_BUFFER, this.canopyPosBuffer);
        gl2.bufferData(gl.ARRAY_BUFFER, this.canopyGeometry.verts, gl.DYNAMIC_DRAW);
        gl2.bindBuffer(gl.ARRAY_BUFFER, this.canopyOpacityBuffer);
        gl2.bufferData(gl.ARRAY_BUFFER, this.canopyGeometry.opacity, gl.DYNAMIC_DRAW);
        this.canopyUploadedVersion = this.canopyVersion;
      }
      gl2.useProgram(this.canopyProgram);
      gl2.uniformMatrix4fv(this.canopyUMatrix, false, matrix);
      gl2.uniform4f(this.canopyUColor, raw[0], raw[1], raw[2], raw[3]);
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.canopyPosBuffer);
      gl2.enableVertexAttribArray(this.canopyAttrPos);
      gl2.vertexAttribPointer(this.canopyAttrPos, 2, gl.FLOAT, false, 0, 0);
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.canopyOpacityBuffer);
      gl2.enableVertexAttribArray(this.canopyAttrOpacity);
      gl2.vertexAttribPointer(this.canopyAttrOpacity, 1, gl.FLOAT, false, 0, 0);
      gl2.drawArrays(gl.TRIANGLES, 0, this.canopyGeometry.verts.length / 2);
    }

    // ── Pass B + C: Height-aware roof exclusion ──
    const roofVertexCount = geo.roofVerts.length / 2;
    if (!geo.sunBelowHorizon && roofVertexCount > 0 &&
        this.heightProgram && this.shadowHeightBuffer &&
        this.heightFbo && this.heightFboTexture &&
        this.roofProgram && this.roofPosBuffer && this.roofHeightBuffer) {

      // ── Pass B: Render shadow geometry into a depth-only ceiling FBO ──
      // GREATER retains the tallest normalized shadow ceiling at every pixel.
      gl2.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo);
      gl2.viewport(0, 0, w, h);
      gl2.enable(gl.DEPTH_TEST);
      gl2.depthMask(true);
      gl2.depthFunc(gl.GREATER);
      gl2.depthRange(0, 1);
      gl2.clearDepth(0);
      gl2.clear(gl.DEPTH_BUFFER_BIT);
      gl2.disable(gl.BLEND);

      gl2.useProgram(this.heightProgram);
      gl2.uniformMatrix4fv(this.heightUMatrix, false, matrix);
      gl2.uniform1f(this.heightUFieldScale, fieldScale);

      // Bind shadow position buffer (same geometry as Pass A)
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl2.enableVertexAttribArray(this.heightAttrPos);
      gl2.vertexAttribPointer(this.heightAttrPos, 2, gl.FLOAT, false, 0, 0);

      // Bind shadow height buffer
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.shadowHeightBuffer);
      gl2.enableVertexAttribArray(this.heightAttrH);
      gl2.vertexAttribPointer(this.heightAttrH, 1, gl.FLOAT, false, 0, 0);

      gl2.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

      // ── Pass C: Render roof footprints into shadow FBO with destination-out ──
      // Erases shadow where maxIncomingHeight <= buildingHeight (self-shadow).
      gl2.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl2.viewport(0, 0, w, h);
      // Do NOT clear — we want to selectively erase from existing shadow
      gl2.disable(gl.DEPTH_TEST);
      gl2.depthMask(false);
      // Hand MapLibre's range back before Pass E, whose extrusions have to interleave
      // with the sublayers drawn above this one.
      gl2.depthRange(prevDepthRange[0], prevDepthRange[1]);
      gl2.enable(gl.BLEND);

      gl2.useProgram(this.roofProgram);
      gl2.uniformMatrix4fv(this.roofUMatrix, false, matrix);

      // Bind height FBO texture for sampling
      gl2.activeTexture(gl.TEXTURE0);
      gl2.bindTexture(gl.TEXTURE_2D, this.heightFboTexture);
      gl2.uniform1i(this.roofUHeightTex, 0);
      gl2.uniform1f(this.roofUFieldScale, fieldScale);
      gl2.uniform1f(this.roofUBias, heightBias);

      // Bind roof position buffer
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.roofPosBuffer);
      gl2.enableVertexAttribArray(this.roofAttrPos);
      gl2.vertexAttribPointer(this.roofAttrPos, 2, gl.FLOAT, false, 0, 0);

      // Bind roof height buffer
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.roofHeightBuffer);
      gl2.enableVertexAttribArray(this.roofAttrH);
      gl2.vertexAttribPointer(this.roofAttrH, 1, gl.FLOAT, false, 0, 0);

      // Destination-out: where roof fragment outputs alpha=1, erase shadow FBO
      gl2.blendEquation(gl.FUNC_ADD);
      gl2.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);

      gl2.drawArrays(gl.TRIANGLES, 0, roofVertexCount);
    }

    // ── Pass D: Composite FBO texture onto main canvas ──
    gl2.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl2.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

    gl2.useProgram(this.quadProgram);
    gl2.activeTexture(gl.TEXTURE0);
    gl2.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl2.uniform1i(this.quadTexLoc, 0);
    gl2.uniform1f(this.quadInvertLoc, rain ? 1 : 0);
    gl2.uniform1f(
      this.quadAlphaScaleLoc,
      rain ? LocalShadowAdapter.RAIN_WET_ALPHA : 1,
    );

    gl2.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl2.enableVertexAttribArray(this.quadAttrLoc);
    gl2.vertexAttribPointer(this.quadAttrLoc, 2, gl.FLOAT, false, 0, 0);

    gl2.blendEquation(gl.FUNC_ADD);
    gl2.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl2.drawArrays(gl.TRIANGLES, 0, 6);

    // ── Pass E: extruded buildings, painted with the shadow field ──
    // Flat-on there is nothing to paint — the roofs are all you would see, and the
    // basemap already draws those — so this only runs once the camera is tilted.
    // That also keeps the canvas the shadow sampler reads (invariant #5, always at
    // pitch 0) exactly as it was.
    const cache = this.buildingCache;
    if (!rain &&
        cache && cache.bldgVertexCount > 0 && this.map.getPitch() > 0 &&
        this.bldgProgram && this.bldgPosBuffer && this.bldgHeightBuffer &&
        this.bldgNormalBuffer && this.heightFboTexture) {
      if (this.cacheVersion !== this.lastUploadedCacheVersion) {
        gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgPosBuffer);
        gl2.bufferData(gl.ARRAY_BUFFER, cache.bldgPos, gl.STATIC_DRAW);
        gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgHeightBuffer);
        gl2.bufferData(gl.ARRAY_BUFFER, cache.bldgHeightM, gl.STATIC_DRAW);
        gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgNormalBuffer);
        gl2.bufferData(gl.ARRAY_BUFFER, cache.bldgNormal, gl.STATIC_DRAW);
        this.lastUploadedCacheVersion = this.cacheVersion;
      }

      const az = this.lastSunAzRad ?? 0;
      const alt = this.lastSunAltRad ?? 0;
      // SunCalc's azimuth runs south→west; Mercator y runs north→south. Toward the
      // sun is therefore (-sin az, cos az) — the negative of the shadow's direction.
      const sunX = -Math.sin(az);
      const sunY = Math.cos(az);
      const u = this.bldgUniforms;
      const [pr, pg, pb, alpha] = this.computeShadowColor(geo.sunBelowHorizon);

      gl2.useProgram(this.bldgProgram);
      gl2.uniformMatrix4fv(u.u_matrix, false, matrix);
      gl2.uniform1f(u.u_mercZPerMeter, mercPerMeter);
      gl2.uniform1f(u.u_maxH, cache.maxH);
      gl2.uniform2f(
        u.u_sunOffset,
        sunX * WALL_SHADOW_SUN_OFFSET_M * mercPerMeter,
        sunY * WALL_SHADOW_SUN_OFFSET_M * mercPerMeter,
      );
      gl2.uniform1f(u.u_normalOffset, WALL_SHADOW_NORMAL_OFFSET_M * mercPerMeter);
      // The height each step's sunward component buys back, so the nudged sample
      // decides what an un-nudged one at the fragment's own base would have.
      gl2.uniform2f(
        u.u_ceilLift,
        normalizedCeilingLift(WALL_SHADOW_SUN_OFFSET_M, alt, cache.maxH),
        normalizedCeilingLift(WALL_SHADOW_NORMAL_OFFSET_M, alt, cache.maxH),
      );
      gl2.uniform3f(u.u_sunDir, sunX * Math.cos(alt), sunY * Math.cos(alt), Math.sin(alt));
      // computeShadowColor premultiplies for the ground composite; the buildings mix
      // in straight colour, so divide the constant alpha back out.
      gl2.uniform3f(u.u_shadowTint, pr / alpha, pg / alpha, pb / alpha);
      gl2.uniform2f(u.u_sunFlat, sunX, sunY);
      gl2.uniform3f(u.u_wallColor, BUILDING_RGB[0], BUILDING_RGB[1], BUILDING_RGB[2]);
      gl2.uniform1f(u.u_sunBelow, geo.sunBelowHorizon ? 1 : 0);
      gl2.uniform1f(u.u_bias, heightBias);
      gl2.uniform1f(u.u_fieldScale, fieldScale);

      gl2.activeTexture(gl.TEXTURE0);
      gl2.bindTexture(gl.TEXTURE_2D, this.heightFboTexture);
      gl2.uniform1i(u.u_heightTex, 0);

      gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgPosBuffer);
      gl2.enableVertexAttribArray(this.bldgAttrPos);
      gl2.vertexAttribPointer(this.bldgAttrPos, 2, gl.FLOAT, false, 0, 0);
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgHeightBuffer);
      gl2.enableVertexAttribArray(this.bldgAttrHeight);
      gl2.vertexAttribPointer(this.bldgAttrHeight, 1, gl.FLOAT, false, 0, 0);
      gl2.bindBuffer(gl.ARRAY_BUFFER, this.bldgNormalBuffer);
      gl2.enableVertexAttribArray(this.bldgAttrNormal);
      gl2.vertexAttribPointer(this.bldgAttrNormal, 3, gl.FLOAT, false, 0, 0);

      // The same depth mode MapLibre gives `fill-extrusion`: opaque, self-occluding,
      // in front of the basemap fills that wrote depth in the opaque pass. Later
      // translucent layers (the route line) test no depth, so they still draw on top.
      gl2.disable(gl.BLEND);
      // Cull the far side of every building. Without this a slab seen edge-on
      // z-fights its own opposite wall, and since one of the two is turned to the
      // sun and the other away, the fight shows up as a grey/blue hatch.
      // MapLibre's matrix flips y, so the outward faces come out clockwise.
      gl2.enable(gl.CULL_FACE);
      gl2.cullFace(gl.BACK);
      gl2.frontFace(gl.CW);
      gl2.enable(gl.DEPTH_TEST);
      gl2.depthFunc(gl.LEQUAL);
      gl2.depthMask(true);
      // The depth *range* is left as MapLibre set it. For a '3d' custom layer that
      // is `depthRangeFor3D`, which stops just short of 1 so no 3D fragment can lose
      // LEQUAL against the near-1 depths the opaque-pass basemap fills wrote. Taking
      // the full [0,1] here would re-open exactly that, letting the ground reject a
      // distant building.

      gl2.drawArrays(gl.TRIANGLES, 0, cache.bldgVertexCount);

      gl2.disableVertexAttribArray(this.bldgAttrPos);
      gl2.disableVertexAttribArray(this.bldgAttrHeight);
      gl2.disableVertexAttribArray(this.bldgAttrNormal);
      gl2.frontFace(gl.CCW);
      gl2.enable(gl.BLEND);
    }

    // ── Restore GL state ──
    if (!wasBlend) gl2.disable(gl.BLEND);
    if (wasCull) gl2.enable(gl.CULL_FACE);
    gl2.blendEquationSeparate(prevBlendEqRGB, prevBlendEqA);
    gl2.blendFuncSeparate(prevBlendSrcRGB, prevBlendDstRGB, prevBlendSrcA, prevBlendDstA);
    gl2.activeTexture(prevActiveTexture);
    gl2.bindTexture(gl.TEXTURE_2D, prevTexture);
    if (wasDepthTest) gl2.enable(gl.DEPTH_TEST);
    else gl2.disable(gl.DEPTH_TEST);
    gl2.depthFunc(prevDepthFunc);
    gl2.depthMask(prevDepthMask);
    gl2.clearDepth(prevDepthClear);
    gl2.depthRange(prevDepthRange[0], prevDepthRange[1]);
  }

  onRemove(_map: maplibregl.Map, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    // Unregister map listeners
    if (this.map) {
      this.map.off('sourcedata', this.onSourceData);
      this.map.off('zoomend', this.onZoomEnd);
      this.map.off('moveend', this.onMoveEnd);
    }

    // Phase 4: Terminate sun worker
    if (this.sunWorker) {
      this.sunWorker.terminate();
      this.sunWorker = null;
    }

    if (this.program) gl.deleteProgram(this.program);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.fboTexture) gl.deleteTexture(this.fboTexture);
    if (this.heightProgram) gl.deleteProgram(this.heightProgram);
    if (this.shadowHeightBuffer) gl.deleteBuffer(this.shadowHeightBuffer);
    if (this.heightFbo) gl.deleteFramebuffer(this.heightFbo);
    if (this.heightFboTexture) gl.deleteTexture(this.heightFboTexture);
    if (this.roofProgram) gl.deleteProgram(this.roofProgram);
    if (this.roofPosBuffer) gl.deleteBuffer(this.roofPosBuffer);
    if (this.roofHeightBuffer) gl.deleteBuffer(this.roofHeightBuffer);
    if (this.bldgProgram) gl.deleteProgram(this.bldgProgram);
    if (this.bldgPosBuffer) gl.deleteBuffer(this.bldgPosBuffer);
    if (this.bldgHeightBuffer) gl.deleteBuffer(this.bldgHeightBuffer);
    if (this.bldgNormalBuffer) gl.deleteBuffer(this.bldgNormalBuffer);
    if (this.quadProgram) gl.deleteProgram(this.quadProgram);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    this.program = null;
    this.positionBuffer = null;
    this.fbo = null;
    this.fboTexture = null;
    this.heightProgram = null;
    this.shadowHeightBuffer = null;
    this.heightFbo = null;
    this.heightFboTexture = null;
    this.roofProgram = null;
    this.roofPosBuffer = null;
    this.roofHeightBuffer = null;
    this.bldgProgram = null;
    this.bldgPosBuffer = null;
    this.bldgHeightBuffer = null;
    this.bldgNormalBuffer = null;
    this.lastUploadedCacheVersion = -1;
    this.quadProgram = null;
    this.quadBuffer = null;
    this.buildingCache = null;
    this.map = null;
    this.gl = null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Compute the premultiplied shadow color based on sun altitude.
   * At sunrise/sunset (altitude ≈ 0): base color #01112f
   * At 12:00 noon (altitude = noon peak): lighter blue #22467f
   * Night (sun below horizon): base color unchanged
   */
  private computeShadowColor(sunBelowHorizon: boolean): [number, number, number, number] {
    const a = LocalShadowAdapter.SHADOW_ALPHA;
    const [br, bg, bb] = LocalShadowAdapter.BASE_RGB;

    if (sunBelowHorizon) {
      return [br * a, bg * a, bb * a, a];
    }

    let t = 0;
    if (this.map && this.lastSunAltRad != null && this.lastSunAltRad > 0) {
      const center = this.map.getCenter();
      const { solarNoon } = SunCalc.getTimes(this.currentDate, center.lat, center.lng);
      const noonAlt = SunCalc.getPosition(solarNoon, center.lat, center.lng).altitude;
      if (noonAlt > 0) {
        t = Math.min(1, this.lastSunAltRad / noonAlt);
      }
    }

    const [nr, ng, nb] = LocalShadowAdapter.NOON_RGB;
    return [
      (br + t * (nr - br)) * a,
      (bg + t * (ng - bg)) * a,
      (bb + t * (nb - bb)) * a,
      a,
    ];
  }

  private ensureFBO(gl: WebGL2RenderingContext, w: number, h: number) {
    if (this.fbo && this.fboWidth === w && this.fboHeight === h) return;

    const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);

    // Clean up old resources
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.fboTexture) gl.deleteTexture(this.fboTexture);
    if (this.heightFbo) gl.deleteFramebuffer(this.heightFbo);
    if (this.heightFboTexture) gl.deleteTexture(this.heightFboTexture);

    // Shadow FBO
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

    this.fboTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // LINEAR so Pass D box-downsamples the supersampled shadow → antialiased edges.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);

    // Height FBO: depth-only because the ceiling is a scalar maximum, not colour.
    this.heightFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo);

    this.heightFboTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.heightFboTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      w,
      h,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.heightFboTexture,
      0,
    );
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    // A depth-only FBO that fails completeness draws nothing and reports nothing, so
    // the ceiling field reads as zero and every roof comes out lit. Say so once per
    // resize rather than leaving that to be diagnosed from the picture.
    const heightFboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (heightFboStatus !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn(
        `[shadow] height framebuffer incomplete (0x${heightFboStatus.toString(16)}) at ${w}x${h}; roofs will render unshadowed`,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);

    this.fboWidth = w;
    this.fboHeight = h;
  }

  /**
   * Phase 2: Build and cache building geometry (footprints + roof triangulations).
   * This is the expensive part — querying source features, earcut triangulations,
   * Mercator conversions. Cached and reused across setDate() calls since building
   * shapes don't change with time.
   */
  private buildBuildingGeometryCache(): CachedBuildingGeometry {
    const center = this.map?.getCenter();
    const bounds = this.map?.getBounds();
    const anchor: CacheAnchor = {
      centerLng: center?.lng ?? 0,
      centerLat: center?.lat ?? 0,
      zoom: this.map?.getZoom() ?? 0,
      bounds: bounds
        ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
        : [0, 0, 0, 0],
      // A cache assembled while tiles are still streaming holds only part of the
      // buildings; the policy replaces it as soon as the source settles.
      builtFromLoadedSource: this.map?.isSourceLoaded('maptiler_planet') ?? false,
    };
    const emptyMesh = {
      bldgPos: new Float32Array(),
      bldgHeightM: new Float32Array(),
      bldgNormal: new Float32Array(),
      bldgVertexCount: 0,
    };
    const emptyCache: CachedBuildingGeometry = {
      buildings: [], maxH: 1, centerMerc: [0, 0], anchor, ...emptyMesh,
    };
    if (!this.map || !center) return emptyCache;
    if (this.map.getZoom() < 12) return emptyCache;

    const [cx, cy] = lngLatToMercator(center.lng, center.lat);

    const features = this.map.querySourceFeatures('maptiler_planet', {
      sourceLayer: 'building',
    });
    const { prisms, maxHeightM } = prismsFromTileFeatures(features);

    const cached: CachedBuildingGeometry = {
      buildings: [], maxH: maxHeightM, centerMerc: [cx, cy], anchor, ...emptyMesh,
    };

    // Pass E's mesh, accumulated alongside the roofs it shares its source with.
    const mesh: PrismMesh = { pos: [], heightM: [], normal: [] };

    for (const prism of prisms) {
      // Roof footprint triangulation, Mercator-projected and centered once here
      // so Pass C can memcpy it straight into the vertex buffer every frame.
      const roofVerts: number[] = [];
      for (const [lng, lat] of triangulateRing(prism.ring)) {
        const [x, y] = lngLatToMercator(lng, lat);
        roofVerts.push(x - cx, y - cy);
      }

      cached.buildings.push({
        prism,
        normalizedH: prism.heightM / maxHeightM,
        mercatorRoofVerts: new Float32Array(roofVerts),
      });

      // Walls, in the same Mercator-centered frame the roof triangles are already in.
      const ringMerc = prism.ring.map(([lng, lat]) => {
        const [x, y] = lngLatToMercator(lng, lat);
        return [x - cx, y - cy] as [number, number];
      });
      appendPrismMesh(ringMerc, prism.heightM, roofVerts, mesh);
    }

    cached.bldgPos = new Float32Array(mesh.pos);
    cached.bldgHeightM = new Float32Array(mesh.heightM);
    cached.bldgNormal = new Float32Array(mesh.normal);
    cached.bldgVertexCount = mesh.heightM.length;

    return cached;
  }

  /**
   * Phase 2: Extrude shadows from cached building geometry using current sun position.
   * This is the fast path — no querySourceFeatures, no earcut, just shadow offset math.
   */
  /**
   * Canopy cast as ground shadow polygons with per-vertex rain opacity.
   *
   * Crowns sit on trunks, so the near ring is displaced by `baseM / tan(alt)`
   * along the shadow direction before the ground sweep of the remaining height —
   * the same endpoints the shadow index uses for elevated casters, spelled for
   * the renderer's flat triangles. Vertical rain lands on the crown's own
   * footprint, exactly.
   */
  private buildCanopyGeometry(
    azRad: number,
    altRad: number
  ): { verts: Float32Array; opacity: Float32Array } | null {
    if (!this.map || this.canopyPrisms.length === 0) return null;
    const center = this.map.getCenter();
    const { mPerLat, mPerLng } = metersPerDegree(center.lat);
    const [cx, cy] = lngLatToMercator(center.lng, center.lat);
    const tanAlt = Math.tan(altRad);
    if (!Number.isFinite(tanAlt) || tanAlt <= 0) return null;
    const verts: number[] = [];
    const opacity: number[] = [];
    for (const prism of this.canopyPrisms) {
      const sweep = canopyShadowTriangles(prism, azRad, altRad, mPerLat, mPerLng);
      const rainOpacity = rainOpacityForLightOpacity(prism.opacity);
      for (let i = 0; i < sweep.length; i++) {
        const [lng, lat] = lngLatToMercator(sweep[i][0], sweep[i][1]);
        verts.push(lng - cx, lat - cy);
        opacity.push(rainOpacity);
      }
    }
    return { verts: new Float32Array(verts), opacity: new Float32Array(opacity) };
  }

  private extrudeShadows(
    cache: CachedBuildingGeometry,
    hazard: { azimuthRad: number; altitudeRad: number; sunBelow: boolean },
    rain = false
  ): ShadowGeometry {
    const empty: ShadowGeometry = {
      shadowVerts: new Float32Array(),
      shadowHeights: new Float32Array(),
      roofVerts: new Float32Array(),
      roofHeights: new Float32Array(),
      sunBelowHorizon: false,
    };
    if (!this.map) return empty;

    // Phase 4: The worker's sun position, or the wind-fed rain ray — the extrude
    // math below is direction-agnostic; only the callers' semantic differs.
    const sunAzimuth = hazard.azimuthRad;
    const sunAltitude = hazard.altitudeRad;
    if (!rain && this.hazardMode === "sun" && this.lastSunAzRad == null) {
      // A sun that was never computed (worker disabled) leaves its trace for the
      // dirty-check the same way the old synchronous path did.
      this.lastSunAzDeg = sunAzimuth * 180 / Math.PI;
      this.lastSunAltDeg = sunAltitude * 180 / Math.PI;
      this.lastSunAzRad = sunAzimuth;
      this.lastSunAltRad = sunAltitude;
    }

    // Sun below horizon → full dark overlay (world quad). Rain never goes below.
    if (!rain && sunAltitude <= 0) {
      return {
        shadowVerts: new Float32Array([
          0, 0,  1, 0,  1, 1,
          0, 0,  1, 1,  0, 1,
        ]),
        shadowHeights: new Float32Array(),
        roofVerts: new Float32Array(),
        roofHeights: new Float32Array(),
        sunBelowHorizon: true,
      };
    }

    if (cache.buildings.length === 0) return empty;

    const center = this.map.getCenter();
    const { mPerLat, mPerLng } = metersPerDegree(center.lat);

    const shadowVertsList: number[] = [];
    const shadowHeightsList: number[] = [];
    const roofVertsList: number[] = [];
    const roofHeightsList: number[] = [];

    const [cx, cy] = cache.centerMerc;

    for (const bldg of cache.buildings) {
      // Shadow geometry: edge-by-edge side-wall extrusion + earcut caps
      const ceilings: number[] = [];
      const shadowTris = buildShadowTriangles(
        bldg.prism.ring, bldg.prism.heightM, sunAzimuth, sunAltitude, mPerLat, mPerLng,
        ceilings
      );
      for (let i = 0; i < shadowTris.length; i++) {
        const [x, y] = lngLatToMercator(shadowTris[i][0], shadowTris[i][1]);
        shadowVertsList.push(x - cx, y - cy);
        shadowHeightsList.push(bldg.normalizedH * ceilings[i]);
      }

      // Roof verts from cache (already triangulated and in Mercator)
      const rv = bldg.mercatorRoofVerts;
      for (let i = 0; i < rv.length; i++) {
        roofVertsList.push(rv[i]);
      }
      const roofTriCount = rv.length / 2; // number of xy pairs = vertex count
      for (let i = 0; i < roofTriCount; i++) {
        roofHeightsList.push(bldg.normalizedH);
      }
    }

    return {
      shadowVerts: new Float32Array(shadowVertsList),
      shadowHeights: new Float32Array(shadowHeightsList),
      roofVerts: new Float32Array(roofVertsList),
      roofHeights: new Float32Array(roofHeightsList),
      sunBelowHorizon: false,
    };
  }

  private emit(event: string) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach(cb => cb());
  }
}

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

function createShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'Unknown program link error';
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}
