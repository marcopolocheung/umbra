import { useId, useState } from "react";
import type { AccumulationOptions } from "./MapView";
import DateInput from "./DateInput";

interface Bounds {
  getWest(): number;
  getEast(): number;
  getNorth(): number;
  getSouth(): number;
}

interface AccumulationPanelProps {
  accumulation: AccumulationOptions;
  onChange: (opts: AccumulationOptions) => void;
  getCanvas: () => HTMLCanvasElement | undefined;
  getBounds: () => Bounds | undefined;
}

/**
 * Writes a minimal GeoTIFF (uncompressed RGB) with geographic metadata.
 */
function buildGeoTIFF(
  imageData: ImageData,
  west: number,
  north: number,
  east: number,
  south: number
): Blob {
  const { width, height } = imageData;
  const rgba = imageData.data;

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }

  const pixelScaleX = (east - west) / width;
  const pixelScaleY = (north - south) / height;

  const NUM_ENTRIES = 11;
  const IFD_OFFSET = 8;
  const DATA_OFFSET = IFD_OFFSET + 2 + NUM_ENTRIES * 12 + 4;
  const BPS_OFFSET = DATA_OFFSET;
  const SCALE_OFFSET = BPS_OFFSET + 6;
  const TIEPOINT_OFFSET = SCALE_OFFSET + 24;
  const PIXEL_OFFSET = TIEPOINT_OFFSET + 48;

  const buf = new ArrayBuffer(PIXEL_OFFSET + rgb.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let o = 0;

  view.setUint16(o, 0x4949, true); o += 2;
  view.setUint16(o, 42, true); o += 2;
  view.setUint32(o, IFD_OFFSET, true); o += 4;

  view.setUint16(o, NUM_ENTRIES, true); o += 2;

  function entry(tag: number, type: number, count: number, value: number) {
    view.setUint16(o, tag, true); o += 2;
    view.setUint16(o, type, true); o += 2;
    view.setUint32(o, count, true); o += 4;
    view.setUint32(o, value, true); o += 4;
  }

  entry(256, 4, 1, width);
  entry(257, 4, 1, height);
  entry(258, 3, 3, BPS_OFFSET);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 2);
  entry(273, 4, 1, PIXEL_OFFSET);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, height);
  entry(279, 4, 1, rgb.length);
  entry(33550, 12, 3, SCALE_OFFSET);
  entry(33922, 12, 6, TIEPOINT_OFFSET);

  view.setUint32(o, 0, true); o += 4;

  view.setUint16(BPS_OFFSET, 8, true);
  view.setUint16(BPS_OFFSET + 2, 8, true);
  view.setUint16(BPS_OFFSET + 4, 8, true);

  view.setFloat64(SCALE_OFFSET, pixelScaleX, true);
  view.setFloat64(SCALE_OFFSET + 8, pixelScaleY, true);
  view.setFloat64(SCALE_OFFSET + 16, 0, true);

  view.setFloat64(TIEPOINT_OFFSET, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 8, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 16, 0, true);
  view.setFloat64(TIEPOINT_OFFSET + 24, west, true);
  view.setFloat64(TIEPOINT_OFFSET + 32, north, true);
  view.setFloat64(TIEPOINT_OFFSET + 40, 0, true);

  bytes.set(rgb, PIXEL_OFFSET);

  return new Blob([buf], { type: "image/tiff" });
}

function qualityLabel(n: number): string {
  if (n <= 8)  return "Fast";
  if (n <= 24) return "Low";
  if (n <= 40) return "Balanced";
  if (n <= 56) return "Good";
  return "Detailed";
}

