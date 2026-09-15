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

## Batch uploader credentials

The uploader uses R2's S3-compatible API, not the public Worker endpoint.
Create a dedicated **R2 Object Read & Write** token scoped only to this bucket,
put its access-key id and secret in AWS Secrets Manager, and inject them into
the Batch job as `SHADE_PACK_R2_ACCESS_KEY_ID` and
`SHADE_PACK_R2_SECRET_ACCESS_KEY`. Never put
either credential in this repository, a Batch command override, or a report.
