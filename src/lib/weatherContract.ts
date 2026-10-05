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

/**
 * What `weather_forecasts.humidity` means, in the words the reader sees.
 *
 * Issue: BEL-190. The published value is the peak `relativeHumidity` inside the
 * 06:00-18:00 window, not the humidity of the day. QA measured 96 % at 08:00 EDT
 * on 2026-10-05 against a day mean of 69 %, so the bare "%" the strip used to
 * print beside "Sunny 67" read as a description of the whole afternoon.
 *
 * The value is correct and stays. Only the presentation was wrong, so the fix is
 * to name the number and its basis, not to republish the mean.
 *
 * The database has no counterpart yet: `humidity` carries no
 * `comment on column` stating the window. That half needs a migration, and
 * migrations are blocked until a SQL route exists, so the basis lives on the
 * read side only for now. Add the column comment in the same change when the
 * migration route is open.
 */
export const HUMIDITY_BASIS_SHORT = 'daytime peak';

export const HUMIDITY_BASIS_LONG =
  'Daytime peak humidity: the highest reading from 6 a.m. to 6 p.m., not the average for the day.';