export default function AccumulationPanel({
  accumulation,
  onChange,
  getCanvas,
  getBounds,
}: AccumulationPanelProps) {
  const [open, setOpen] = useState(false);
  const qualityInputId = useId();

  function toggle() {
    const next = !accumulation.enabled;
    onChange({ ...accumulation, enabled: next });
    setOpen(next);
  }

  async function exportGeoTIFF() {
    const canvas = getCanvas();
    const bounds = getBounds();
    if (!canvas || !bounds) return;

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res));
    if (!blob) return;

    const bmp = await createImageBitmap(blob);
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, tmp.width, tmp.height);

    const tif = buildGeoTIFF(
      imageData,
      bounds.getWest(),
      bounds.getNorth(),
      bounds.getEast(),
      bounds.getSouth()
    );

    const url = URL.createObjectURL(tif);
    const a = document.createElement("a");
    a.href = url;
    a.download = "umbra-accumulation.tif";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2 items-start">
      <button type="button"
        onClick={toggle}
        className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
          accumulation.enabled
            ? "bg-chrome text-on-chrome font-medium"
             : "bg-raised border border-hairline hover:bg-chrome-soft"
        }`}
        style={!accumulation.enabled ? { color: "var(--color-ink)" } : undefined}
      >
        <span className="material-symbols-outlined text-sm align-middle mr-1" style={{ fontVariationSettings: "'FILL' 1" }}>wb_sunny</span>
        Sun Exposure
      </button>

      {open && (
        <div
          className="border rounded-lg p-3 flex flex-col gap-2 text-xs min-w-panel-min"
          style={{
            background: "var(--color-raised)",
            borderColor: "var(--color-hairline)",
            color: "var(--color-ink)",
            boxShadow: "var(--shadow-level-1)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className="w-12" style={{ color: "var(--color-ink-muted)" }}>From</span>
            <DateInput
              ariaLabel="Sun exposure start date"
              date={accumulation.startDate}
              onChange={(d) => onChange({ ...accumulation, startDate: d })}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12" style={{ color: "var(--color-ink-muted)" }}>To</span>
            <DateInput
              ariaLabel="Sun exposure end date"
              date={accumulation.endDate}
              onChange={(d) => onChange({ ...accumulation, endDate: d })}
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={qualityInputId} className="w-12" style={{ color: "var(--color-ink-muted)" }}>Quality</label>
            <input
              id={qualityInputId}
              type="range"
              min={8}
              max={64}
              step={8}
              value={accumulation.iterations}
              onChange={(e) =>
                onChange({ ...accumulation, iterations: Number(e.target.value) })
              }
              className="flex-1 accent-chrome"
            />
            <span className="w-20 text-right leading-tight">
              <span style={{ color: "var(--color-ink)" }}>
                {qualityLabel(accumulation.iterations)}
              </span>
              <span className="text-[10px] ml-1" style={{ color: "var(--color-ink-muted)" }}>
                ({accumulation.iterations})
              </span>
            </span>
          </div>

          <div className="flex flex-col gap-1 mt-1">
            <div
              className="h-2 rounded"
              style={{
                background: [
                  "linear-gradient(to right,",
                  " var(--color-route),",
                  " color-mix(in srgb, var(--color-route) 50%, var(--color-shade)),",
                  " var(--color-shade),",
                  " color-mix(in srgb, var(--color-shade) 50%, var(--color-sun)),",
                  " var(--color-sun),",
                  " color-mix(in srgb, var(--color-sun) 50%, var(--color-danger)),",
                  " var(--color-danger))",
                ].join(" "),
              }}
            />
            <div
              className="flex justify-between text-[9px] tabular-nums px-px"
              style={{ color: "var(--color-ink-muted)" }}
            >
              <span>0h</span>
              <span>3h</span>
              <span>6h</span>
              <span>9h</span>
              <span>12h+</span>
            </div>
          </div>

          <button type="button"
            onClick={exportGeoTIFF}
            className="mt-1 transition-colors rounded px-3 py-1.5 text-center font-medium"
            style={{ background: "var(--color-chrome)", color: "var(--color-on-chrome)" }}
          >
            Export GeoTIFF
          </button>
        </div>
      )}
    </div>
  );
}
