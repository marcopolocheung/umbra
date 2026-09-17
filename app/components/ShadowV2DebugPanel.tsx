import type { DebugAccounting } from "../lib/shadowV2Debug/protocol";

export function ShadowV2DebugPanel({ generation, accounting, cacheSource }: { generation?: string; accounting: DebugAccounting; cacheSource?: string }) {
  const mib = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return <aside data-testid="shadow-v2-debug-panel" className="absolute left-2 top-2 z-20 max-w-72 rounded bg-black/85 p-2 font-mono text-[10px] text-white pointer-events-none">
    <div className="font-semibold text-cyan-300">v2 tile debug · {generation ?? "loading"}</div>
    <div>requested {accounting.requested} · in-flight {accounting.inFlight} · ready {accounting.ready}</div>
    <div>incomplete {accounting.incomplete} · errors {accounting.error} · evicted {accounting.evicted}</div>
    <div>cache {cacheSource ?? "—"} · compressed {mib(accounting.compressedBytes)}</div>
    <div>worker {mib(accounting.workerBytes)} · staging {mib(accounting.stagingBytes)} · GPU {mib(accounting.gpuBytes)}</div>
    <div className="text-fuchsia-300">building</div><div className="text-green-300">canopy</div><div className="text-yellow-300">unknown / incomplete</div><div className="text-cyan-300">tile edge</div>
  </aside>;
}
