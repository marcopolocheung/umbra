import type { CoverageIndex, GenerationRoot } from "../shadowField/v2/artifacts";

/** This transport is deliberately separate from the shadow field used by routing. */
export const DEBUG_WORKER_BUDGET = 96 * 1024 * 1024;
export const DEBUG_ZOOM = 20;
export const DEBUG_TILE_ZOOM = 18;

export type DebugTileStatus = "loading" | "ready" | "incomplete" | "error" | "evicted";

export interface DebugAccounting {
  compressedBytes: number;
  workerBytes: number;
  stagingBytes: number;
  gpuBytes: number;
  requested: number;
  inFlight: number;
  ready: number;
  incomplete: number;
  error: number;
  evicted: number;
}

export type DebugWorkerCommand =
  | { type: "configureGeneration"; requestId: number; baseUrl: string; budget: number }
  | { type: "setInterests"; requestId: number; generation: string; interestId: string; tiles: string[] }
  | { type: "releaseInterest"; requestId: number; generation: string; interestId: string }
  | { type: "setBudget"; requestId: number; generation: string; budget: number }
  | { type: "shutdown"; requestId: number; generation?: string };

export type DebugWorkerEvent =
  | { type: "generationReady"; requestId: number; generation: string; root: GenerationRoot; coverage: CoverageIndex }
  | { type: "tileLoading" | "tileIncomplete" | "tileError" | "tileEvicted"; requestId: number; generation: string; tile: string; error?: string; cacheSource?: "cache" | "network" }
  | { type: "tileReady"; requestId: number; generation: string; tile: string; pixels: Uint8Array; complete: boolean; cacheSource: "cache" | "network" }
  | { type: "accounting"; requestId: number; generation?: string; accounting: Omit<DebugAccounting, "stagingBytes" | "gpuBytes"> };

export interface DebugTileUpdate {
  generation: string;
  tile: string;
  pixels: Uint8Array;
  complete: boolean;
  cacheSource: "cache" | "network";
}
