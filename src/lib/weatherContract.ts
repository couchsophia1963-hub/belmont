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

/**
 * What `weather_forecasts.precipitation_chance` means, in the words the reader sees.
 *
 * Issue: BEL-201, ruled by QA on BEL-195. Same defect shape as BEL-190 one level
 * along: the strip printed a bare `20%` next to a rain icon with no label and no
 * basis, so a reader could not tell a probability from an amount.
 *
 * Three word choices are load-bearing, and QA refused the alternatives. Do not
 * "simplify" them back:
 *
 * - **"Chance", not "precipitation" alone.** A reader reads "precipitation" as an
 *   amount in inches. The word "chance" is what carries the meaning.
 * - **"precipitation", not "rain".** The source of record is NWS gridpoint
 *   `probabilityOfPrecipitation` (`uom: wmoUnit:percent`), which is the probability
 *   of precipitation — liquid *or frozen equivalent*, not rain specifically.
 *   Belmont County gets snow in October, and this file already carries `Snow` in
 *   `CONDITION_OPTIONS` and `cloud-snow` in `VALID_ICON_CODES`. Publishing "Chance
 *   of rain" over a snow event would be a second false description, which is the
 *   exact thing BEL-190 and BEL-201 exist to stop.
 * - **"daytime", not "daytime peak".** There is no peak in this value. It is a
 *   single probability for the period, not a maximum over it, so "peak" would be
 *   the same kind of claim the basis exists to remove.
 *
 * No clock times in the long basis, and that is deliberate rather than vague. The
 * NWS daytime period is 06:00-18:00 for a future day, but it is truncated at the
 * run hour for the day already in progress: on the `2026-10-05T14:36:59Z` run,
 * `Today` read 10:00-18:00 EDT. So "6 a.m. to 6 p.m." would be false on any card
 * published mid-morning, while "daytime" stays true on every card.
 *
 * Presentation only. The value is not rounded, recomputed or re-derived here; a
 * reader comparing the card against `api.weather.gov` gets the same figure. The
 * column is not live yet (`DEFERRED_FIELDS_PENDING = true` in
 * `src/pages/DashboardPage.tsx`), so nothing has been published through this path
 * and there is no approved value to protect.
 *
 * When the migration lands, the backfill must take the **daytime** period's PoP
 * and the card basis is restated in that same change. The window is documented in
 * `supabase/migrations/20261005140000_weather_forecasts_deferred_fields.sql` but
 * nothing in the repository enforces it: no code reads `isDaytime`, so the
 * column comment is currently the only statement of the window.
 *
 * The database has no counterpart for this basis, same as humidity: no
 * `comment on column public.weather_forecasts.precipitation_chance`. It needs a
 * migration, and migrations are blocked until a SQL route exists.
 */
export const PRECIP_BASIS_SHORT = 'daytime';

export const PRECIP_BASIS_LONG =
  'Daytime chance of precipitation: the chance that precipitation falls at this location during the daytime period. This is not a forecast amount.';
