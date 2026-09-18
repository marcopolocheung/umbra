# NYC navigation data contract — session 1

**Status:** fixture and parser contract only. No production route or shadow provider consumes
this dataset yet.

## Source plan

- Streets: dated New York State OSM PBF from [Geofabrik](https://download.geofabrik.de/north-america/us/new-york.html), clipped to a buffered NYC support boundary offline. The browser never parses PBF and the producer must retain URL, release/timestamp, byte count, and SHA-256 receipts.
- Buildings: maintained NYC Building Footprints, using the City's [official metadata](https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md). The release is pinned offline; the browser never queries the feature service.
- Attribution: publish `© OpenStreetMap contributors` and an ODbL link with every generation. NYC Open Data terms and source notices travel with the building dataset.

## v1 policy decisions

- A street shard owns each directed edge exactly once and may carry ghost endpoint nodes from an adjacent cell. Node ids remain numeric OSM ids.
- A bidirectional pedestrian way publishes two directed edges. The fixture carries the current graph's highway/surface/access-related tags without introducing new routing semantics.
- A building footprint is whole in exactly one owner shard. Its support bounds may extend beyond its geometry bounds so caster selection can find a whole footprint and its possible shadow near a cell boundary.
- `heightM: null` plus `heightSource: "unknown"` is distinct from zero, covered absence, and a fallback height. Zero is rejected from the published contract.
- Placeholder triangles are rejected before publication. The fixture keeps one source-only rejected record as evidence of that policy; it is not a browser building record.
- The browser contract currently admits active, under-construction, and other included feature classes. The full producer must quantify and document the treatment of garages, parking structures, tanks, skybridges, cantilevers, demolition flags, and under-construction records before a citywide generation.
- Source feet-to-metres conversion belongs in the offline producer, not in the browser prism provider.

## Fixture and unresolved measurements

The committed fixture has two z14-shaped cells, an edge crossing their seam, a whole footprint
straddling the geometry seam, a known-height building, an explicit unknown-height building, and a
rejected placeholder. It is generated from stable literals and canonical JSON, so equal inputs
produce equal bytes and a repeatable generation id.

The z13/z14 choice is intentionally unresolved. The full producer must compare selected bytes,
request count, parse/merge time, graph spill, caster-reach overhead, and seam behavior before
choosing a grid. The v1 JSON byte caps are protective envelopes, not a performance claim; a
binary format is a later measured decision.

Raw sources and citywide generated artifacts belong under an external `NAVIGATION_PREP_ROOT` and
must not enter git. The fixture uses `example.invalid` receipts so no test implies that a real
citywide download occurred.
