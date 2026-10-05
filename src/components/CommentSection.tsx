import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { PublicComment } from '@/types';
import { Send, Trash2, MessageCircle, Loader2 } from 'lucide-react';

interface CommentSectionProps {
  storyId: string;
}

export function CommentSection({ storyId }: CommentSectionProps) {
  const { session, profile } = useAuth();
  const [comments, setComments] = useState<PublicComment[]>([]);
  const [deletableIds, setDeletableIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadComments = async () => {
    const { data, error: queryError } = await supabase
      .from('comments_public')
      .select('id, story_id, body, created_at, display_name')
      .eq('story_id', storyId)
      .order('created_at', { ascending: false });

    if (queryError) {
      setError('Failed to load comments');
      setLoading(false);
      return;
    }
    setComments((data ?? []) as PublicComment[]);
    setLoading(false);
  };

  const loadDeletableIds = async () => {
    if (!session) {
      setDeletableIds(new Set());
      return;
    }
    const { data } = await supabase
      .from('comments')
      .select('id')
      .eq('story_id', storyId);
    setDeletableIds(new Set((data ?? []).map((row) => row.id)));
  };

  useEffect(() => {
    loadComments();
    loadDeletableIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || !session) return;
    setSubmitting(true);
    setError(null);

    const { error: insertError } = await supabase
      .from('comments')
      .insert({ story_id: storyId, body: body.trim() });

    if (insertError) {
      setError(insertError.message);
      setSubmitting(false);
      return;
    }

    setBody('');
    setSubmitting(false);
    await Promise.all([loadComments(), loadDeletableIds()]);
  };

  const handleDelete = async (commentId: string) => {
    const { error: deleteError } = await supabase
      .from('comments')
      .delete()
      .eq('id', commentId);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await Promise.all([loadComments(), loadDeletableIds()]);
  };

  const canDelete = (comment: PublicComment) => Boolean(session) && deletableIds.has(comment.id);

  return (
    <section className="mt-12 border-t border-stone-200 pt-8">
      <div className="flex items-center gap-2 mb-6">
        <MessageCircle className="w-6 h-6 text-primary-700" />
        <h3 className="font-serif text-2xl font-bold text-stone-900">
          Comments ({comments.length})
        </h3>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-error-500/10 border border-error-500/30 text-error-700 font-sans text-sm">
          {error}
        </div>
      )}

      {session ? (
        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-primary-600 text-white flex items-center justify-center font-sans font-bold text-sm">
              {(profile?.display_name || profile?.email || '?').charAt(0).toUpperCase()}
            </div>
            <span className="font-sans text-sm font-semibold text-stone-700">
              {profile?.display_name || profile?.email}
            </span>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Share your thoughts..."
            rows={3}
            className="w-full px-4 py-3 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none transition-all"
          />
          <div className="flex justify-end mt-2">
            <button
              type="submit"
              disabled={!body.trim() || submitting}
              className="flex items-center gap-2 px-5 py-2 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Post Comment
            </button>
          </div>
        </form>
      ) : (
        <div className="mb-8 p-6 rounded-xl bg-stone-100 border border-stone-200 text-center">
          <p className="font-sans text-sm text-stone-600">
            Sign in to join the conversation and share your thoughts on this story.
          </p>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-20 rounded-lg shimmer" />
          ))}
        </div>
      ) : comments.length === 0 ? (
        <p className="font-sans text-sm text-stone-400 text-center py-8">
          No comments yet. Be the first to share your thoughts.
        </p>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => (
            <div
              key={comment.id}
              className="p-4 rounded-lg bg-white border border-stone-200 animate-fade-in-up"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-stone-300 text-stone-600 flex items-center justify-center font-sans font-bold text-sm">
                    {(comment.display_name || '?').charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <span className="font-sans text-sm font-semibold text-stone-800">
                      {comment.display_name || 'Unknown'}
                    </span>
                    <span className="font-sans text-xs text-stone-400 ml-2">
                      {new Date(comment.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
                {canDelete(comment) && (
                  <button
                    onClick={() => handleDelete(comment.id)}
                    className="p-1.5 rounded-md text-stone-400 hover:text-error-600 hover:bg-error-50 transition-colors"
                    title="Delete comment"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              <p className="font-sans text-sm text-stone-700 leading-relaxed">
                {comment.body}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
