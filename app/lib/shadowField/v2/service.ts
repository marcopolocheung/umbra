import type { ComposedTile } from "./compose";
import { indexBounds, planAcquisition, type AcquisitionOptions, type ReceiverDomain } from "./acquisition";
import type { CoverageIndex, GenerationIdentity, TileBoundsArtifact } from "./artifacts";
import { MemoryLedger, type LedgerSnapshot } from "./memoryLedger";
import { MarchContinuation, type NumericMarchResult, type NumericOutcome, type NumericPageField } from "./numericMarch";
import { COORDINATE_CONVENTION_VERSION } from "./coordinates";
import { SOLAR_CONVENTION_VERSION, type SolarPosition } from "./solar";
import { TreeModelV2 } from "./treeModel";

export interface NumericModels {
  solar: typeof SOLAR_CONVENTION_VERSION;
  coordinates: typeof COORDINATE_CONVENTION_VERSION;
  tree: string;
  receiver: string;
}
export interface NumericIdentity { generation: string; generationIdentity: GenerationIdentity; models: NumericModels; }
export interface NumericAccounting { plannedPages: number; requestedPages: number; loadedPages: number; queryCount: number; marchSteps: number; ledger: LedgerSnapshot; }
export interface NumericReceiver { id?: string; eastM: number; northM: number; /** Required if no domain is supplied; never inferred from a gutter. */ tile?: string; }
export interface NumericPointResult extends NumericMarchResult { id?: string; identity: NumericIdentity; accounting: NumericAccounting; }
export interface NumericEdge { id?: string; left: readonly NumericReceiver[]; right: readonly NumericReceiver[]; }
export interface NumericEdgeResult { id?: string; left: NumericSideResult; right: NumericSideResult; identity: NumericIdentity; accounting: NumericAccounting; }
export interface NumericSideResult { value: number | null; complete: boolean; outcome: NumericOutcome; samples: NumericPointResult[]; }
export interface PageLoadRequest { generation: string; pages: readonly string[]; deadlineAt: number; signal?: AbortSignal; }
export interface PageLoadResult { generation: string; pages: ReadonlyMap<string, ComposedTile>; fetchedBytes?: number; }
export type PageLoader = (request: PageLoadRequest) => Promise<PageLoadResult>;
export interface NumericServiceOptions { coverage: CoverageIndex; bounds: TileBoundsArtifact; identity: GenerationIdentity; loadPages: PageLoader; cellSizeM: number; budgetBytes: number; now?: () => number; }
export interface QueryOptions extends AcquisitionOptions { domains?: readonly ReceiverDomain[]; deadlineAt?: number; deadlineMs?: number; signal?: AbortSignal; generation?: string; }

function pageBytes(page: ComposedTile): number {
  return page.groundQ.byteLength + page.buildingTopQ.byteLength + page.crownBaseQ.byteLength + page.crownTopQ.byteLength + page.flagsAndMaterial.byteLength + page.provenanceIndex.byteLength;
}
function pageField(pages: ReadonlyMap<string, ComposedTile>, cellSizeM: number): NumericPageField {
  const local = new Map<string, ComposedTile>();
  for (const [tile, page] of pages) { const parts = tile.split("/"); local.set(parts.length === 3 ? `${parts[1]}/${parts[2]}` : tile, page); }
  return { cellSizeM, tiles: local, knownEmptyExterior: false };
}
function reasonResult(outcome: NumericOutcome): NumericMarchResult { return { value: null, buildingOnly: null, complete: outcome === "night", outcome, steps: 0 }; }

/**
 * Inactive, batch-only numeric service.  It is intentionally not an
 * `IShadowLayer` and is not imported by routing or MapView; integrating it is
 * a later, explicitly feature-gated PR.
 */
export class NumericFieldService {
  private readonly ledger: MemoryLedger;
  private readonly pages = new Map<string, ComposedTile>();
  private readonly identity: NumericIdentity;
  private readonly now: () => number;
  private readonly loadPages: PageLoader;
  private readonly cellSizeM: number;
  private readonly coverage: CoverageIndex;
  private readonly bounds: ReturnType<typeof indexBounds> | undefined = undefined;
  private readonly initializationFailure?: NumericOutcome;
  private queryCount = 0;

  constructor(options: NumericServiceOptions) {
    this.ledger = new MemoryLedger(options.budgetBytes); this.now = options.now ?? Date.now; this.loadPages = options.loadPages; this.cellSizeM = options.cellSizeM; this.coverage = options.coverage;
    this.identity = { generation: options.coverage.generation, generationIdentity: options.identity, models: { solar: SOLAR_CONVENTION_VERSION, coordinates: COORDINATE_CONVENTION_VERSION, tree: TreeModelV2.version, receiver: options.identity.receiverHash } };
    try { this.bounds = indexBounds(options.coverage, options.bounds); } catch { this.initializationFailure = "corrupt-hierarchy"; }
  }

  evict(tile: string): boolean { const removed = this.pages.delete(tile); if (removed) this.ledger.release(`page:${tile}`); return removed; }
  accounting(plannedPages = 0, requestedPages = 0, marchSteps = 0): NumericAccounting { return { plannedPages, requestedPages, loadedPages: this.pages.size, queryCount: this.queryCount, marchSteps, ledger: this.ledger.snapshot() }; }

