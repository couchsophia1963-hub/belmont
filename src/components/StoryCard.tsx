import { Link } from 'react-router-dom';
import type { Story } from '@/types';
import { Calendar, Clock } from 'lucide-react';
import { ShareButton } from '@/components/ShareButton';

interface StoryCardProps {
  story: Story;
  variant?: 'default' | 'compact';
}

export function StoryCard({ story, variant = 'default' }: StoryCardProps) {
  const timeAgo = getTimeAgo(story.created_at);

  if (variant === 'compact') {
    return (
      <div className="group flex gap-4 items-start py-4 border-b border-stone-200 last:border-0 transition-colors hover:bg-stone-50 -mx-2 px-2 rounded-lg">
        <Link to={`/story/${story.slug}`} className="flex gap-4 items-start min-w-0 flex-1">
          {story.image_url && (
            <img
              src={story.image_url}
              alt={story.title}
              className="w-20 h-20 object-cover rounded-lg flex-shrink-0"
            />
          )}
          <div className="min-w-0 flex-1">
            <span className="font-sans text-xs font-bold uppercase tracking-wider text-primary-600">
              {story.category}
            </span>
            <h4 className="font-serif text-base font-bold text-stone-900 leading-snug mt-1 group-hover:text-primary-700 transition-colors line-clamp-2">
              {story.title}
            </h4>
            <span className="font-sans text-xs text-stone-400 mt-1 block">{timeAgo}</span>
          </div>
        </Link>
        <ShareButton slug={story.slug} title={story.title} variant="compact" />
      </div>
    );
  }

  return (
    <div className="group block bg-white rounded-xl overflow-hidden shadow-sm border border-stone-200 transition-all duration-300 hover:shadow-lg hover:-translate-y-1 relative">
      <Link to={`/story/${story.slug}`} className="block">
        {story.image_url && (
          <div className="relative overflow-hidden h-48">
            <img
              src={story.image_url}
              alt={story.title}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            <span className="absolute top-3 left-3 bg-primary-600 text-white font-sans text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full">
              {story.category}
            </span>
          </div>
        )}
        <div className="p-5">
          <h3 className="font-serif text-xl font-bold text-stone-900 leading-tight group-hover:text-primary-700 transition-colors line-clamp-2">
            {story.title}
          </h3>
          <p className="font-sans text-sm text-stone-600 mt-2 line-clamp-3">{story.excerpt}</p>
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2 font-sans text-xs text-stone-400">
              <Clock className="w-3.5 h-3.5" />
              <span>{timeAgo}</span>
            </div>
          </div>
        </div>
      </Link>
      <div className="absolute top-3 right-3 z-10" onClick={(e) => e.stopPropagation()}>
        <ShareButton slug={story.slug} title={story.title} variant="compact" />
      </div>
    </div>
  );
}

export function HeadlineStory({ story }: { story: Story }) {
  const timeAgo = getTimeAgo(story.created_at);
  const dateStr = new Date(story.created_at).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="group block relative rounded-2xl overflow-hidden shadow-xl mb-12">
      <Link to={`/story/${story.slug}`} className="block">
        {story.image_url && (
          <div className="absolute inset-0">
            <img
              src={story.image_url}
              alt={story.title}
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
          </div>
        )}
        <div className="relative px-6 py-8 sm:px-10 sm:py-16 min-h-[400px] sm:min-h-[500px] flex flex-col justify-end">
          <div className="flex items-center gap-3 mb-4">
            <span className="bg-accent-500 text-stone-900 font-sans text-xs font-black uppercase tracking-wider px-4 py-1.5 rounded-full">
              Headline
            </span>
            <span className="bg-primary-600/90 text-white font-sans text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-full">
              {story.category}
            </span>
          </div>
          <h1 className="font-serif text-3xl sm:text-5xl font-black text-white leading-tight max-w-3xl group-hover:text-accent-500 transition-colors duration-300">
            {story.title}
          </h1>
          <p className="font-sans text-base sm:text-lg text-white/80 mt-4 max-w-2xl line-clamp-3">
            {story.excerpt}
          </p>
          <div className="flex items-center gap-4 mt-5 font-sans text-sm text-white/60">
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" />
              {dateStr}
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              {timeAgo}
            </span>
          </div>
        </div>
      </Link>
      <div className="absolute top-4 right-4 z-10" onClick={(e) => e.stopPropagation()}>
        <ShareButton slug={story.slug} title={story.title} variant="compact" />
      </div>
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
