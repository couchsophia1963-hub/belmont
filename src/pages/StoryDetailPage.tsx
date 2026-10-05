import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { CommentSection } from '@/components/CommentSection';
import type { Story, Profile } from '@/types';
import { Loader2, ArrowLeft, Calendar, Clock, Tag } from 'lucide-react';

type StoryWithAuthor = Story & {
  author: Pick<Profile, 'display_name'> | null;
};

export function StoryDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [story, setStory] = useState<StoryWithAuthor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    (async () => {
      const { data, error: queryError } = await supabase
        .from('stories')
        .select('*, author:profiles!stories_author_id_fkey(display_name)')
        .eq('slug', slug)
        .eq('published', true)
        .maybeSingle();

      if (queryError) {
        setError('Failed to load story');
        setLoading(false);
        return;
      }
      if (!data) {
        setError('Story not found');
        setLoading(false);
        return;
      }
      setStory(data as StoryWithAuthor);
      setLoading(false);
    })();
  }, [slug]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (error || !story) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16 text-center">
        <p className="font-sans text-lg text-stone-600">{error || 'Story not found'}</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 mt-4 font-sans text-sm font-bold text-primary-700 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>
      </div>
    );
  }

  const paragraphs = story.body.split('\n\n');
  const dateStr = new Date(story.created_at).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timeStr = new Date(story.created_at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 font-sans text-sm font-semibold text-primary-700 hover:underline mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Home
      </Link>

      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1 font-sans text-xs font-bold uppercase tracking-wider text-white bg-primary-700 px-3 py-1 rounded-full">
          <Tag className="w-3 h-3" />
          {story.category}
        </span>
      </div>

      <h1 className="font-serif text-3xl sm:text-5xl font-black text-stone-900 leading-tight mb-4">
        {story.title}
      </h1>

      <p className="font-sans text-lg text-stone-600 leading-relaxed mb-6">
        {story.excerpt}
      </p>

      <div className="flex flex-wrap items-center gap-4 pb-6 mb-8 border-b border-stone-200 font-sans text-sm text-stone-500">
        {story.author?.display_name && (
          <span>
            By <strong className="text-stone-700">{story.author.display_name}</strong>
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <Calendar className="w-4 h-4" />
          {dateStr}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="w-4 h-4" />
          {timeStr}
        </span>
      </div>

      {story.image_url && (
        <div className="rounded-xl overflow-hidden mb-8 shadow-lg">
          <img
            src={story.image_url}
            alt={story.title}
            className="w-full h-auto object-cover"
          />
        </div>
      )}

      <div className="prose-news max-w-none">
        {paragraphs.map((para, idx) => (
          <p key={idx}>{para}</p>
        ))}
      </div>

      <CommentSection storyId={story.id} />
    </article>
  );
}
