# Shadow Engine v2 component tile format v1

This is the byte contract implemented by `app/lib/shadowField/v2/format.ts`. It
describes synthetic and future admitted objects; it makes no measurement or
physical-accuracy claim.

## Framing

An object is `header || UTF-8 JSON directory || gzip payload`. The fixed 16-byte
little-endian header is: bytes 0–3 ASCII `SMV2`; 4–5 `u16` format version `1`;
6–7 `u16` header flags `0`; 8–11 `u32` directory length; 12–15 reserved zero.
The directory starts immediately at byte 16 and its `payloadOffset` must equal
`16 + directory length`; `payloadLength` must exactly consume the object. Unknown
magic/version/header flags, codec, predictor, framing values, table indices,
overlapping ranges, truncation, checksum failure, or an output above the decoded
limit are rejection conditions.

`logicalSize` is 256; `storedSize` is 258; `gutter` is 1; `zoom` is 18;
`terrainDiagonal` is `nw-se`; `byteOrder` is `little-endian-u32`; and
`quantization` is 64 integers/metre. The stored gutter is real adjacent support,
not extrapolation. Every plane is 258×258 `u32` words (266,256 bytes); `i32`
values use two's complement. Heights are quantized once from Float64 by
`round(64 * metres)` and must be finite and within ±100,000 m. Zero and negative
values are valid.

One gzip stream (identifier `gzip`, encoder parameter `level:6` in the fixture
writer) contains concatenated transformed planes. Browser decoding uses
`DecompressionStream("gzip")`; encoding receives an injected compressor, so the
browser format module has no Node import. The reader counts streamed output before
allocating a plane view and caps it at 2,130,048 bytes (eight stored planes).

## Directory and identity

The directory contains `version`, `kind`, `identity`, `support`, compact
`evidence`, indexed `tables`, layout fields above, `codec`, `headerFlags`, payload
range, and ordered `planes`. Identity includes generation, z18 tile key,
source/recipe/datum/hierarchy/licence hashes and optional normalizer/compositor/
tree-model/receiver hashes. A generation manifest repeats generation, recipe,
datum and hierarchy hashes and lists each `(kind,tile,source,licence,object)`.
`validateManifestDependencies` requires exactly one matching listed object for
each decoded component. Transport SHA-256 hashes the complete object; physics
SHA-256 hashes canonical unpredicted words, so codec/predictor changes do not
change physics identity.

`tables.licences`, `tables.provenance`, and `tables.evidence` each have unique
nonempty IDs. Plane `provenanceTableIndex` indexes provenance and
`materialTableIndex` indexes the licence/material record selected by the recipe.
Component support is `present`, `known-empty`, `nodata`, or `unknown`; unknown
never means empty.

Terrain objects own `groundQ`, terrain-derived `foundationQ`, and
`foundationPresent`. Building objects own AGL roof, occupancy, stable feature ID,
and priority. Canopy objects own native AGL height/base/mask/support and separate
fallback inputs. They do not contain terrain-derived absolute roofs or crowns.
`flagsAndMaterial` and `provenanceIndex` are source metadata inputs. The six
canonical planes are a worker-only composition result.

For every directory plane: `name`, `type` (`i32` or `u32`), `predictor`, decoded
offset/length, optional table indices and SHA-256 `checksum` are required. Planes
are named, rather than inferred from position. `none` stores canonical words.
`horizontal-delta-u32` stores the first word of each row, then
`current-left modulo 2^32`; it resets for every row and every band. Checksum is
over decoded canonical little-endian words including all borders.

## Annotated golden object

This reduced illustration explains directory semantics; an on-wire v1 plane still
has 258 rows and 258 columns.

```json
{
  "version":1, "kind":"terrain", "logicalSize":256, "storedSize":258,
  "gutter":1, "zoom":18, "terrainDiagonal":"nw-se",
  "byteOrder":"little-endian-u32", "quantization":64, "codec":"gzip",
  "payloadOffset":16 + directoryBytes, "payloadLength":gzipBytes,
  "planes":[
    {"name":"groundQ","type":"i32","predictor":"horizontal-delta-u32",
     "decodedOffset":0,"decodedLength":266256,"checksum":"sha256(canonical)"},
    {"name":"foundationPresent","type":"u32","predictor":"none",
     "decodedOffset":266256,"decodedLength":266256,"checksum":"sha256(canonical)"}
  ]
}
```

For an illustrative first row of `groundQ` canonical words
`[-64, -64, 0, 64]`, the predicted little-endian `u32` words are
`[0xffffffc0, 0x00000000, 0x00000040, 0x00000040]`. The first word of the next
row is its canonical word again, not a delta from this row. For
`foundationPresent` canonical `[1, 0, 0xffffffff, 0]`, `none` emits exactly those
four words. A second implementation can therefore locate, gunzip, range-check,
inverse-predict, type-interpret and checksum each plane without knowing its
producer.
