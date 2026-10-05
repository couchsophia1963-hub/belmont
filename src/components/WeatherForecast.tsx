import {
  Sun,
  Cloud,
  CloudSun,
  CloudRain,
  CloudSnow,
  CloudLightning,
  CloudFog,
  Wind,
  Droplets,
  Sunrise,
  Sunset,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { VALID_ICON_CODES } from '../lib/weatherContract';

export type ValidIconCode = (typeof VALID_ICON_CODES)[number];

// Typed against the shared contract on purpose: if someone adds a code to
// VALID_ICON_CODES and forgets a glyph here, the build fails instead of the
// reader getting a silent sun icon. That is the same failure the DB CHECK
// constraint now prevents on the write side.
const ICON_MAP: Record<ValidIconCode, LucideIcon> = {
  sun: Sun,
  cloud: Cloud,
  'cloud-sun': CloudSun,
  'cloud-rain': CloudRain,
  'cloud-snow': CloudSnow,
  'cloud-lightning': CloudLightning,
  'cloud-fog': CloudFog,
};

export function getWeatherIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName as ValidIconCode] ?? Sun;
}

/** Postgres `time` arrives as "HH:MM:SS". Trim to "HH:MM". */
function formatClock(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!/^\d{2}:\d{2}/.test(trimmed)) return null;
  return trimmed.slice(0, 5);
}

interface WeatherForecastProps {
  forecasts: Array<{
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
  }>;
  totalDays?: number;
}

type ForecastDay = WeatherForecastProps['forecasts'][number];

function getWindLabel(day: ForecastDay): string {
  const hasWindRange =
    !!day.wind_direction &&
    typeof day.wind_min === 'number' &&
    typeof day.wind_max === 'number';
  return hasWindRange
    ? `${day.wind_direction} ${day.wind_min}–${day.wind_max} mph`
    : `${day.wind_speed} mph`;
}

export function WeatherForecast({ forecasts, totalDays }: WeatherForecastProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (forecasts.length === 0) return null;

  const dayCount = totalDays ?? forecasts.length;
  const summaryForecast = forecasts[0];
  const summaryPrecipitation =
    typeof summaryForecast.precipitation_chance === 'number'
      ? `${summaryForecast.precipitation_chance}%`
      : '—';
  const summaryWind = getWindLabel(summaryForecast);
  const gridCols =
    dayCount <= 3
      ? 'grid-cols-1 sm:grid-cols-3'
      : dayCount <= 5
        ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
        : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7';

  return (
    <section className="mb-12">
      <div className="rounded-2xl overflow-hidden shadow-lg bg-gradient-to-br from-primary-600 via-primary-700 to-primary-900 dark:from-primary-700 dark:via-primary-800 dark:to-primary-950">
        <div className={`px-6 py-4 border-white/10 flex items-center justify-between ${collapsed ? '' : 'border-b'}`}>
          {collapsed ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-white">
              <Sun className="w-5 h-5 flex-shrink-0 text-accent-500" />
              <h2 className="font-sans text-sm font-bold tracking-wide">
                Belmont 43718 — {summaryForecast.condition}, {summaryForecast.high_temp}° / {summaryForecast.low_temp}°, {summaryPrecipitation}, {summaryWind}
              </h2>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Sun className="w-5 h-5 text-accent-500" />
              <h2 className="text-white font-sans text-sm font-bold uppercase tracking-wider">
                Belmont 43718 — {dayCount} Day Forecast
              </h2>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="ml-4 flex-shrink-0 rounded-lg p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand weather forecast' : 'Collapse weather forecast'}
            title={collapsed ? 'Expand weather forecast' : 'Collapse weather forecast'}
          >
            {collapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
          </button>
        </div>
        {!collapsed && <div className={`grid ${gridCols} divide-y sm:divide-y-0 sm:divide-x divide-white/10`}>
          {forecasts.map((day, idx) => {
            const Icon = getWeatherIcon(day.icon);
            const date = new Date(day.forecast_date + 'T00:00:00');
            const isToday = idx === 0;
            const dayName = isToday
              ? 'Today'
              : date.toLocaleDateString('en-US', { weekday: 'long' });
            const monthDay = date.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            });

            // Every new field is optional. A row that has not been backfilled
            // must render exactly what it rendered before, with no bare "%",
            // no "null mph" and no empty row.
            const precipitation =
              typeof day.precipitation_chance === 'number' &&
              day.precipitation_chance > 0
                ? day.precipitation_chance
                : null;

            const sunrise = formatClock(day.sunrise);
            const sunset = formatClock(day.sunset);
            const showSolar = sunrise !== null && sunset !== null;

            const windLabel = getWindLabel(day);

            return (
              <div
                key={day.forecast_date}
                className="px-6 py-6 flex flex-col items-center text-center text-white transition-colors hover:bg-white/5 animate-fade-in-up"
                style={{ animationDelay: `${idx * 100}ms` }}
              >
                <div className="flex items-baseline gap-2 mb-3">
                  <span className="font-sans text-lg font-bold">{dayName}</span>
                  <span className="font-sans text-sm text-white/60">{monthDay}</span>
                </div>
                <Icon className="w-12 h-12 mb-3 text-accent-500" strokeWidth={1.5} />
                <p className="font-sans text-sm text-white/80 mb-2">{day.condition}</p>
                <div className="flex items-baseline gap-3 mb-4">
                  <span className="font-serif text-4xl font-black">{day.high_temp}°</span>
                  <span className="font-sans text-xl text-white/50">{day.low_temp}°</span>
                </div>

                {showSolar && (
                  <div className="flex items-center gap-3 font-sans text-xs text-white/60 mb-3">
                    <span className="flex items-center gap-1">
                      <Sunrise className="w-3.5 h-3.5" />
                      {sunrise}
                    </span>
                    <span className="flex items-center gap-1">
                      <Sunset className="w-3.5 h-3.5" />
                      {sunset}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-4 font-sans text-xs text-white/60">
                  <span className="flex items-center gap-1">
                    <Droplets className="w-3.5 h-3.5" />
                    {day.humidity}%
                  </span>
                  <span className="flex items-center gap-1">
                    <Wind className="w-3.5 h-3.5" />
                    {windLabel}
                  </span>
                  {precipitation !== null && (
                    <span className="flex items-center gap-1">
                      <CloudRain className="w-3.5 h-3.5" />
                      {precipitation}%
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>}
      </div>
    </section>
  );
}
