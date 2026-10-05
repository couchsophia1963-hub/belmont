/**
 * A daytime-maximum humidity printed as a bare "%" (BEL-190).
 *
 * `weather_forecasts.humidity` holds the peak `relativeHumidity` inside the
 * 06:00-18:00 window, not the humidity of the day. QA measured 96 % at 08:00 EDT
 * on 2026-10-05 against a day mean of 69 %, so the card used to read
 *
 *     Sunny   67 / 48   96%
 *
 * and a reader saw a sunny October afternoon described as 96 % humid. It will
 * not be. The published value is correct against its basis; the presentation is
 * what lied, because a bare "%" beside a 67 degree high reads as a description of
 * the day.
 *
 * `typecheck` and `build` were both clean while this defect was live, so neither
 * of them can see it. Only reading the rendered card can, which is why this file
 * exists and why the assertions are on rendered text.
 *
 * The values below are the ones QA approved for 2026-10-05. The test does not
 * re-derive them; it pins the approved numbers so that a later change to the
 * card cannot quietly render a different figure as if it were the approved one.
 *
 * Scope: this covers the humidity figure only. Precipitation carries the same
 * shape of defect and is ruled on separately (BEL-195), so asserting on it here
 * would fix wording this issue is not entitled to choose.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WeatherForecast } from './WeatherForecast';
import { HUMIDITY_BASIS_SHORT, HUMIDITY_BASIS_LONG } from '../lib/weatherContract';

/** The row QA approved for 2026-10-05, at the peak the column actually holds. */
const OCT_5 = {
  forecast_date: '2026-10-05',
  high_temp: 67,
  low_temp: 48,
  condition: 'Sunny',
  icon: 'sun',
  humidity: 96,
  wind_speed: 12,
  wind_direction: 'Calm',
  precipitation_chance: 20,
  sunrise: '07:23:00',
  sunset: '18:52:00',
};

function renderCard(humidity: number = OCT_5.humidity) {
  return render(
    <WeatherForecast forecasts={[{ ...OCT_5, humidity }]} totalDays={1} />,
  );
}

describe('the humidity figure is named and carries its basis (BEL-190)', () => {
  it('labels the number instead of printing a bare percentage', () => {
    renderCard();
    // "Humidity 96%" - the label is the fix. A bare "96%" is what the reader
    // could not interpret.
    expect(screen.getByText(/Humidity 96%/)).toBeTruthy();
  });

  it('states the basis on the card, so the figure is interpretable in place', () => {
    renderCard();
    const basis = screen.getByText(HUMIDITY_BASIS_SHORT);
    expect(basis).toBeTruthy();
    // The short tag is what a sighted reader sees; the sentence names the window
    // for a screen reader, where an unlabelled maximum is just a number.
    expect(HUMIDITY_BASIS_SHORT).toBe('daytime peak');
    expect(HUMIDITY_BASIS_LONG).toMatch(/6 a\.m\. to 6 p\.m\./);
    expect(HUMIDITY_BASIS_LONG).toMatch(/not the average for the day/i);
  });

  it('carries the long basis as accessible text, not only as a tooltip', () => {
    const { container } = renderCard();
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(HUMIDITY_BASIS_LONG);
  });

  it('exposes the basis on hover as well', () => {
    renderCard();
    const labelled = screen.getByTitle(HUMIDITY_BASIS_LONG);
    expect(labelled).toBeTruthy();
  });

  it('does not print the approved figure anywhere as a bare percentage', () => {
    const { container } = renderCard();
    const text = container.textContent ?? '';
    // The regression this test exists for. "Humidity 96%" contains "96%", so the
    // guard is on a percentage that stands alone as its own text node.
    const barePercentages = Array.from(
      container.querySelectorAll('span'),
    )
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => /^(\d+)%$/.test(t));
    // Precipitation still renders bare and is BEL-195's to rule on; the humidity
    // span must not be one of them.
    expect(barePercentages).not.toContain(`${OCT_5.humidity}%`);
    expect(text).toContain('Humidity 96%');
  });

  it('keeps the published value itself unchanged', () => {
    // The fix is presentational. Republishing the 69 % day mean was the other
    // option QA offered and it reopens an approved value, so the number QA
    // approved must survive this change exactly.
    renderCard(69);
    expect(screen.getByText(/Humidity 69%/)).toBeTruthy();
    expect(screen.getByText(HUMIDITY_BASIS_SHORT)).toBeTruthy();
  });
});
