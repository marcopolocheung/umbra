export interface ShadowPointQueryResult {
  shadowFraction: number;
  source: "geometry-cache";
}

/** Top-left-origin, one-byte coverage read from the building-only shadow FBO. */
export interface BuildingShadowMask {
  data: Uint8Array;
  width: number;
  height: number;
  /** FBO pixels per CSS pixel on each axis (the FBO dimension can be capped). */
  pixelRatioX: number;
  pixelRatioY: number;
}

export interface IShadowLayer {
  /** Called whenever the date/time changes (slider drag, play animation, TimeInput commit) */
  setDate(date: Date): void;
  /** Called on map resize — rebuild textures/framebuffer to new viewport dimensions */
  resize(): void;
  /** Clean up all WebGL resources and map layers on component unmount */
  remove(): void;
  /** Toggle sun-exposure accumulation mode (no-op in the local renderer) */
  setSunExposure(enabled: boolean, opts?: { startDate: Date; endDate: Date; iterations: number }): void;
  /** Register an event listener (e.g. 'idle' after render completes) */
  on(event: string, callback: () => void): void;
  /** Read building coverage without basemap, water, canopy fill, or tree shadows. */
  readBuildingShadowMask(): BuildingShadowMask | null;
  /**
   * Query shadow from currently loaded shadow geometry without moving the map.
   * Returns null when the layer cannot answer confidently and callers should
   * fall back to rendered-canvas sampling.
   */
  queryPointShadow?(lng: number, lat: number, opts?: { date?: Date }): ShadowPointQueryResult | null;
  /** Raw visibility gate: off keeps every resource alive for an instant toggle. */
  setEnabled?(enabled: boolean): void;
  /** Which hazard the canvas draws: the sun (default) or rain. */
  setHazard?(hazard: "sun" | "rain"): void;
  /** Wind the rain rendering aims its ray at (from-bearing, m/s). */
  setRainWind?(dirDeg: number | null, windMs: number | null): void;
}
