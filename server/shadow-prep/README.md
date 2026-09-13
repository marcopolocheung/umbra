# Local NYC shadow preparation

This package creates **local-only**, immutable, source-separated preparation
generations. It does not deploy, upload, activate the app, or make a physical
accuracy claim. Node 24, GDAL and PROJ are intentionally container-only.

Create an external data directory (never a directory inside this repository), then
place the pinned raw assets under `raw/` using the names in the region manifest.
Install the two pinned NGA files in `~/shade-prep-data/proj`; this directory is
read-only in the container. `source-receipts.json` must contain exactly the twelve
receipt IDs, each with an immutable release/URL/hash, rights URL, support extent,
CRS, vertical reference and acquisition time. CHMv2 height and mask receipts must
declare valid-zero and nodata semantics. The 3DEP receipt also records its retained
control-transform output and explicitly marks the numerical residual threshold as
`unadmitted`:

```sh
mkdir -p ~/shade-prep-data/{raw,proj}
docker build -f server/shadow-prep/Containerfile -t umbra-shadow-prep .
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj umbra-shadow-prep admit
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj umbra-shadow-prep build
docker run --rm -v "$HOME/shade-prep-data:/data" -v "$HOME/shade-prep-data/proj:/opt/proj:ro" -e PROJ_DATA=/opt/proj umbra-shadow-prep verify
```

`admit` downloads and freezes the DCP 26b boundary if it is absent, verifies its
pinned SHA-256 on every run, and rejects the region until every required source,
licence/rights, exact receipt, hash, mask, retained datum-control output and grid is locally present. Receipts live at
`raw/source-receipts.json` and conform to
`publication/source-receipts.schema.json`; an unrecorded extra file or an
unrecorded source is not admissible. `build` reads only admitted raw assets through
the GDAL/PROJ normalizer. It never accepts `normalized/*.json` as a production
input. Synthetic normalization is an exported test-fixture helper only. `verify`
rechecks the manifest, component hashes, decoded words and parent enclosure.

Raw source bytes, normalized inputs, build scratch and published generations are
all deliberately external to Git. Each command writes `evidence/` with command,
tool versions, hashes, byte counts, wall/CPU time, peak RSS, scratch and result.
The current absence of a preregistered numerical datum-control residual threshold
is intentionally an admission blocker: retaining controls is evidence, not a
physical-accuracy result and not permission to begin item 6.
