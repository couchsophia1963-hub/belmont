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
