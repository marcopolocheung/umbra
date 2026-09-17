import { coverageSetHas, type CoverageIndex, type GenerationRoot } from "../shadowField/v2/artifacts";
import { DEBUG_TILE_ZOOM, DEBUG_WORKER_BUDGET, DEBUG_ZOOM, type DebugAccounting, type DebugTileUpdate, type DebugWorkerCommand, type DebugWorkerEvent } from "./protocol";

export function isShadowV2DebugEnabled(value = import.meta.env.VITE_SHADOW_V2_DEBUG): boolean {
  return value === "true";
}

/** Convert a map centre to the exact 3×3 z18 neighbourhood used by the diagnostic. */
export function debugTileNeighborhood(lng: number, lat: number): string[] {
  const n = 2 ** DEBUG_TILE_ZOOM;
  const x = Math.floor(((lng + 180) / 360) * n);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = (clampedLat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * n);
  const tiles: string[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tileX = x + dx;
    const tileY = y + dy;
    if (tileX >= 0 && tileX < n && tileY >= 0 && tileY < n) tiles.push(`${DEBUG_TILE_ZOOM}/${tileX}/${tileY}`);
  }
  return tiles;
}

export function debugTilesForViewport(
  viewport: { lng: number; lat: number; zoom: number },
  coverage: CoverageIndex | undefined,
): string[] {
  if (viewport.zoom < DEBUG_ZOOM || !coverage) return [];
  return debugTileNeighborhood(viewport.lng, viewport.lat).filter((tile) => {
    const [, x, y] = tile.split("/").map(Number);
    return coverageSetHas(coverage.available, x, y);
  });
}

const emptyAccounting: DebugAccounting = { cacheBytes: 0, compressedBytes: 0, workerBytes: 0, stagingBytes: 0, gpuBytes: 0, requested: 0, inFlight: 0, ready: 0, incomplete: 0, error: 0, evicted: 0 };
type CommandWithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;

export class RemoteTileService {
  private readonly worker: Worker;
  private requestId = 0;
  private generation?: string;
  private coverage?: CoverageIndex;
  private timer?: number;
  private staged = new Map<string, number>();
  private accounting: DebugAccounting = { ...emptyAccounting };
  onGenerationReady?: (root: GenerationRoot, coverage: CoverageIndex) => void;
  onTileUpdate?: (update: DebugTileUpdate) => void;
  onTileEvicted?: (tile: string) => void;
  onTileReleased?: (tile: string) => void;
  onGenerationReset?: () => void;
  onAccounting?: (value: DebugAccounting) => void;

  constructor(baseUrl: string) {
    this.worker = new Worker(new URL("./remoteTile.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<DebugWorkerEvent>) => this.handle(event.data);
    this.send({ type: "configureGeneration", baseUrl, budget: DEBUG_WORKER_BUDGET });
  }

  /** Coalesced `moveend` input. At z<20 it deliberately leases no remote tiles. */
  updateViewport(viewport: { lng: number; lat: number; zoom: number }) {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      const tiles = debugTilesForViewport(viewport, this.coverage);
      if (!this.generation) return;
      this.send({ type: "setInterests", generation: this.generation, interestId: "viewport", tiles });
    }, 0);
  }

  setGpuBytes(bytes: number) {
    this.accounting.gpuBytes = bytes;
    this.publishAccounting();
  }

  setBudget(bytes: number) {
    if (!this.generation || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.send({ type: "setBudget", generation: this.generation, budget: bytes });
  }

  releaseInterest(interestId: string) {
    if (!this.generation) return;
    this.send({ type: "releaseInterest", generation: this.generation, interestId });
  }

  shutdown() {
    window.clearTimeout(this.timer);
    this.send({ type: "shutdown", generation: this.generation });
    this.worker.terminate();
    this.staged.clear();
  }

  private send(command: CommandWithoutRequestId<DebugWorkerCommand>) {
    this.worker.postMessage({ ...command, requestId: ++this.requestId } as DebugWorkerCommand);
  }

  private handle(event: DebugWorkerEvent) {
    // Each event is correlated to the currently pinned generation. A late response
    // can neither update the debug texture nor alter its visible accounting.
    if (event.type === "generationReady") {
      if (this.generation && this.generation !== event.generation) {
        this.staged.clear();
        this.accounting = { ...emptyAccounting };
        this.onGenerationReset?.();
      }
      this.generation = event.generation;
      this.coverage = event.coverage;
      this.onGenerationReady?.(event.root, event.coverage);
      return;
    }
    if (event.generation && event.generation !== this.generation) return;
    if (event.type === "tileReady") {
      const key = `${event.generation}/${event.tile}`;
      this.staged.set(key, event.pixels.byteLength);
      this.accounting.stagingBytes = [...this.staged.values()].reduce((sum, bytes) => sum + bytes, 0);
      this.onTileUpdate?.(event);
      this.publishAccounting();
      return;
    }
    if (event.type === "tileEvicted" || event.type === "tileReleased") {
      this.staged.delete(`${event.generation}/${event.tile}`);
      this.accounting.stagingBytes = [...this.staged.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (event.type === "tileEvicted") this.onTileEvicted?.(event.tile);
      else this.onTileReleased?.(event.tile);
      this.publishAccounting();
    }
    if (event.type === "accounting") {
      this.accounting = { ...this.accounting, ...event.accounting };
      this.publishAccounting();
    }
  }

  private publishAccounting() { this.onAccounting?.({ ...this.accounting }); }
}
