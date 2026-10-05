/**
 * Render proof for the weather basis labels. BEL-201, ruled by QA on BEL-195.
 *
 * WHY A SCRIPT AND NOT A TEST FILE: the repo has no test runner on this branch.
 * `npm test` arrives with PR #22 (vitest). Writing `*.test.tsx` now would produce
 * a file nothing executes, which is the opposite of verification. This file is
 * bundled and run with no framework, so it is runnable today on `main`.
 *
 *   npx esbuild src/components/WeatherForecast.bases.verify.tsx \
 *     --bundle --platform=node --format=cjs --jsx=automatic \
 *     --define:process.env.NODE_ENV='"production"' \
 *     --outfile=/tmp/verify-weather-bases.cjs
 *   node /tmp/verify-weather-bases.cjs
 *
 * `--format=cjs` is required, not incidental. With `--format=esm` the bundle
 * throws `Dynamic require of "stream" is not supported`, because
 * `react-dom/server` reaches for `stream` through a CommonJS `require`.
 *
 * Exits non-zero on the first failed assertion (it throws). It is deliberately
 * NOT wired into `npm test` so it cannot collide with PR #22's vitest config.
 * When #22 lands, fold these same assertions into a vitest `renderToStaticMarkup`
 * case and delete this file - the fixtures and the expected strings carry over.
 *
 * NOT A LIVE-PAGE CHECK. `belmont-news.bolt.host` serves a stale bundle (BEL-170)
 * and renders nothing while `precipitation_chance` is absent from the database, so
 * a live check cannot see this code either way. The proof has to live in the diff.
 *
 * Fixture provenance - the values below are not invented. They were read from
 * `https://api.weather.gov/gridpoints/PBZ/50,44/forecast` on run
 * `updateTime 2026-10-05T16:09:46+00:00`, from the period whose `isDaytime` is
 * true, which is the period the basis names:
 *
 *   2026-10-05 This Afternoon  12:00-18:00 EDT  PoP 0   <- the zero path
 *   2026-10-09 Friday         06:00-18:00 EDT  PoP 6
 *   2026-10-11 Sunday         06:00-18:00 EDT  PoP 19
 *
 * Every PoP carried `uom: wmoUnit:percent`, which is why the copy says
 * "precipitation" and not "rain": the field is the probability of precipitation,
 * liquid or frozen equivalent.
 *
 * That run also re-confirms QA's correction independently. The daytime period for
 * the day already in progress started at 12:00, not 06:00, because the run was
 * issued at 12:09 EDT - QA saw it truncated at 10:00 on an earlier run. So
 * "6 a.m. to 6 p.m." would have been false on the card, and `daytime` is the only
 * window claim that stays true.
 *
 * The disable below is scoped to this file and is not a blanket opt-out. The rule
 * it silences is about Fast Refresh, which only applies to modules in the app
 * graph; this file is a verification script that no page imports.
 */
/* eslint-disable react-refresh/only-export-components */
import { renderToStaticMarkup } from 'react-dom/server';
import { WeatherForecast } from './WeatherForecast';
import {
  HUMIDITY_BASIS_SHORT,
  HUMIDITY_BASIS_LONG,
  PRECIP_BASIS_SHORT,
  PRECIP_BASIS_LONG,
} from '../lib/weatherContract';

type Row = {
  forecast_date: string;
  high_temp: number;
  low_temp: number;
  condition: string;
  icon: string;
  humidity: number;
  wind_speed: number;
  precipitation_chance?: number | null;
  sunrise?: string | null;
  sunset?: string | null;
  wind_direction?: string | null;
  wind_min?: number | null;
  wind_max?: number | null;
};

/** Same shape for every day that is not the one carrying the value under test. */
const UNTITLED: Row = {
  forecast_date: '2026-10-12',
  high_temp: 55,
  low_temp: 41,
  condition: 'Snow',
  icon: 'cloud-snow',
  humidity: 70,
  wind_speed: 9,
  precipitation_chance: 0,
};