  async queryPoints(receivers: readonly NumericReceiver[], sun: SolarPosition, options: QueryOptions = {}): Promise<NumericPointResult[]> {
    this.queryCount++;
    const deadlineAt = options.deadlineAt ?? this.now() + (options.deadlineMs ?? 5_000);
    const make = (receiver: NumericReceiver, value: NumericMarchResult, planned = 0, requested = 0, steps = value.steps): NumericPointResult => ({ ...value, ...(receiver.id === undefined ? {} : { id: receiver.id }), identity: this.identity, accounting: this.accounting(planned, requested, steps) });
    if (options.generation && options.generation !== this.identity.generation) return receivers.map((receiver) => make(receiver, reasonResult("stale-generation")));
    if (options.signal?.aborted) return receivers.map((receiver) => make(receiver, reasonResult("cancelled")));
    if (sun.altitude <= 0) return receivers.map((receiver) => make(receiver, reasonResult("night")));
    if (this.initializationFailure || !this.bounds) return receivers.map((receiver) => make(receiver, reasonResult("corrupt-hierarchy")));
    if (this.now() >= deadlineAt) return receivers.map((receiver) => make(receiver, reasonResult("deadline")));
    const domains = options.domains ?? [{ kind: "viewport-ground" as const, tiles: receivers.map((receiver) => receiver.tile).filter((tile): tile is string => !!tile) }];
    if (!options.domains && domains[0].tiles.length !== receivers.length) return receivers.map((receiver) => make(receiver, reasonResult("unsupported")));
    const plan = planAcquisition(this.coverage, this.bounds, domains, sun, options);
    if (plan.incompleteReason) {
      const outcome = plan.incompleteReason;
      return receivers.map((receiver) => make(receiver, reasonResult(outcome), plan.pages.length));
    }
    const missing = plan.pages.filter((tile) => !this.pages.has(tile));
    if (missing.length) {
      if (this.now() >= deadlineAt) return receivers.map((receiver) => make(receiver, reasonResult("deadline"), plan.pages.length, missing.length));
      try {
        const loaded = await this.withDeadline(this.loadPages({ generation: this.identity.generation, pages: missing, deadlineAt, signal: options.signal }), deadlineAt);
        if (options.signal?.aborted) return receivers.map((receiver) => make(receiver, reasonResult("cancelled"), plan.pages.length, missing.length));
        if (loaded.generation !== this.identity.generation) return receivers.map((receiver) => make(receiver, reasonResult("stale-generation"), plan.pages.length, missing.length));
        for (const [tile, page] of loaded.pages) if (!this.pages.has(tile)) {
          const bytes = pageBytes(page); if (!this.ledger.reserve(`page:${tile}`, bytes, "page")) return receivers.map((receiver) => make(receiver, reasonResult("budget"), plan.pages.length, missing.length));
          this.pages.set(tile, page);
        }
        // Broad acquisition is conservative. A failed page is therefore not
        // allowed to become a clear ray merely because the exact DDA happens
        // not to enter that page in this particular resolution.
        if (missing.some((tile) => !this.pages.has(tile)))
          return receivers.map((receiver) => make(receiver, reasonResult("missing-page"), plan.pages.length, missing.length));
      } catch (_error) {
        const outcome: NumericOutcome = options.signal?.aborted ? "cancelled" : this.now() >= deadlineAt ? "deadline" : "missing-page";
        return receivers.map((receiver) => make(receiver, reasonResult(outcome), plan.pages.length, missing.length));
      }
    }
    const field = pageField(this.pages, this.cellSizeM);
    return receivers.map((receiver) => {
      const march = new MarchContinuation(field, receiver.eastM, receiver.northM, sun, deadlineAt, () => !!options.signal?.aborted);
      let result = march.resume(256, this.now);
      while (!result) result = march.resume(256, this.now);
      return make(receiver, result, plan.pages.length, missing.length, result.steps);
    });
  }

  async queryEdges(edges: readonly NumericEdge[], sun: SolarPosition, options: QueryOptions = {}): Promise<NumericEdgeResult[]> {
    const all = edges.flatMap((edge) => [...edge.left, ...edge.right]);
    const points = await this.queryPoints(all, sun, options); let offset = 0;
    return edges.map((edge) => {
      const leftEnd = offset + edge.left.length;
      const left = points.slice(offset, leftEnd);
      const rightEnd = leftEnd + edge.right.length;
      const right = points.slice(leftEnd, rightEnd);
      offset = rightEnd;
      const side = (samples: NumericPointResult[]): NumericSideResult => {
        const complete = samples.length > 0 && samples.every((sample) => sample.complete && sample.value !== null);
        const values = samples.map((sample) => sample.value).filter((value): value is number => value !== null);
        return { value: complete ? values.reduce((sum, value) => sum + value, 0) / values.length : null, complete, outcome: complete ? "complete" : (samples.find((sample) => !sample.complete)?.outcome ?? "unsupported"), samples };
      };
      return { ...(edge.id === undefined ? {} : { id: edge.id }), left: side(left), right: side(right), identity: this.identity, accounting: this.accounting() };
    });
  }

  async queryTimes(receivers: readonly NumericReceiver[], suns: readonly SolarPosition[], options: QueryOptions = {}): Promise<NumericPointResult[][]> {
    const deadlineAt = options.deadlineAt ?? this.now() + (options.deadlineMs ?? 5_000);
    return Promise.all(suns.map((sun) => this.queryPoints(receivers, sun, { ...options, deadlineAt })));
  }

  private async withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
    const remaining = deadlineAt - this.now(); if (remaining <= 0) throw new Error("deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), remaining); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
