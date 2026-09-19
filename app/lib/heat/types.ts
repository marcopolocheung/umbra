/**
 * The contract Track D publishes: one hour of weather, from one cached fetch,
 * shared by every consumer that needs more than a shadow fraction.
 *
 * Every measured field is nullable, deliberately. Open-Meteo can omit a variable,
 * a cached response can predate a field being requested, and "absent" has to stay
 * distinguishable from "zero" — a dose computed from a fabricated `uvIndex: 0`
 * would read as a safe hour rather than an unknown one, which is exactly the
 * false confidence this track's honesty guardrail exists to prevent.
 */
export interface WeatherHour {
  time: Date;
  uvIndex: number | null;
  tempC: number | null;
  humidityPct: number | null;
  windMs: number | null;
  /**
   * Wind-from bearing, degrees — the meteorological convention Open-Meteo reports,
   * and the azimuth the rain shelter field feeds through as its ray direction.
   */
  windDirDeg: number | null;
  /** Peak gust in m/s, same unit as `windMs`. Display-only for now. */
  windGustMs: number | null;
  cloudPct: number | null;
  apparentTempC: number | null;
  /**
   * Global horizontal shortwave irradiance, W/m².
   *
   * The radiant-load variable. UV index is not a stand-in for it: the UV share of
   * global shortwave swings from ~3.1% in January to ~7.8% in June, so a penalty
   * scaled by UV would under-weight winter sun by more than a factor of two.
   * It is also the input Open-Meteo's own apparent temperature uses, which is what
   * lets a consumer take that term back out. See docs/notes/heat-score.md.
   */
  shortwaveWm2: number | null;
}

/** Fitzpatrick phototype. The only profile input D3 needs; D5 adds the rest. */
export type SkinType = "I" | "II" | "III" | "IV" | "V" | "VI";

export interface UserProfile {
  skinType: SkinType;
}

/** Every estimate this track shows is an interval, never a point value. */
export interface Range {
  low: number;
  high: number;
}

/**
 * A UV dose estimate for one trip. Ranges throughout, because the inputs are
 * ranges — chiefly the share of ambient UV still reaching you in building shadow.
 *
 * `sed` and `fullSunEquivalentMinutes` are physical quantities and describe the
 * trip. `burnFraction` describes a *person*, and is null unless a caller supplies
 * a real profile: see `dose()` for why nothing may default one into existence.
 */
export interface SunDose {
  /** Standard erythemal doses accumulated on this trip. 1 SED = 100 J/m². */
  sed: Range;
  /**
   * The same dose expressed as minutes of unbroken full sun at this UV index.
   *
   * Person-independent, and the only figure this app displays: it says how much
   * sun the trip is worth without asserting anything about whose skin it lands on.
   */
  fullSunEquivalentMinutes: Range;
  /**
   * Dose as a share of one minimal erythemal dose. **Null without a profile**, and
   * weakly founded even with one — Fitzpatrick type correlates with MED at only
   * r ≈ 0.5–0.69. See docs/notes/heat-model.md before showing this to anyone.
   */
  burnFraction: Range | null;
  uncertainty: "low" | "medium" | "high";
  /** Versioned so the UI can link to the method that produced this number. */
  method: "sed-uvi-v1";
}
