import { readFile } from "node:fs/promises";
import {
  canonicalLicenceBinding,
  type RegionLicenceInput,
} from "../../../app/lib/shadowField/v2/artifacts";
import type { ComponentKind } from "../../../app/lib/shadowField/v2/types";
import { parseS3ObjectSpec, S3Store } from "./storage";
import { fileHash, sha256 } from "./util";

/**
 * Licence bindings for the v2 recipe. Boundary policy comes from the pinned
 * in-repo region file; admitted source rights and assets replace its source
 * intentions before the packer hashes canonical bindings into component
 * licenceHash values and publishes the same bindings in notices.json.
 */
export async function loadRegionLicenceInput(regionPath?: string): Promise<RegionLicenceInput> {
  const path =
    regionPath ?? new URL("../regions/new-york-city-v1.json", import.meta.url).pathname;
  const document = JSON.parse(await readFile(path, "utf8")) as {
    boundary?: { licence?: string; url?: string; release?: string; sha256?: string; localName?: string };
    sources?: Array<{ id?: string; kind?: string; licence?: string; url?: string }>;
  };
  if (
    !document.boundary?.licence ||
    !document.boundary.url ||
    !document.boundary.release ||
    !Array.isArray(document.sources)
  )
    throw new Error(`region file lacks boundary/sources: ${path}`);
  const sources = document.sources.map((source) => {
    if (!source.id || !source.kind || !source.licence || typeof source.url !== "string")
      throw new Error(`region file has an incomplete source record: ${path}`);
    return { id: source.id, kind: source.kind, licence: source.licence, url: source.url };
  });
  return {
    boundaryLicence: document.boundary.licence,
    boundaryUrl: document.boundary.url,
    boundaryRelease: document.boundary.release,
    sources,
    regionFileSha256: await fileHash(path),
  };
}

/**
 * Resolve public notice inputs from the admitted, hash-pinned receipt
 * manifest—not the region's source intentions.  The region still supplies
 * the boundary policy, while rights URLs, exact input roles/assets and the
 * installed NGA grid pins come exclusively from the admission evidence.
 */
export async function loadAdmittedLicenceInput(
  admissionSpec: string,
  regionPath?: string,
): Promise<RegionLicenceInput> {
  const base = await loadRegionLicenceInput(regionPath);
  let rawBytes: Uint8Array;
  if (admissionSpec.startsWith("s3:")) {
    const { bucket, key } = parseS3ObjectSpec(admissionSpec);
    rawBytes = await new S3Store(bucket).read(key);
  } else {
    rawBytes = new Uint8Array(await readFile(admissionSpec));
  }
  const raw = new TextDecoder().decode(rawBytes);
  const manifest = JSON.parse(raw) as {
    receipts?: Array<{ id?: string; role?: string; licence?: string; rights?: string; assets?: Array<{ filename?: string; sha256?: string; publisherUrl?: string; release?: string }> }>;
    datum?: { grids?: string[]; gridHashes?: Record<string, string> };
    blockers?: unknown[];
  };
  if (!Array.isArray(manifest.receipts) || (manifest.blockers !== undefined && !Array.isArray(manifest.blockers)) || manifest.blockers?.length)
    throw new Error(`admission manifest is not admitted: ${admissionSpec}`);
  const required = new Set(["fabdem-v1.2", "overture-buildings", "overture-building-parts", "chmv2-height", "chmv2-validity-mask", "osm-tree-fallback", "usgs-3dep-controls"]);
  const sources = manifest.receipts.map((receipt) => {
    if (!receipt.id || !receipt.role || !receipt.licence || !receipt.rights || !Array.isArray(receipt.assets) || !receipt.assets.length)
      throw new Error(`admission manifest has incomplete receipt ${String(receipt.id)}`);
    const assets = receipt.assets.map((asset) => {
      if (!asset.filename || !asset.publisherUrl || !asset.release || !asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256))
        throw new Error(`admission manifest has incomplete receipt asset ${receipt.id}`);
      return { filename: asset.filename, publisherUrl: asset.publisherUrl, release: asset.release, sha256: asset.sha256 };
    });
    return { id: receipt.id, kind: receipt.role, licence: receipt.licence, url: receipt.rights, rights: receipt.rights, role: receipt.role, assets };
  });
  if (![...required].every((id) => sources.some((source) => source.id === id)) || new Set(sources.map((source) => source.id)).size !== sources.length)
    throw new Error("admission manifest lacks a required notice receipt");
  const grids = manifest.datum?.grids;
  const gridHashes = manifest.datum?.gridHashes;
  if (!Array.isArray(grids) || !gridHashes || grids.length !== 2 || new Set(grids).size !== grids.length || grids.some((name) => typeof name !== "string" || !name))
    throw new Error("admission manifest lacks installed NGA grid pins");
  const datumGrids = grids.map((name) => {
    const sha256 = gridHashes[name];
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) throw new Error(`admission manifest lacks grid hash ${name}`);
    return { name, sha256 };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { ...base, sources, receiptManifestSha256: sha256(rawBytes), datumGrids };
}

export function loadRegionDocument(regionPath?: string): Promise<{
  boundarySha256: string;
  boundaryLocalName: string;
  input: RegionLicenceInput;
}> {
  return (async () => {
    const path =
      regionPath ?? new URL("../regions/new-york-city-v1.json", import.meta.url).pathname;
    const document = JSON.parse(await readFile(path, "utf8")) as {
      boundary?: { sha256?: string; localName?: string };
    };
    if (!document.boundary?.sha256 || !document.boundary.localName)
      throw new Error(`region file lacks the pinned boundary record: ${path}`);
    return {
      boundarySha256: document.boundary.sha256,
      boundaryLocalName: document.boundary.localName,
      input: await loadRegionLicenceInput(path),
    };
  })();
}

export function licenceHashFor(kind: ComponentKind, input: RegionLicenceInput, hash: (value: string) => string): string {
  return hash(canonicalLicenceBinding(kind, input));
}
