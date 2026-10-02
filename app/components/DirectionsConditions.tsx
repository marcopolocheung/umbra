import { useId, useState } from "react";
import type { WeatherHour } from "../lib/heat/types";
import { formatTime12h } from "../hooks/useShadowTime";

export interface DirectionsConditionsProps {
  selectedTime: Date;
  mapUtcOffsetMin: number;
  solarPosition: { altitudeDeg: number; azimuthDeg: number } | null;
  sunset: Date | null;
  weather: WeatherHour | null;
}

const DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compass16(degrees: number): string {
  return DIRECTIONS[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function uvCategory(uv: number): string {
  if (uv < 3) return "LOW";
  if (uv < 6) return "MOD";
  if (uv < 8) return "HIGH";
  if (uv < 11) return "V HIGH";
  return "EXTREME";
}

export function conditionsValues({ selectedTime, mapUtcOffsetMin, solarPosition, sunset, weather }: DirectionsConditionsProps) {
  return {
    sun: solarPosition && finite(solarPosition.altitudeDeg) && finite(solarPosition.azimuthDeg)
      ? `${Math.round(solarPosition.altitudeDeg)}° ${compass16(solarPosition.azimuthDeg)}` : "—",
    air: finite(weather?.tempC) ? `${Math.round(weather.tempC * 9 / 5 + 32)}°F` : "—",
    uv: finite(weather?.uvIndex) ? `${Math.round(weather.uvIndex)} ${uvCategory(weather.uvIndex)}` : "—",
    wind: finite(weather?.windMs) && finite(weather?.windDirDeg)
      ? `${Math.round(weather.windMs * 2.236936)} MPH ${compass16(weather.windDirDeg)}` : "—",
    sunset: sunset && Number.isFinite(sunset.getTime()) ? formatTime12h(sunset, mapUtcOffsetMin) : "—",
    time: formatTime12h(selectedTime, mapUtcOffsetMin),
  };
}

function FlapValue({ value, animate = false, testId }: { value: string; animate?: boolean; testId: string }) {
  return <dd className={`directions-board-value ${animate ? "directions-board-flip" : ""}`} data-value={value} data-testid={testId}>
    <span className="sr-only">{value}</span>
    {Array.from(value).map((character, index) => <span key={`${index}:${character}`} className={character === " " ? "directions-board-space" : "directions-board-character"} aria-hidden="true">{character}</span>)}
  </dd>;
}

export default function DirectionsConditions(props: DirectionsConditionsProps) {
  const { selectedTime } = props;
  const values = conditionsValues(props);
  const [expanded, setExpanded] = useState(false);
  const disclosureId = useId();
  return <section className="directions-conditions" data-directions-section="Conditions" aria-label="Conditions at the stamped time">
    <div className="directions-board-head"><span>Conditions</span><time dateTime={selectedTime.toISOString()}>{values.time}</time></div>
    <dl className="directions-board-rows">
      <div className="directions-board-row"><dt>Sun</dt><FlapValue key={selectedTime.getTime()} value={values.sun} animate testId="conditions-sun" /></div>
      <div className="directions-board-row"><dt>Air</dt><FlapValue value={values.air} testId="conditions-air" /></div>
      <div className="directions-board-row"><dt>UV</dt><FlapValue value={values.uv} testId="conditions-uv" /></div>
      <div className="directions-board-row"><dt>Wind</dt><FlapValue value={values.wind} testId="conditions-wind" /></div>
      <div className="directions-board-row"><dt>Sunset</dt><FlapValue value={values.sunset} testId="conditions-sunset" /></div>
    </dl>
    <button type="button" className="directions-board-how" aria-expanded={expanded} aria-controls={disclosureId} onClick={() => setExpanded((value) => !value)}><span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>How this is gathered</button>
    {expanded && <dl id={disclosureId} className="directions-board-sources">
      <div><dt>Sun · Sunset</dt><dd>Worked out on your device by the same sun-position model that paints the shadows, for the map centre. The Sun row uses the stamped time; Sunset uses its solar day.</dd></div>
      <div><dt>Air · UV · Wind</dt><dd>Open-Meteo’s hourly forecast for the map’s location, cached for one hour. Umbra uses the forecast hour nearest the stamped time, up to 90 minutes away.</dd></div>
      <div><dt>Missing data</dt><dd>If the forecast leaves a value out, the board shows a dash. It never fills in a guess.</dd></div>
    </dl>}
  </section>;
}
