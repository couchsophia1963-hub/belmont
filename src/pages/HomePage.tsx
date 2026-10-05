import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { WeatherForecast } from '@/components/WeatherForecast';
import { HeadlineStory, StoryCard } from '@/components/StoryCard';
import type { Story, WeatherForecast as WeatherType } from '@/types';
import { Loader2, TrendingUp } from 'lucide-react';

export function HomePage() {
  const { session } = useAuth();
  const [weather, setWeather] = useState<WeatherType[]>([]);
  const [headline, setHeadline] = useState<Story | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [
        { data: weatherData, error: weatherErr },
        { data: headlineData, error: headlineErr },
        { data: storiesData, error: storiesErr },
      ] = await Promise.all([
        supabase
          .from('weather_forecasts')
          .select('*')
          .order('forecast_date', { ascending: true })
          .limit(7),
        supabase
          .from('stories')
          .select('*')
          .eq('published', true)
          .eq('is_headline', true)
          .order('created_at', { ascending: false })
          .maybeSingle(),
        supabase
          .from('stories')
          .select('*')
          .eq('published', true)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (weatherErr || headlineErr || storiesErr) {
        setError('Failed to load content. Please try again.');
        setLoading(false);
        return;
      }

      setWeather((weatherData ?? []) as WeatherType[]);
      setHeadline(headlineData as Story | null);
      setStories((storiesData ?? []) as Story[]);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 text-center">
        <p className="font-sans text-lg text-error-600">{error}</p>
      </div>
    );
  }

  const mainHeadline = headline || stories[0] || null;
  const remainingStories = mainHeadline
    ? stories.filter((s) => s.id !== mainHeadline.id)
    : stories;
  const gridStories = remainingStories.slice(0, 9);
  const sidebarStories = remainingStories.slice(9);

  const visibleDays = session ? 5 : 3;
  const displayWeather = weather.slice(0, visibleDays);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <WeatherForecast forecasts={displayWeather} totalDays={visibleDays} />

      {mainHeadline && <HeadlineStory story={mainHeadline} />}

      <div>
        <div className="flex items-center gap-2 mb-6">
          <TrendingUp className="w-5 h-5 text-primary-700 dark:text-primary-400" />
          <h2 className="font-serif text-2xl font-bold text-stone-900 dark:text-stone-50">Recent Stories</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {gridStories.map((story) => (
            <StoryCard key={story.id} story={story} />
          ))}
        </div>
      </div>

      {sidebarStories.length > 0 && (
        <div className="mt-10">
          <div className="bg-stone-100 dark:bg-stone-900 rounded-xl p-5">
            <h3 className="font-serif text-lg font-bold text-stone-900 dark:text-stone-50 mb-2 pb-3 border-b-2 border-primary-700 dark:border-primary-600">
              More Headlines
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0">
              {sidebarStories.map((story) => (
                <StoryCard key={story.id} story={story} variant="compact" />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
