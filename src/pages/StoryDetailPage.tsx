import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { CommentSection } from '@/components/CommentSection';
import type { Story, Profile } from '@/types';
import { Loader2, ArrowLeft, Calendar, Clock, Tag, Lock } from 'lucide-react';
import { ShareButton } from '@/components/ShareButton';
import { heroImageAlt } from '@/lib/heroImageAlt';
import {
  SHELTER_BIDS_ACCURATE_STORY_URL,
  SHELTER_BIDS_ATTRIBUTION,
  SHELTER_BIDS_LEAD,
  SHELTER_BIDS_STORY_PAGE_LEAD_IN,
  SHELTER_BIDS_STORY_PAGE_LEAD_OUT,
  isShelterBidsCorrectedStory,
} from '@/lib/shelterCorrection';

type StoryWithAuthor = Story & {
  author: Pick<Profile, 'display_name'> | null;
};

const STORY_COLUMNS =
  'id, slug, title, excerpt, body, image_url, category, author_id, is_headline, published, locked, locked_until, created_at, updated_at';

/**
 * The full correction notice for the shelter bids item.
 *
 * Rendered above the story's own headline, so it is chrome on the route rather
 * than an edit to the story body: nothing here touches `story.body`, `excerpt`,
 * `title` or any other column, and no `stories update` is issued.
 *
 * The gate is the route's slug and nothing else -- not the row, not the role,
 * not `published`. That is deliberate. It is why the notice still renders when
 * the read path is down: a reader who lands on this address while Supabase is
 * unreachable is exactly the reader who most needs to be told this is not our
 * reporting.
 */
function ShelterBidsCorrection() {
  return (
    <aside
      role="note"
      className="mb-6 rounded-xl border border-stone-300 dark:border-stone-700 border-l-4 border-l-error-600 bg-stone-50 dark:bg-stone-900 px-4 py-4"
    >
      <p className="font-sans text-sm leading-relaxed text-stone-700 dark:text-stone-300">
        <strong className="font-bold">{SHELTER_BIDS_LEAD}</strong> {SHELTER_BIDS_STORY_PAGE_LEAD_IN}
        <a
          href={SHELTER_BIDS_ACCURATE_STORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-words hover:text-primary-700 dark:hover:text-primary-400"
        >
          {SHELTER_BIDS_ACCURATE_STORY_URL}
        </a>
        {SHELTER_BIDS_STORY_PAGE_LEAD_OUT}
      </p>
      <p className="mt-3 font-sans text-sm text-stone-600 dark:text-stone-400">
        {SHELTER_BIDS_ATTRIBUTION}
      </p>
    </aside>
  );
}

export function StoryDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { profile } = useAuth();
  const [story, setStory] = useState<StoryWithAuthor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    (async () => {
      // Writers and admins can view unpublished stories; everyone else
      // only sees published ones.
      const canSeeUnpublished = profile?.role === 'writer' || profile?.role === 'admin';
      let query = supabase.from('stories').select(STORY_COLUMNS).eq('slug', slug);
      if (!canSeeUnpublished) {
        query = query.eq('published', true);
      }
      const { data, error: queryError } = await query.maybeSingle();

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

      const loaded = data as Story;

      // The byline is looked up on its own, by id, instead of as a PostgREST
      // embed. `stories.author_id` points at auth.users, and PostgREST only
      // resolves relationships inside the exposed `public` schema, so an embed
      // hint fails to parse and takes the whole page down with it (BEL-38).
      // A missing author name is not worth losing the story over.
      let author: Pick<Profile, 'display_name'> | null = null;
      if (loaded.author_id) {
        const { data: authorRow } = await supabase
          .from('profiles')
          .select('id, display_name')
          .eq('id', loaded.author_id)
          .maybeSingle();
        author = (authorRow as Pick<Profile, 'display_name'> | null) ?? null;
      }

      setStory({ ...loaded, author });
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
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {isShelterBidsCorrectedStory(slug) && <ShelterBidsCorrection />}
        <div className="py-8 text-center">
          <p className="font-sans text-lg text-stone-600 dark:text-stone-400">{error || 'Story not found'}</p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 mt-4 font-sans text-sm font-bold text-primary-700 dark:text-primary-400 hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Home
          </Link>
        </div>
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
      {isShelterBidsCorrectedStory(slug) && <ShelterBidsCorrection />}

      <Link
        to="/"
        className="inline-flex items-center gap-1.5 font-sans text-sm font-semibold text-primary-700 dark:text-primary-400 hover:underline mb-6"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Home
      </Link>

      <div className="flex items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1 font-sans text-xs font-bold uppercase tracking-wider text-white bg-primary-700 px-3 py-1 rounded-full">
          <Tag className="w-3 h-3" />
          {story.category}
        </span>
        {!story.published && (
          <span className="inline-flex items-center gap-1 font-sans text-xs font-bold uppercase tracking-wider text-white bg-stone-500 px-3 py-1 rounded-full">
            Draft
          </span>
        )}
        {story.locked && (
          <span className="inline-flex items-center gap-1 font-sans text-xs font-bold uppercase tracking-wider text-primary-700 dark:text-primary-300 bg-primary-50 dark:bg-primary-900/40 px-3 py-1 rounded-full border border-primary-200 dark:border-primary-700">
            <Lock className="w-3 h-3" />
            Locked
          </span>
        )}
      </div>

      <h1 className="font-serif text-3xl sm:text-5xl font-black text-stone-900 dark:text-stone-50 leading-tight mb-4">
        {story.title}
      </h1>

      <p className="font-sans text-lg text-stone-600 dark:text-stone-400 leading-relaxed mb-6">
        {story.excerpt}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-4 pb-6 mb-8 border-b border-stone-200 dark:border-stone-700">
        <div className="flex flex-wrap items-center gap-4 font-sans text-sm text-stone-500 dark:text-stone-400">
          {story.author?.display_name && (
            <span>
              By <strong className="text-stone-700 dark:text-stone-200">{story.author.display_name}</strong>
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
        <ShareButton slug={story.slug} title={story.title} />
      </div>

      {story.image_url && (
        <div className="rounded-xl overflow-hidden mb-8 shadow-lg">
          <img
            src={story.image_url}
            alt={heroImageAlt(story)}
            className="w-full h-auto object-cover"
          />
        </div>
      )}

      <div className="prose-news max-w-none">
        {paragraphs.map((para, idx) => (
          <p key={idx}>{para}</p>
        ))}
      </div>

      <div className="mt-8 pt-6 border-t border-stone-200 dark:border-stone-700 flex items-center justify-between">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 font-sans text-sm font-semibold text-primary-700 dark:text-primary-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>
      </div>

      <CommentSection storyId={story.id} />
    </article>
  );
}
