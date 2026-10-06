/**
 * The `geotiff.js` half of `CanopyTileStore` — one published COG, opened once and
 * read block-aligned.
 *
 * The store above it owns every policy (what to cache, what to dedupe, when to
 * retry, what to cancel) and this owns none of them, which is what lets the store's
 * behaviour be tested in `environment: "node"` against a fake source with no
 * network. Everything here is a thin translation of the COG's own structure.
 *
 * The one judgement it does make is reading the **validity mask** alongside the
 * heights. A8a read only the height band, where `0` means "no canopy detected" and
 * a nodata stamp looks exactly the same; A8c's histogram argued from the shape of
 * the distribution that building interiors are model output rather than blanked,
 * and said plainly that was evidence and not proof. The mask is the proof, it costs
 * almost nothing (1 bit per pixel, deflated, over an image that is nearly all
 * ones), and the consumer that needs it is the one being built on top of this.
 */

import {
  type BlockedSourceOptions,
  type GeoTIFF,
  type GeoTIFFImage,
  type RemoteSourceOptions,
  fromUrl,
} from "geotiff";
import { CANOPY_COG_BASE_URL, listCanopyLevels } from "./canopyCog";
import type { MercatorBbox, OverviewCandidate, PixelWindow } from "./tiles";

/** The block grid of one overview level. */
export interface LevelGrid {
  width: number;
  height: number;
  /** The COG's internal tiling — 512 in this dataset, read off the file regardless. */
  blockSize: number;
}

/** Heights and validity over one pixel window, row-major, north-west origin. */
export interface CanopyWindowPixels {
  /** Canopy height in whole metres. `0` is "no canopy", not "no data". */
  heights: Uint8Array;
  /**
   * `1` where the model produced an answer, `0` where the raster is blank.
   *
   * `null` means every pixel in the window is valid, which is the ordinary case
   * over land and worth not allocating a megabyte to say.
   */
  valid: Uint8Array | null;
}

/** One published zoom 10 COG, opened. */
export interface CanopyTileHandle {
  quadkey: string;
  /** The geotransform, in EPSG:3857 metres. Every level covers this same extent. */
  tileBbox: MercatorBbox;
  /** Height levels only — the mask IFDs are paired internally and never selectable. */
  levels: OverviewCandidate[];
  grid(levelIndex: number): Promise<LevelGrid>;
  read(
    levelIndex: number,
    window: PixelWindow,
    signal?: AbortSignal,
  ): Promise<CanopyWindowPixels>;
}

/**
 * How `geotiff.js` fetches bytes: in aligned 64 KiB blocks, through its own cache (#290).
 *
 * Left unset, `fromUrl` hands back an unwrapped remote source, and every read the
 * library makes becomes its own HTTP range request — including the two **4-byte**
 * reads of `TileOffsets[i]` and `TileByteCounts[i]` it makes before every tile, and
 * each hop of the IFD chain on open. A route-sized read was 43-55 sequential requests
 * moving 100-185 KB, and it took 6-8.5 s because each one costs a round trip to
 * `source.coop`. Blocked, neighbouring reads land in the same block and consecutive
 * missing blocks are fetched as one range, so the same read is **5-6 requests and
 * 0.9-1.9 s** for ~2-3x the bytes, with byte-identical pixels
 * (`docs/notes/canopy-raster-shadow-field-2026-09-10.md`).
 *
 * 64 KiB is the library's own default block, and it measured faster than 16 KiB:
 * fewer, larger requests win when the cost is latency rather than bandwidth.
 *
 * `cacheSize` is in blocks, and it is not a tuning knob so much as a floor. Every
 * `BlockedSource.fetch` clears the blocks evicted during the previous one, so a
 * single read whose blocks outnumber the cache can lose one it still needs to a read
 * starting alongside it, and fail. The largest area `createRasterCanopyProvider`
 * will ask for — a ~5.7 km square at Singapore's 1.19 m pixel — fetched ~3.1 MB,
 * about 48 blocks, against these 100. The cache holds compressed bytes that
 * `CanopyTileStore` also holds decoded, so the duplication is real but ~7x smaller
 * than the store's own budget, and it is what the offsets arrays and IFDs are
 * re-read from on every later read of the same tile.
 *
 * Typed as the intersection because `fromUrl`'s published signature names only
 * `RemoteSourceOptions`, while its runtime forwards the rest to `BlockedSource` —
 * `makeFetchSource` spreads them into `maybeWrapInBlockedSource` (geotiff 3.0.5). That
 * gap in the typings is how an untyped `{}` read as the complete set of options.
 */
