// app/lib/exportRoute.ts
import type { RouteOption } from "./routing";
import type { Trip } from "./trip/types";

export function routeToGeoJSON(route: RouteOption, trip?: Trip): string {
  const context = route.evaluatedContext;
  const routeFeature: GeoJSON.Feature = {
    ...route.geojson,
    properties: {
      ...(route.geojson.properties ?? {}),
      objective: route.objective ?? context?.objective ?? "sun",
      ...(context
        ? {
            evaluatedAt: context.time.toISOString(),
            referenceLocation: context.referenceLocation,
            windProvenance: context.windProvenance,
            windDirectionDeg: context.windDirectionDeg,
            windSpeedMps: context.windSpeedMps,
            contextRevision: context.revision,
          }
        : {}),
    },
  };
  const features: GeoJSON.Feature[] = [routeFeature];
  if (trip) {
    for (const [i, stop] of trip.stops.entries()) {
      features.push({
        type: "Feature",
        properties: {
          name: stop.label ?? `Stop ${i + 1}`,
          ...(stop.dwellMinutes ? { dwellMinutes: stop.dwellMinutes } : {}),
        },
        geometry: { type: "Point", coordinates: [...stop.coord] },
      });
    }
  }
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
  return JSON.stringify(fc, null, 2);
}

export function routeToGPX(route: RouteOption, name: string, trip?: Trip): string {
  const coords = route.geojson.geometry.coordinates as [number, number][];
  const trkpts = coords
    .map(([lon, lat]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`)
    .join("\n");
  const waypoints = (trip?.stops ?? [])
    .map((stop, i) => {
      const [lon, lat] = stop.coord;
      const stopName = escapeXml(stop.label ?? `Stop ${i + 1}`);
      const dwell = stop.dwellMinutes ? `\n      <desc>${stop.dwellMinutes} min stop</desc>` : "";
      return `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">\n    <name>${stopName}</name>${dwell}\n  </wpt>`;
    })
    .join("\n");
  // GPX 1.1's `gpxType` fixes the order `metadata?, wpt*, rte*, trk*`, so the
  // stops go BEFORE the track. A schema-validating reader drops or rejects them
  // the other way round.
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Umbra" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><desc>${escapeXml(gpxConditions(route))}</desc></metadata>
${waypoints ? `${waypoints}\n` : ""}  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function gpxConditions(route: RouteOption): string {
  const context = route.evaluatedContext;
  if (!context) return `Umbra ${route.objective ?? "sun"} route`;
  const wind = context.objective === "rain"
    ? `; ${context.windProvenance} wind ${context.windDirectionDeg ?? "unknown"}° at ${context.windSpeedMps ?? "unknown"} m/s`
    : "";
  return `Umbra ${context.objective} route evaluated ${context.time.toISOString()}${wind}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function downloadBlob(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
