import type { ShadeWindowClaimReceipt } from "../lib/agent/receipts";
import { shadeClockLabel, shadeComparisonRows, shadeTimelineRows } from "../lib/agent/shadeWindows";

/** Display derives exclusively from the canonical, verified tool observation. */
export default function ShadeWindowDetails({ receipt }: { receipt: ShadeWindowClaimReceipt }) {
  if (receipt.verification !== "verified" || !receipt.basis) return null;
  const rows = shadeTimelineRows(receipt.value.hours, receipt.mode);
  const comparison = receipt.similarity
    ? shadeComparisonRows(receipt.similarity.reference.hours, receipt.value.hours, receipt.mode)
    : null;
  return (
    <div className="px-2 pb-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
      {receipt.similarity && (
        <p>
          Similar annual shade pattern to {receipt.similarity.reference.label}. Search results are
          approximate. The table compares the two sidewalks in this time window.
        </p>
      )}
      <p>
        Typical monthly day: {receipt.basis.representativeDate}. All times are New York time; this
        is a modelled estimate for the requested date.
      </p>
      {receipt.reasons?.includes("snapped") && (
        <p>
          Requested {shadeClockLabel(receipt.requestedWindow.fromMinutes)}–
          {shadeClockLabel(receipt.requestedWindow.toMinutes)}; evaluated at the nearest quarter
          hour.
        </p>
      )}
      {(receipt.reasons?.includes("daylight-clipped") ||
        receipt.reasons?.includes("table-clipped")) && (
        <p>Only available daylight samples are included.</p>
      )}
      <details>
        <summary className="min-h-11 py-3 cursor-pointer">
          {receipt.mode === "sun" ? "Sun" : "Shade"} by time
        </summary>
        <table className="w-full text-left tabular-nums">
          <thead>
            <tr>
              <th scope="col">New York time</th>
              {comparison && <th scope="col">Reference {receipt.mode}</th>}
              <th scope="col">
                {comparison ? "Match" : "Modelled"} {receipt.mode}
              </th>
            </tr>
          </thead>
          <tbody>
            {comparison
              ? comparison.map((row) => (
                  <tr key={row.fromMinutes}>
                    <td>
                      {shadeClockLabel(row.fromMinutes)}–{shadeClockLabel(row.toMinutes)}
                    </td>
                    <td>
                      {row.reference
                        ? `${Math.round(row.reference.fraction * 100)}%${row.reference.partial ? "*" : ""}`
                        : "—"}
                    </td>
                    <td>
                      {row.match
                        ? `${Math.round(row.match.fraction * 100)}%${row.match.partial ? "*" : ""}`
                        : "—"}
                    </td>
                  </tr>
                ))
              : rows.map((row) => (
                  <tr key={row.fromMinutes}>
                    <td>
                      {shadeClockLabel(row.fromMinutes)}–{shadeClockLabel(row.toMinutes)}
                    </td>
                    <td>{Math.round(row.fraction * 100)}%</td>
                  </tr>
                ))}
          </tbody>
        </table>
        {comparison?.some((row) => row.reference?.partial || row.match?.partial) && (
          <p>* Average of available daylight samples in this interval.</p>
        )}
      </details>
    </div>
  );
}
