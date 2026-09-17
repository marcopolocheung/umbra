/** Exact byte ledger for the separately constructible numeric worker. */
export interface LedgerSnapshot { budget: number; resident: number; peak: number; byKind: Readonly<Record<string, number>>; }

export class MemoryLedger {
  private readonly entries = new Map<string, { bytes: number; kind: string }>();
  private residentBytes = 0;
  private peakBytes = 0;
  constructor(private budgetBytes: number) { if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new Error("invalid memory budget"); }
  reserve(id: string, bytes: number, kind = "other"): boolean {
    if (!id || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid ledger reservation");
    if (this.entries.has(id)) throw new Error(`duplicate ledger reservation ${id}`);
    if (this.residentBytes + bytes > this.budgetBytes) return false;
    this.entries.set(id, { bytes, kind }); this.residentBytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.residentBytes);
    return true;
  }
  release(id: string): number { const entry = this.entries.get(id); if (!entry) return 0; this.entries.delete(id); this.residentBytes -= entry.bytes; return entry.bytes; }
  setBudget(bytes: number): boolean { if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid memory budget"); this.budgetBytes = bytes; return this.residentBytes <= bytes; }
  snapshot(): LedgerSnapshot { const byKind: Record<string, number> = {}; for (const entry of this.entries.values()) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + entry.bytes; return { budget: this.budgetBytes, resident: this.residentBytes, peak: this.peakBytes, byKind }; }
}
