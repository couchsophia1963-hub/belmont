export type UserRole = 'user' | 'writer' | 'admin';

export interface Profile {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  created_at: string;
}

export interface Story {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  body: string;
  image_url: string | null;
  category: string;
  author_id: string | null;
  is_headline: boolean;
  published: boolean;
  locked: boolean;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeatherForecast {
  id: string;
  forecast_date: string;
  high_temp: number;
  low_temp: number;
  condition: string;
  icon: string;
  humidity: number;
  wind_speed: number;
  created_at: string;
  // Added by 20261005140000_weather_forecasts_deferred_fields.sql.
  // Nullable: the rows already on the site do not have them until backfilled.
  precipitation_chance: number | null;
  sunrise: string | null;
  sunset: string | null;
  wind_direction: string | null;
  wind_min: number | null;
  wind_max: number | null;
}

export interface Comment {
  id: string;
  story_id: string;
  user_id: string;
  body: string;
  created_at: string;
}

export interface PublicComment {
  id: string;
  story_id: string;
  body: string;
  created_at: string;
  display_name: string | null;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_prefix: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
}
