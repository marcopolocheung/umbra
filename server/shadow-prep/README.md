# Local NYC shadow preparation

This package creates **local-only**, immutable, source-separated preparation
generations. It does not deploy, upload, activate the app, or make a physical
accuracy claim. Node 24, GDAL and PROJ are intentionally container-only.

Create an external data directory (never a directory inside this repository), then
place only selected immutable raw assets under `raw/`. Install the two pinned NGA
files in `~/shade-prep-data/proj`; this directory is read-only in the container.
`raw/source-receipts.json` has exactly twelve logical receipt IDs, and each receipt
lists one or more assets with its publisher URL, release, SHA-256, concrete format,
acquisition time, CRS/datum and exact polygonal coverage. Every file in `raw/`,
apart from the receipt itself and the pinned borough boundary, must be listed by an
asset; mosaics and normalized intermediates are rejected.

Receipts carry required source-specific policy: terrain carries the exact recorded
NYC EGM2008→EGM96 PROJ result and its hash; buildings and parts carry deterministic
selection, `overture-then-osm` priority, `missingHeight: reject`, and
`raisedStructure: retain-conflict`; CHMv2 height/mask records format, valid-zero,
nodata, mask-hole and OSM-fallback semantics. The 3DEP receipt retains transformed
controls and a residual report in `evidence/`. It begins with
`thresholdStatus: "unadmitted"`, which always blocks admission. Only the authority's
signed decision ID plus an approved numerical maximum can change it to `approved`.

On a Docker-capable host:

```sh
mkdir -p ~/shade-prep-data/{raw,proj}
docker build -f server/shadow-prep/Containerfile -t umbra-shadow-prep .
docker run --rm --entrypoint sh umbra-shadow-prep -lc 'node --version; gdalinfo --version; proj; projinfo --searchpaths'
docker run --rm --entrypoint sh -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep -lc 'sha256sum /opt/proj/us_nga_egm08_25.tif /opt/proj/us_nga_egm96_15.tif; cd /workspace/server/shadow-prep && npm test'
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep admit
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep controls
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep approve-controls NYC-DATUM-ROUNDTRIP-2026-09-13-R1 0.000000001
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj:/usr/share/proj umbra-shadow-prep receipts
```

`admit` downloads and freezes the DCP 26b boundary if it is absent, verifies its
pinned SHA-256 on every run, and rejects the region until every required source,
licence/rights, exact receipt, hash, mask, retained datum-control output/report and grid is locally present. It saves the exact `projinfo --bbox -74.26,40.49,-73.70,40.92 --grid-check known_available` result in external evidence and checks that terrain and control evidence use that result. Receipts live at
`raw/source-receipts.json` and conform to
`publication/source-receipts.schema.json`; an unrecorded extra file or an
unrecorded source is not admissible. `build` reads only admitted raw assets through
the GDAL/PROJ normalizer. It never accepts `normalized/*.json` as a production
input. Synthetic normalization is an exported test-fixture helper only. `verify`
rechecks the manifest, component hashes, decoded words and parent enclosure.

Raw source bytes, normalized inputs, build scratch and published generations are
all deliberately external to Git. Each command writes `evidence/` with command,
tool versions, hashes, byte counts, wall/CPU time, peak RSS, scratch and result.
The absence of a signed numerical datum-control residual threshold is intentionally
an admission blocker: retaining controls is evidence, not a physical-accuracy
result and not permission to begin item 6. Do not run `build` or `verify` as part
of Item 5.