/**
 * Pull one basis cell out of the rendered HTML by the `title` that identifies it,
 * then return its text with tags stripped.
 *
 * Scoping matters. QA's bar is "the word `peak` does not appear in the
 * precipitation cell", and `peak` legitimately appears one cell to the left, on
 * the humidity basis. A whole-document assertion would either be vacuous or
 * fail for the wrong reason, so the cell is extracted first.
 */
function basisCellText(html: string, basisLong: string): string | null {
  const marker = `title="${basisLong.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  const markerAt = html.indexOf(marker);
  if (markerAt === -1) return null;

  const openAt = html.lastIndexOf('<span', markerAt);
  if (openAt === -1) return null;

  // Walk forward to this span's own closing tag, honouring nested spans.
  const tail = html.slice(openAt);
  const tag = /<span\b|<\/span>/g;
  let depth = 0;
  let endAt = -1;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(tail)) !== null) {
    if (match[0] === '</span>') {
      depth -= 1;
      if (depth === 0) {
        endAt = openAt + match.index + match[0].length;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (endAt === -1) return null;

  return html
    .slice(openAt, endAt)
    .replace(/<[^>]*>/g, '')
    .trim();
}

let failures = 0;
function check(name: string, pass: boolean, detail?: string) {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

function render(forecasts: Row[]): string {
  return renderToStaticMarkup(<WeatherForecast forecasts={forecasts} />);
}

// ---------------------------------------------------------------------------
// The copy QA mandated, asserted as literals. If someone edits the strings in
// weatherContract.ts to something friendlier, this fails and the ruling has to be
// re-read rather than bypassed.
// ---------------------------------------------------------------------------
// Widened to `string` on purpose. `const PRECIP_BASIS_SHORT` narrows to the
// literal type, so TypeScript already knows these two comparisons are always
// true/false and rejects them as dead code. That is proof the constant is right
// today, not a guard: someone editing it to `daytime peak` should make this
// script fail loudly, and a narrowed literal would have stopped that.
const precipShort: string = PRECIP_BASIS_SHORT;

check('basis short tag is exactly "daytime"', precipShort === 'daytime', precipShort);
check(
  'basis short tag does not claim a peak',
  precipShort !== 'daytime peak',
  precipShort,
);
check(
  'basis long text matches the ruling verbatim',
  PRECIP_BASIS_LONG ===
    'Daytime chance of precipitation: the chance that precipitation falls at this location during the daytime period. This is not a forecast amount.',
);
check('basis long text says this is not an amount', PRECIP_BASIS_LONG.includes('not a forecast amount'));

// QA: no clock times, because the daytime period is truncated at the run hour for
// the day in progress. A clock time here is a claim that goes stale intraday.
check(
  'basis long text states no clock time',
  !/\d{1,2}\s*:\s*\d{2}/.test(PRECIP_BASIS_LONG) && !/a\.m\.|p\.m\./i.test(PRECIP_BASIS_LONG),
  PRECIP_BASIS_LONG,
);

// ---------------------------------------------------------------------------
// Non-zero path. 19 is Sunday 2026-10-11 daytime PoP, from the run named above.
// ---------------------------------------------------------------------------
const withRain = render([
  { ...UNTITLED, forecast_date: '2026-10-11', precipitation_chance: 19, condition: 'Rain', icon: 'cloud-rain', humidity: 88 },
]);

const precipCell = basisCellText(withRain, PRECIP_BASIS_LONG);
check('precipitation basis cell is rendered', precipCell !== null);

const cell = precipCell ?? '';
check(
  'cell reads "Precipitation chance 19%" with no space before %',
  cell.includes('Precipitation chance 19%'),
  cell,
);
check('cell names the basis as "daytime"', cell.includes('daytime'), cell);
check(
  'cell does not claim a peak',
  !/peak/i.test(cell),
  cell,
);
// QA refused "Chance of rain": the NWS field is PoP for frozen as well as liquid,
// and this county gets snow in October. Guard it so nobody shortens the noun back.
check(
  'cell does not say "rain" - the basis is precipitation, liquid or frozen',
  !/rain/i.test(cell),
  cell,
);
check('document carries no bare "19%" as a standalone value', !/>\s*19%\s*</.test(withRain));
check('document carries no bare "%" cell for precipitation', !/>\s*%\s*</.test(withRain));

// The value is presentation-only: no rounding, no recomputing.
const withSix = render([
  { ...UNTITLED, forecast_date: '2026-10-09', precipitation_chance: 6, condition: 'Showers', icon: 'cloud-rain' },
]);
const sixCell = basisCellText(withSix, PRECIP_BASIS_LONG) ?? '';
check(
  'a 6 % day prints 6, not a rounded or recomputed figure',
  sixCell.includes('Precipitation chance 6%'),
  sixCell,
);

check(
  'basis tag is rendered uppercase via the shared treatment',
  withRain.includes('text-[10px] uppercase tracking-wider text-white/80'),
);

// ---------------------------------------------------------------------------
// Zero path. A 0 % chance is a non-event; QA ruled the cell is dropped and that
// printing "Precipitation chance 0%" would be wrong. Not a bug to fix.
// ---------------------------------------------------------------------------
const withZero = render([
  { ...UNTITLED, forecast_date: '2026-10-05', precipitation_chance: 0, condition: 'Sunny', icon: 'sun', humidity: 96 },
]);
check('a 0 % day renders no precipitation cell', basisCellText(withZero, PRECIP_BASIS_LONG) === null);
check('a 0 % day does NOT print "Precipitation chance 0%"', !withZero.includes('Precipitation chance 0%'));
// ">daytime<" is the basis tag's exact text content, so it counts tags only and is
// not confused by the "Daytime" that opens either long basis sentence.
check(
  'a 0 % day emits no basis tag of its own',
  (withZero.match(/>daytime</g) ?? []).length === 0,
  `${(withZero.match(/>daytime</g) ?? []).length} tag(s)`,
);

// A row that has never been backfilled must render exactly as it did before.
const unbackfilled = render([{ ...UNTITLED, precipitation_chance: null }]);
check('a null value renders no precipitation cell', basisCellText(unbackfilled, PRECIP_BASIS_LONG) === null);
// Scoped, not document-wide: the humidity cell legitimately prints its own "%",
// so the claim is that a null precipitation value adds no second one.
check(
  'a null value adds no second "%" - the only one left is humidity',
  (unbackfilled.match(/%/g) ?? []).length === 1,
  `${(unbackfilled.match(/%/g) ?? []).length} "%" in the document`,
);

// The humidity basis shares this row and this treatment. Guard it so widening the
// strip for precipitation cannot quietly regress the BEL-190 fix next to it.
const humidityCell = basisCellText(withZero, HUMIDITY_BASIS_LONG) ?? '';
check('humidity cell still reads "Humidity 96%"', humidityCell.includes('Humidity 96%'), humidityCell);
check(
  'humidity cell still names "daytime peak"',
  humidityCell.includes(HUMIDITY_BASIS_SHORT) && /peak/i.test(humidityCell),
  humidityCell,
);
// Proves the "no peak" assertion above is scoped to the precipitation cell and
// not a blanket ban on the word.
check('"peak" really does appear elsewhere in the same row', withRain.includes('daytime peak'));

// The row wraps, so the longer label does not push the strip into one column.
check('footer row wraps rather than overflowing', withRain.includes('flex-wrap'));

if (failures > 0) {
  throw new Error(`${failures} weather-basis assertion(s) failed`);
}
console.log('\nALL WEATHER BASIS CHECKS PASSED');