# Evidence for 03 — data sources

Collected 2026-09-12. This directory supports
[03-data-sources.md](../../03-data-sources.md). It contains read-only public HTTP
observations, publisher documents, operation discovery and deterministic arithmetic.
There is **no full-region normalization, throughput benchmark, world-coverage
census, ground-control validation or successful height-transformation claim** here.

## Files and methods

| Artifact | Method / sample / interpretation |
|---|---|
| [source-manifest.json](./source-manifest.json) and [sources/](./sources/) | Publisher pages, licence texts, technical reports and dataset metadata fetched without credentials. Each source has URL, final URL, capture time, status, response byte count and SHA-256. The captured bodies (`.body.gz`) and extracted text (`.txt`) were removed on 2026-10-09 to keep 10 MB of third-party pages out of the tree; they are in git history at `8e5f463`, and the SHA-256 in each record still pins them. Three `.txt` files that `verify.py` or `03-data-sources.md` read are kept. Cookies are omitted from saved response headers. A retained 404/timeout/HTML access page is evidence of that response, not of the requested document's contents. |
| [capture.py](./capture.py) | Public-document capture with four concurrent workers and 40s timeout. Existing observations are retained; the manifest includes the initial seed list and adaptively discovered captures. This is not a crawler or an attempt to load-test a provider. |
| [terrain-levels.json](./terrain-levels.json) | 17 Terrarium HEAD levels × Madrid/Kent/Singapore = 51 site/zoom entries (some shared URLs). z0–15: 200; z16: 404 at all three. Contributor headers identify whole-tile source lists, not the provenance of a particular pixel or vertical processing. |
| [raster-metadata.json](./raster-metadata.json) | IFD/header inspection of six CHMv2 COGs, two Copernicus COGs, one AWS GeoTIFF, one IGN vertical grid and one LINZ DEM. Dimensions, sample types, masks, georeferencing, statistics and compressed block-size sums; **no raster-band reads**. A complete object size is read from Content-Range, not inferred from block sums. |
| [http/](./http/) | Exact retained range bodies and response metadata, keyed by SHA-256 of URL + range. Repeated runs replay these bodies. No full CHM source object is committed. |
| [probe.mjs](./probe.mjs) | Node with `geotiff` 3.0.5; `getImageCount()` and IFD access, lazy TileByteCounts loading, no `readRasters()`. Reads use 64KiB range blocks and `allowFullFile:false`. Later additions inspect the IGN grid and LINZ AS21 asset; original city observations are replayed. |
| [datum-operations.json](./datum-operations.json) and [datum_probe.py](./datum_probe.py) | PROJ 9.8.1 / pyproj 3.8.0, network disabled, non-ballpark operation discovery for small Kent/Madrid AOIs. No required grids installed and no heights transformed in the recorded run. Grid availability/licence flags are supplemented with provider PROJ-data README captures. |
| [calculations.json](./calculations.json) and [calculations.py](./calculations.py) | Web Mercator tile coverage, cell/byte arithmetic and clearly labelled price/compression scenarios. The 506-tile bbox calculation uses 02d's Madrid extraction extent, not a certified caster region. Timing and production peak memory remain unmeasured. |
| [joerd-revision.txt](./joerd-revision.txt) | Pinned public Tilezen revision; relevant compositor and MIT COPYING text are also captured as `joerd-composite` and `joerd-copying`. Public code inspection does not identify every preprocessing step of the deployed AWS producer. |
| [checks.json](./checks.json) and [verify.py](./verify.py) | Offline range hashes, document local links, required rows, measured probe facts and arithmetic checks. No app test suite is needed for this documentation-only deliverable. |

Metadata tools ran in Linux/WSL2 x86_64 with Node v20.20.1 and Python 3.12.8.
Hardware does not support any performance claim: none is made. Probe coordinates
are fixed in `probe.mjs`; source URLs and timestamps are in the retained JSON.
Publisher validation counts and accuracy metrics are attributed to their studies,
not to measurements on this machine.

