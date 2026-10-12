import type { ShadeWindowClaimReceipt } from "../lib/agent/receipts";
import { shadeClockLabel, shadeTimelineRows } from "../lib/agent/shadeWindows";

/** Display derives exclusively from the canonical, verified tool observation. */
export default function ShadeWindowDetails({ receipt }: { receipt: ShadeWindowClaimReceipt }) {
  if (receipt.verification !== "verified" || !receipt.basis) return null;
  const rows = shadeTimelineRows(receipt.value.hours, receipt.mode);
  return (
    <div className="px-2 pb-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
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
              <th scope="col">Modelled {receipt.mode}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.fromMinutes}>
                <td>
                  {shadeClockLabel(row.fromMinutes)}–{shadeClockLabel(row.toMinutes)}
                </td>
                <td>{Math.round(row.fraction * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
