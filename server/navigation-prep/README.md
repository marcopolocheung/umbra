# NYC navigation preparation

Builds the static NYC walking graph and building-prism dataset the browser
loads (`app/lib/navigationData/`) from two pinned offline sources:

- **Streets:** a dated Geofabrik New York State `.osm.pbf`, filtered with the
  exact Overpass highway query the app already uses, clipped to a buffered NYC
  boundary, and sharded with original OSM node ids plus ghost seam endpoints.
- **Buildings:** the maintained NYC Building Footprints feature service
  (DOITT_ID key, weekly releases), downloaded once as an ordered page set,
  normalized through the documented feature/status/height policy, and
  published whole per footprint with caster-reach support bounds.

Everything heavy lives outside git under `NAVIGATION_PREP_ROOT`. The repo
contains only code, the small committed fixture, and this contract.

## Commands

```sh
export NAVIGATION_PREP_ROOT=$HOME/shade-prep-data-nyc-navigation   # absolute, outside git
npm install

npm run plan           # pinned source URLs and the prep-root layout; no network writes
npm run acquire:plan   # HEAD/count checks; no writes
npm run acquire        # download PBF + all building pages, write raw/source-receipts.json
npm run validate       # receipts vs bytes, page counts, ordered OBJECTID pagination
npm run normalize      # PBF → work/streets.json; pages → work/buildings.ndjson (+ stats)
npm run build          # shards + notices + manifest + pointer candidate (default --grid z14)
npm run build:dry      # same, no writes
npm run verify         # re-reads final serialized bytes only (see src/verify.ts)
npm run publish        # verification + upload plan; no bucket, no credentials, no writes
npm run publish:execute    # upload the generation to R2 and promote current.json
npm test               # hermetic node:test suite + vitest parity suite
```

`publish --rollback <generation>` (or `npm run publish:rollback -- <generation>`)
re-promotes a retained generation by uploading only its verified pointer —
shards are never deleted, so any earlier promotion is one pointer away.

## Publishing to R2

`publish` follows the transit pipeline's S3-compatible R2 upload, under the
`navigation/nyc/` prefix (part of the wire contract, not configuration):

```sh
export NAVIGATION_PREP_ROOT=$HOME/shade-prep-data-nyc-navigation
export R2_ACCOUNT_ID=…          # account id
export R2_ACCESS_KEY_ID=…       # dedicated R2 object read/write token for the bucket only
export R2_SECRET_ACCESS_KEY=…   # never committed, never in the report
export R2_NAVIGATION_BUCKET=shademap-nyc-navigation-staging
export R2_PUBLIC_BASE=https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev
```

`publish --execute <generation?>` is ordered so a failure at any point leaves
the previous pointer serving:

1. re-runs the independent verifier over final serialized bytes only;
2. uploads every immutable object — manifest, notices, street shards, building
   shards — resuming past any identical stored copy (ETag + size match);
3. re-downloads one street and one building shard per borough
   (all five boroughs) and proves stored bytes equal the manifest's exact
   byte counts and SHA-256;
4. reconciles the bucket inventory under the generation prefix against the
   local verifier's object count, bytes, and per-key hash;
5. promotes `navigation/nyc/current.json` strictly last, then verifies the
   promoted pointer by re-download.

Every run writes a publication report under `$NAVIGATION_PREP_ROOT/evidence/`
(mode, generation, public base, manifest/pointer SHA-256, object counts and
bytes, specimens, reconciliation, the previous pointer, and the exact
rollback command). `publish --execute` also records the promoted pointer at
`normalized/<generation>/current.json` next to its candidate.

Browsers reach the data through the existing delivery Worker
(`cloudflare/shadow-data-worker/`), which serves `navigation/nyc/**` from the
private `shademap-nyc-navigation-staging` bucket through the same origin as
`_shadow/**`. The bucket stays private and is written only through this
uploader.

`tsx measure-grids.ts <generation> …` re-derives the z13/z14 selection
measurement cited in the decision record; `build --dry-run --report-only`
recomputes a generation identity and budget sizes without writing files —
identical inputs must reproduce the committed generation id and bytes.


Every mutating command writes `evidence/<command>-<timestamp>.json` under the
root. Data layout:

```
raw/new-york-260918.osm.pbf        raw/buildings-pages/#####.json   raw/source-receipts.json
work/streets.json                  work/buildings.ndjson
normalized/<generation>/navigation/nyc/<generation>/{manifest,notices,streets/*,buildings/*}
normalized/<generation>/pointer-candidate.json
evidence/*.json
```

## Budgets and policies

The generation must pass the per-shard and total envelopes in
`app/lib/navigationData/shardContract.ts`; the verifier additionally enforces
a per-request byte budget over the retained borough samples
(`src/boundary.ts`). Budget decisions and the z13/z14 grid measurement live in
`docs/notes/nyc-navigation-data-city.md`. Building policy (feature/status,
height fallback, ring repair) is implemented once in
`src/buildings.ts` and mirrored in every generation's `notices.json`.

## Attribution

The published generation carries `© OpenStreetMap contributors`, the ODbL
link, the NYC Open Data terms link, and source notes naming both pinned
receipts. A NYC Open Data derived-database offer travels with the generation.
