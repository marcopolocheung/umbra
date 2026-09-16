import { SUPPORT_KNOWN } from "./support";
import { COMPONENT_FLAGS, type Component } from "./types";

export const TreeModelV2 = {
  version: "tree-model-v2",
  undersidePriorNumerator: 35,
  undersidePriorDenominator: 100,
  trunkModel: "omitted" as const,
  leafOnTransmission: 0.1,
  leafOffTransmission: 0.7,
};
export interface Crown {
  baseQ: number;
  topQ: number;
  flags: number;
  provenance: number;
}
function plane(component: Component | undefined, name: string): Uint32Array | undefined {
  return component?.planes.find((item) => item.name === name)?.words;
}
function signed(words: Uint32Array | undefined, index: number): number {
  return words?.[index] === undefined ? 0 : words[index] | 0;
}

/** Native positive raster wins. A valid zero mask is absence; fallback is only for unavailable/nodata support. */
export function composeCrown(
  index: number,
  canopy: Component | undefined,
  groundQ: number,
  roofQ: number,
): Crown | undefined {
  if (!canopy || canopy.support === "known-empty" || canopy.support === "nodata") return undefined;
  const nativeMask = plane(canopy, "canopyMask");
  const nativeHeight = plane(canopy, "canopyHeightAglQ") ?? plane(canopy, "crownTopAglQ");
  const nativeBase = plane(canopy, "canopyBaseAglQ") ?? plane(canopy, "crownBaseAglQ");
  const support = plane(canopy, "canopySupport");
  const nativeAvailable = support ? support[index] === SUPPORT_KNOWN : true;
  const nativePresent =
    nativeAvailable && (nativeMask ? nativeMask[index] !== 0 : signed(nativeHeight, index) > 0);
  const fallbackMask = plane(canopy, "fallbackCanopyMask");
  const fallbackTop = plane(canopy, "fallbackCrownTopAglQ");
  const fallbackBase = plane(canopy, "fallbackCrownBaseAglQ");
  const fallbackId = plane(canopy, "fallbackFeatureId");
  const fallbackPresent =
    !nativeAvailable &&
    !!fallbackTop &&
    (fallbackMask ? fallbackMask[index] !== 0 : signed(fallbackTop, index) > 0);
  if (!nativePresent && !fallbackPresent) return undefined;
  const topAgl = nativePresent ? signed(nativeHeight, index) : signed(fallbackTop, index);
  if (topAgl <= 0) return undefined;
  const suppliedBase = nativePresent ? signed(nativeBase, index) : signed(fallbackBase, index);
  const inferred = suppliedBase <= 0;
  let baseQ =
    groundQ +
    (inferred
      ? Math.round(
          (topAgl * TreeModelV2.undersidePriorNumerator) / TreeModelV2.undersidePriorDenominator,
        )
      : suppliedBase);
  const topQ = groundQ + topAgl;
  if (topQ <= roofQ) return undefined;
  if (baseQ < roofQ) baseQ = roofQ;
  if (baseQ >= topQ) return undefined;
  return {
    baseQ,
    topQ,
    flags:
      (inferred ? COMPONENT_FLAGS.canopyInferredBase : 0) |
      (fallbackPresent ? COMPONENT_FLAGS.canopyFallback : 0),
    provenance: fallbackPresent ? (fallbackId?.[index] ?? 0) : 0,
  };
}
