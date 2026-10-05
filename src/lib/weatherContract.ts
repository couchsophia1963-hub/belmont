/**
 * The weather value contract, in one place.
 *
 * Issue: BEL-15. The `icon` column shipped as free text and took an NWS icon URL
 * once, because the seven valid codes existed in two places that could drift
 * apart and a third place (the database) that did not check at all. Every
 * consumer now reads this file, and the database enforces the same list in
 * `20261005140000_weather_forecasts_deferred_fields.sql`.
 *
 * If you change a list here, change the CHECK constraint in the same change.
 */

/** The seven values `icon` may hold. Matches the DB CHECK constraint. */
export const VALID_ICON_CODES = [
  'sun',
  'cloud',
  'cloud-sun',
  'cloud-rain',
  'cloud-snow',
  'cloud-lightning',
  'cloud-fog',
] as const;

/** The ten values `wind_direction` may hold. Matches the DB CHECK constraint. */
export const WIND_DIRECTIONS = [
  'N',
  'NE',
  'E',
  'SE',
  'S',
  'SW',
  'W',
  'NW',
  'Variable',
  'Calm',
] as const;

/** The eight conditions the admin panel offers. Free text in the database. */
export const CONDITION_OPTIONS = [
  'Sunny',
  'Partly Cloudy',
  'Cloudy',
  'Showers',
  'Rain',
  'Thunderstorms',
  'Snow',
  'Fog',
] as const;

export function isValidIconCode(value: string): boolean {
  return (VALID_ICON_CODES as readonly string[]).includes(value);
}

export function isValidWindDirection(value: string): boolean {
  return (WIND_DIRECTIONS as readonly string[]).includes(value);
}
