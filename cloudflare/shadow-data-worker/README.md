# Private NYC shadow-data staging Worker

This Worker exposes only browser-packed, immutable `.smb` tiles from a private
R2 bucket. It never exposes `normalized/` candidates, raw sources, bucket
listing, or write operations.

`ALLOWED_ORIGIN` is pinned to the current deployed web app,
`https://shademapnav.vercel.app`. Change it only when the web app moves.

After authenticating the Cloudflare CLI in a terminal, create and deploy the
staging resources:

```bash
cd cloudflare/shadow-data-worker
npx wrangler login
npx wrangler r2 bucket create shademap-nyc-shadow-staging
npx wrangler deploy
```

The Worker endpoints are:

```text
/_shadow/current.json
/_shadow/generations/nyc-<normalization-id>/manifest.json
/_shadow/generations/nyc-<normalization-id>/tiles/18-<x>-<y>.smb
```

`current.json` is short-cached for rollout, while generation tile objects are
immutable and cacheable for one year. Upload a complete immutable generation
first; update `current.json` only after its manifest and every tile have been
verified.

## PR1 scope: read-only staging checks, no browser consumer yet

PR1 lands this Worker and the catalog/bundle transport tested but uncalled: no
app code fetches `current.json`, tiles, or the manifest, so there are zero new
browser requests. Verify the existing staging deployment with read-only `curl`
(no `wrangler deploy`, no R2 writes, no `current.json` promotion in this PR):

```bash
BASE=https://shademap-nyc-shadow-staging.marcoctpolo.workers.dev
curl -fsSI -H 'Origin: https://shademapnav.vercel.app' "$BASE/_shadow/current.json"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/_shadow/current.json" # 405
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/_shadow/normalized/private-object" # 404
curl -sSI -H 'Origin: http://localhost:5173' "$BASE/_shadow/current.json" # no ACAO header
```

Catalog unit tests use mocked `fetch`. A Vite same-origin dev proxy lands with
PR3, when the first lazy browser consumer exists.

## Batch uploader credentials

The uploader uses R2's S3-compatible API, not the public Worker endpoint.
Create a dedicated **R2 Object Read & Write** token scoped only to this bucket,
put its access-key id and secret in AWS Secrets Manager, and inject them into
the Batch job as `SHADE_PACK_R2_ACCESS_KEY_ID` and
`SHADE_PACK_R2_SECRET_ACCESS_KEY`. Never put
either credential in this repository, a Batch command override, or a report.
