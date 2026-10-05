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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  sun: Sun,
  cloud: Cloud,
  'cloud-sun': CloudSun,
  'cloud-rain': CloudRain,
  'cloud-snow': CloudSnow,
  'cloud-lightning': CloudLightning,
  'cloud-fog': CloudFog,
};

export function getWeatherIcon(iconName: string): LucideIcon {
  return ICON_MAP[iconName] ?? Sun;
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
  }>;
}

export function WeatherForecast({ forecasts }: WeatherForecastProps) {
  if (forecasts.length === 0) return null;

  return (
    <section className="mb-12">
      <div className="rounded-2xl overflow-hidden shadow-lg bg-gradient-to-br from-primary-600 via-primary-700 to-primary-900">
        <div className="px-6 py-4 border-b border-white/10 flex items-center gap-2">
          <Sun className="w-5 h-5 text-accent-500" />
          <h2 className="text-white font-sans text-sm font-bold uppercase tracking-wider">
            Belmont 43718 — 3 Day Forecast
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/10">
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
                <div className="flex items-center gap-4 font-sans text-xs text-white/60">
                  <span className="flex items-center gap-1">
                    <Droplets className="w-3.5 h-3.5" />
                    {day.humidity}%
                  </span>
                  <span className="flex items-center gap-1">
                    <Wind className="w-3.5 h-3.5" />
                    {day.wind_speed} mph
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
