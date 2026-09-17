/**
 * The one solar convention used by numeric acquisition, CPU marching and a
 * future renderer.  The numeric fields intentionally retain SunCalc's
 * historical azimuth so existing fixtures cannot accidentally get mirrored.
 */
export const SOLAR_CONVENTION_VERSION = "nyc-solar-suncalc-shadow-v1";

export interface SolarPosition {
  /** SunCalc azimuth in radians: zero is south and positive rotates west. */
  azimuth: number;
  /** Geometric solar altitude above the horizon in radians. */
  altitude: number;
}

export interface FrozenSolarPosition extends SolarPosition {
  convention: typeof SOLAR_CONVENTION_VERSION;
}

export function freezeSolar(position: SolarPosition): FrozenSolarPosition {
  if (!Number.isFinite(position.azimuth) || !Number.isFinite(position.altitude))
    throw new Error("solar position must be finite");
  return { azimuth: position.azimuth, altitude: position.altitude, convention: SOLAR_CONVENTION_VERSION };
}

/** True only for a direct-sun calculation; twilight remains a distinct night result. */
export function isNight(sun: SolarPosition): boolean {
  return sun.altitude <= 0;
}

/** Unit vector from a receiver towards the source of light in east/north metres. */
export function sunwardDirection(sun: SolarPosition): { east: number; north: number } {
  // The established field fixtures treat SunCalc azimuth as the shadow vector.
  return { east: -Math.sin(sun.azimuth), north: -Math.cos(sun.azimuth) };
}

export function assertSolarConvention(value: string): asserts value is typeof SOLAR_CONVENTION_VERSION {
  if (value !== SOLAR_CONVENTION_VERSION) throw new Error("unsupported solar convention");
}
