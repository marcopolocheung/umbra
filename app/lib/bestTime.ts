import { fromMapLocal, toMapLocal } from "./timezone";

export interface HourlyExposureSample {
  date: Date;
  hour: number;
  label: string;
  shadowCoverage: number;
  sunExposure: number;
  /** Forecast-backed rain hours can be unavailable without claiming exposure. */
  available?: boolean;
  objective?: "sun" | "rain";
}

export interface HourlyExposureOptions {
  startHour?: number;
  endHour?: number;
  stepHours?: number;
}

export type ShadowCoverageSampler = (date: Date) => number;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function formatHourLabel(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return "12 AM";
  if (normalized < 12) return `${normalized} AM`;
  if (normalized === 12) return "12 PM";
  return `${normalized - 12} PM`;
}

export function buildHourlyExposureSeries(
  baseDate: Date,
  utcOffsetMin: number,
  sampleShadowCoverage: ShadowCoverageSampler,
  options: HourlyExposureOptions = {}
): HourlyExposureSample[] {
  const startHour = options.startHour ?? 6;
  const endHour = options.endHour ?? 20;
  const stepHours = options.stepHours ?? 1;
  if (stepHours <= 0) throw new Error("stepHours must be greater than 0.");
  if (endHour < startHour) throw new Error("endHour must be greater than or equal to startHour.");

  const samples: HourlyExposureSample[] = [];
  for (let hour = startHour; hour <= endHour; hour += stepHours) {
    const date = fromMapLocal(baseDate, utcOffsetMin, hour, 0);
    const local = toMapLocal(date, utcOffsetMin);
    const shadowCoverage = clamp01(sampleShadowCoverage(date));
    samples.push({
      date,
      hour: local.hours,
      label: formatHourLabel(local.hours),
      shadowCoverage,
      sunExposure: 1 - shadowCoverage,
    });
  }
  return samples;
}

export function bestExposureSample(
  samples: HourlyExposureSample[],
  objective: "sun" | "rain" = samples[0]?.objective ?? "sun",
): HourlyExposureSample | null {
  const available = samples.filter((sample) => sample.available !== false);
  if (available.length === 0) return null;
  return available.reduce((best, sample) => objective === "rain"
    ? sample.shadowCoverage > best.shadowCoverage ? sample : best
    : sample.sunExposure < best.sunExposure ? sample : best
  );
}