const COG_FETCH_OPTIONS: RemoteSourceOptions & BlockedSourceOptions = {
  blockSize: 64 * 1024,
  cacheSize: 100,
};

/** Where `CanopyTileStore` gets its tiles. Faked wholesale in the store's tests. */
export interface CanopyTileSource {
  open(quadkey: string, signal?: AbortSignal): Promise<CanopyTileHandle>;
}

export function createCogTileSource(opts: {
  baseUrl?: string;
  /**
   * How to turn a `baseUrl/quadkey.tif` reference into a `GeoTIFF`.
   *
   * Defaults to `fromUrl` with the block-aligned fetch options — the browser's
   * live path. The offline shade producer overrides it to open the same
   * `{quadkey}.tif` files from a local directory, so the store above this file
   * stitches, masks and caches the local tiles through exactly the code the app
   * runs in production. Nothing else differs.
   */
  openTiff?: (url: string, signal?: AbortSignal) => Promise<GeoTIFF>;
} = {}): CanopyTileSource {
  const baseUrl = opts.baseUrl ?? CANOPY_COG_BASE_URL;
  const openTiff =
    opts.openTiff ?? ((url: string, signal?: AbortSignal) => fromUrl(url, COG_FETCH_OPTIONS, signal));

  return {
    async open(quadkey, signal) {
      const tiff = await openTiff(`${baseUrl}/${quadkey}.tif`, signal);
      const { tileBbox, heights, masks } = await listCanopyLevels(tiff);
      return createHandle(tiff, quadkey, tileBbox, heights, masks);
    },
  };
}

function createHandle(
  tiff: GeoTIFF,
  quadkey: string,
  tileBbox: MercatorBbox,
  heights: OverviewCandidate[],
  masks: OverviewCandidate[],
): CanopyTileHandle {
  return {
    quadkey,
    tileBbox,
    levels: heights,

    async grid(levelIndex) {
      const image = await tiff.getImage(levelIndex);
      const blockSize = image.getTileWidth();
      if (image.getTileHeight() !== blockSize) {
        // Everything downstream indexes a square block grid. The published
        // dataset is tiled 512x512; a strip-organised republication would need a
        // different reader, and should say so here rather than read the wrong rows.
        throw new Error(
          `canopy COG ${quadkey} level ${levelIndex} is tiled ${blockSize}x${image.getTileHeight()}, not square`,
        );
      }
      return { width: image.getWidth(), height: image.getHeight(), blockSize };
    },

    async read(levelIndex, window, signal) {
      const image = await tiff.getImage(levelIndex);
      const heights = await readBand(image, window, signal);

      // Paired by width, never by index: the published IFD order is image 0, its
      // mask, the height overviews, then their masks, so the mask of a level sits
      // at no fixed offset from it. See `listCanopyLevels`.
      const level = findByWidth(masks, image.getWidth());
      if (!level) return { heights, valid: null };

      const maskImage = await tiff.getImage(level.index);
      const raw = await readBand(maskImage, window, signal);
      return { heights, valid: normaliseMask(raw) };
    },
  };
}

function findByWidth(
  levels: OverviewCandidate[],
  width: number,
): OverviewCandidate | undefined {
  return levels.find((level) => level.width === width);
}

async function readBand(
  image: GeoTIFFImage,
  window: PixelWindow,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const rasters = await image.readRasters({ window, signal });
  const band = Array.isArray(rasters) ? rasters[0] : rasters;
  if (!(band instanceof Uint8Array)) {
    throw new Error(
      `expected a uint8 band, got ${(band as ArrayLike<number>).constructor?.name ?? typeof band}`,
    );
  }
  return band;
}

/**
 * Reduce a decoded mask to 0/1, and to `null` when it is entirely valid.
 *
 * The 1-bit mask arrives as ones or as 255s depending on how the level was
 * written, and over most of the world it is uniformly set — so the scan pays for
 * itself the moment it lets a block hold heights alone instead of twice its size.
 */
function normaliseMask(raw: Uint8Array): Uint8Array | null {
  let allValid = true;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      allValid = false;
      break;
    }
  }
  if (allValid) return null;

  const valid = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) valid[i] = raw[i] === 0 ? 0 : 1;
  return valid;
}
