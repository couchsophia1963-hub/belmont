/**
 * What "today" means for the forecast strip, in one place.
 *
 * Issue: BEL-29. The strip used to label card index 0 "Today" and never compare
 * `forecast_date` to the current date, so a stale row at the head of
 * `weather_forecasts` was published to readers as today. Two places need to agree
 * on the current date -- the reader query that decides which rows are in the
 * window, and the label on each card -- so the definition lives here rather than
 * being written twice.
 */

/**
 * The current calendar date as `YYYY-MM-DD` in the reader's own timezone.
 *
 * Deliberately local components, not `toISOString().slice(0, 10)`. That UTC form
 * is wrong for every reader west of Greenwich in the evening: at 21:00 in
 * America/New_York it already returns tomorrow's date. With the query filter
 * that would drop today's real row out of the window and relabel tomorrow's row
 * as today, which is the same class of bug BEL-29 was filed for. Do not
 * "simplify" this to the UTC form.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Reduce a stored `forecast_date` to `YYYY-MM-DD` so it compares equal to
 * {@link todayIsoDate}. The column is a Postgres `date` and normally arrives
 * bare, but truncating keeps the label correct if a caller ever passes a
 * timestamp instead of silently failing every comparison.
 */
export function forecastDateKey(forecastDate: string): string {
  return forecastDate.slice(0, 10);
}

/**
 * True only when the row is genuinely the current date. Never derive this from
 * an array index: the position of a row in the result set says nothing about the
 * day the forecast is for.
 */
export function isForecastToday(
  forecastDate: string,
  today: string = todayIsoDate(),
): boolean {
  return forecastDateKey(forecastDate) === today;
}