## Evidence groups

| Topic | Source IDs in `sources/` |
|---|---|
| AWS mixed sources, formats, licences | `aws-terrain`, `joerd-sources`, `joerd-formats`, `joerd-attribution`, `joerd-composite`, `joerd-copying` |
| Terrain datum and accuracy | `usgs-datums`, `usgs-accuracy`, `usgs-gmted`, `gmted-report`, `eudem-validation`, `eudem-retired`, `srtm-product`, `srtm-accuracy`, `nasadem-guide`, `egg2008`, `canada-spec-ftp` |
| Copernicus coverage and pyramids | `copdem-aws`, `copdem-cog`, `copdem-product`; live IFDs `cop30`, `cop90` |
| National alternatives and constraints | `ea-dtm`, `arcticdem`, `pgc-guide`, `linz-elevation`, `linz-aws`, `linz-readme`, `linz-collection`, `linz-item`, `linz-tiff-spec`, `fabdem-catalog` |
| Vertical grids | `proj-nga`, `proj-noaa`, `proj-spain`, `proj-nz`, `proj-canada`; IGN IFD `ign-egm08-rednap` |
| Canopy quality/coverage | `chm-paper`, `chm-aws`, `chm-mirror`, `chm-mirror-license`, `chm-stac`, `chm-origin-list`, `chm-origin-meta-list`; six city IFD probes |
| Canopy licence discrepancy | `chm-paper` (March paper says DINOv3), `chm-registry-yaml` (current CC BY), `chm-zenodo`, `chm-zenodo-api`, `chm-zenodo-readme` (June author archive, CC BY and matching AWS prefix), `dinov3-readme`, `dinov3-license` (code/weights) |
| Building sources/licences | `overture-buildings`, `overture-schema`, `overture-attribution`, `osm-copyright`, `odbl`, `microsoft-buildings`, `microsoft-license`, `microsoft-revision`, `microsoft-pinned-readme`, `microsoft-pinned-license`, `cdla`, `google-buildings`, `google-temporal` |
| Services/obligations | `overpass-limits`, `maptiler-terms`, `maptiler-price`, `ccby`, `r2-price` |

Some exploratory captures are intentionally retained even when not selected:
JAXA candidate pages, a failed FABDEM endpoint (the Bristol catalogue succeeded),
a Canadian specification URL returning HTML (the NRCan FTP HTTPS copy succeeded), a 404 Austria page (search-indexed
publisher text was available), and a 404 joerd `LICENSE` path (`COPYING` succeeded).
They are not used as successful full-document evidence. The document names the
remaining uncertainty rather than inventing details from these failures.

## Reproduction

From repository root, with dependencies installed in an isolated environment:

```bash
python3 docs/shadow-engine-v2/evidence/03/calculations.py
node docs/shadow-engine-v2/evidence/03/probe.mjs
PROJ_NETWORK=OFF python3 docs/shadow-engine-v2/evidence/03/datum_probe.py
python3 docs/shadow-engine-v2/evidence/03/verify.py
```

Use pyproj 3.8.0/PROJ 9.8.1 and geotiff 3.0.5 to reproduce the recorded operation
database/IFD behaviour. `capture.py` uses `requests` and Beautiful Soup. PDF text
was extracted from saved decompressed bodies using `pypdf.PdfReader`, joining
`page.extract_text()`; the original PDF bodies are retained. Avoid replacing
original observations during a fresh-network rerun: use a copy of this directory
with empty caches, and compare capture times/versions. HEAD checks replay existing
observations if present; the offline integrity check does not contact providers.

Source documents, licences, data metadata and range fragments retain their source
rights. Retaining them as research evidence does not relicense third-party data
under Umbra's MIT licence. Source notices and modification obligations applicable
to production datasets are catalogued in 03 §7.
