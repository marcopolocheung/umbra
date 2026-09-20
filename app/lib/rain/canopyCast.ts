/**
 * Canopy shadow cast for the renderer — the same elevated-caster endpoints the
 * shadow index uses, spelled as flat triangle lists the painter can upload.
 *
 * A crown starts on top of a trunk, so its near ring is displaced by
 * `baseM / tan(altitude)` before the remaining height sweeps onward; vertical
 * rain displaces nothing and the crown lands on its own footprint.
 */

import {
  type BuildingPrism,
  buildShadowTriangles,
} from "../shadowField/geometry";

/** The whole shadow-triangle list for a rain canopy caster, [lng, lat] pairs. */
export function canopyShadowTriangles(
  prism: BuildingPrism,
  azRad: number,
  altRad: number,
  mPerLat: number,
  mPerLng: number,
): Array<[number, number]> {
  const tanAlt = Math.tan(altRad);
  if (!Number.isFinite(tanAlt) || tanAlt <= 0) return [];

  const baseM = prism.baseM ?? 0;
  const hasBase = baseM > 0 && Number.isFinite(baseM);
  const shiftRing = (lenM: number): [number, number][] =>
    prism.ring.map(
      ([lng, lat]) =>
        [lng + (Math.sin(azRad) * lenM) / mPerLng,
         lat + (Math.cos(azRad) * lenM) / mPerLat] as [number, number],
    );

  return buildShadowTriangles(
    hasBase ? shiftRing(baseM) : prism.ring,
    hasBase ? prism.heightM - baseM : prism.heightM,
    azRad,
    altRad,
    mPerLat,
    mPerLng,
    [],
  );
}
