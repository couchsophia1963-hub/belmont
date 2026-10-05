import { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { Story } from '@/types';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Check,
  Search,
  Eye,
  EyeOff,
  Star,
  ArrowLeft,
  Save,
  Lock,
  Unlock,
  RotateCcw,
} from 'lucide-react';

const CATEGORIES = [
  'Local News',
  'Community',
  'Government',
  'Sports',
  'Business',
  'Education',
  'Environment',
  'Health',
  'Obituaries',
];

type EditorState = 'list' | 'edit';

export function StoryManagerPage() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (!session || !profile) {
    return <Navigate to="/auth" replace />;
  }

  if (profile.role !== 'writer' && profile.role !== 'admin') {
    return <Navigate to="/dashboard" replace />;
  }

  return <StoryManager role={profile.role} userId={session.user.id} />;
}

function StoryManager({ role, userId }: { role: 'writer' | 'admin'; userId: string }) {
  const [view, setView] = useState<EditorState>('list');
  const [editingStory, setEditingStory] = useState<Story | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleEdit = (story: Story) => {
    setEditingStory(story);
    setView('edit');
  };

  const handleNew = () => {
    setEditingStory(null);
    setView('edit');
  };

  const handleBack = () => {
    setView('list');
    setEditingStory(null);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl font-black text-stone-900">Story Manager</h1>
        <p className="font-sans text-sm text-stone-500 mt-1">
          Create, edit, and manage news stories for Belmont County News.
        </p>
      </div>

      {view === 'list' && (
        <StoryList
          key={refreshKey}
          role={role}
          userId={userId}
          onEdit={handleEdit}
          onNew={handleNew}
        />
      )}

      {view === 'edit' && (
        <StoryEditor story={editingStory} onBack={handleBack} authorId={userId} />
      )}
    </div>
  );
}

// ============================================================
// STORY LIST
// ============================================================
function StoryList({
  role,
  userId,
  onEdit,
  onNew,
}: {
  role: 'writer' | 'admin';
  userId: string;
  onEdit: (story: Story) => void;
  onNew: () => void;
}) {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'published' | 'draft' | 'headline'>('all');
  const [actionTarget, setActionTarget] = useState<{ id: string; action: 'delete' } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadStories = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('Failed to load stories:', error.message);
    }
    setStories((data ?? []) as Story[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStories();
  }, [loadStories]);

  const filtered = stories.filter((s) => {
    if (filter === 'published' && !s.published) return false;
    if (filter === 'draft' && s.published) return false;
    if (filter === 'headline' && !s.is_headline) return false;
    if (search) {
      const q = search.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.category.toLowerCase().includes(q);
    }
    return true;
  });

  const handleDelete = async (id: string) => {
    setActing(true);
    setActionError(null);
    const story = stories.find((s) => s.id === id);
    if (!story) return;

    if (story.locked) {
      setActionError('This story is locked and cannot be deleted. Unlock it first.');
      setActing(false);
      setActionTarget(null);
      return;
    }

    const { error } = await supabase.from('stories').delete().eq('id', id);
    setActing(false);
    setActionTarget(null);
    if (error) {
      if (error.message.includes('row-level security')) {
        setActionError('Delete blocked by security policy. The story may be locked.');
      } else {
        setActionError('Failed to delete story: ' + error.message);
      }
      return;
    }
    await loadStories();
  };

  const togglePublished = async (story: Story) => {
    const { error } = await supabase
      .from('stories')
      .update({ published: !story.published })
      .eq('id', story.id);
    if (error) {
      alert('Failed to update: ' + error.message);
      return;
    }
    await loadStories();
  };

  const toggleHeadline = async (story: Story) => {
    if (!story.is_headline) {
      await supabase
        .from('stories')
        .update({ is_headline: false })
        .neq('id', story.id);
    }
    const { error } = await supabase
      .from('stories')
      .update({ is_headline: !story.is_headline })
      .eq('id', story.id);
    if (error) {
      alert('Failed to update: ' + error.message);
      return;
    }
    await loadStories();
  };

  const toggleLock = async (story: Story) => {
    const { error } = await supabase
      .from('stories')
      .update({ locked: !story.locked })
      .eq('id', story.id);
    if (error) {
      alert('Failed to toggle lock: ' + error.message);
      return;
    }
    await loadStories();
  };

  return (
    <div>
      {actionError && (
        <div className="mb-4 p-4 rounded-lg bg-error-50 border border-error-200 flex items-start justify-between gap-3">
          <p className="font-sans text-sm font-semibold text-error-700">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="text-error-600 hover:text-error-800 flex-shrink-0"
          >
            <Unlock className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-4 items-stretch sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search stories..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
          />
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm font-semibold text-stone-700 focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
        >
          <option value="all">All Stories</option>
          <option value="published">Published</option>
          <option value="draft">Drafts</option>
          <option value="headline">Headlines</option>
        </select>
        <button
          onClick={onNew}
          className="px-5 py-2.5 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 transition-colors flex items-center gap-2 justify-center whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          New Story
        </button>
      </div>

      <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-16 rounded-lg shimmer" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="font-sans text-sm text-stone-400 mb-2">No stories found</p>
            <button
              onClick={onNew}
              className="font-sans text-sm font-bold text-primary-700 hover:text-primary-800"
            >
              Create your first story
            </button>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50">
                <th className="text-left py-3 px-4 font-sans font-bold text-stone-600 text-sm">Title</th>
                <th className="text-left py-3 px-4 font-sans font-bold text-stone-600 text-sm hidden sm:table-cell">Category</th>
                <th className="text-left py-3 px-4 font-sans font-bold text-stone-600 text-sm hidden md:table-cell">Date</th>
                <th className="text-center py-3 px-2 font-sans font-bold text-stone-600 text-sm">Published</th>
                <th className="text-center py-3 px-2 font-sans font-bold text-stone-600 text-sm">Headline</th>
                <th className="text-right py-3 px-4 font-sans font-bold text-stone-600 text-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((story) => (
                <tr
                  key={story.id}
                  className="border-b border-stone-100 hover:bg-stone-50 transition-colors"
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      {story.image_url && (
                        <img
                          src={story.image_url}
                          alt=""
                          className="w-10 h-10 rounded object-cover flex-shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="font-sans text-sm font-semibold text-stone-800 line-clamp-2">
                          {story.title}
                        </span>
                        {story.locked && (
                          <span className="inline-flex items-center gap-1 mt-0.5 font-sans text-xs font-bold text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded">
                            <Lock className="w-3 h-3" />
                            Locked
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 hidden sm:table-cell">
                    <span className="font-sans text-xs font-semibold text-primary-700 bg-primary-50 px-2 py-1 rounded-full">
                      {story.category}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-sans text-xs text-stone-500 hidden md:table-cell whitespace-nowrap">
                    {new Date(story.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </td>
                  <td className="py-3 px-2 text-center">
                    <button
                      onClick={() => togglePublished(story)}
                      className="p-1.5 rounded-lg transition-colors"
                      title={story.published ? 'Unpublish' : 'Publish'}
                    >
                      {story.published ? (
                        <Eye className="w-4 h-4 text-success-600" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-stone-400" />
                      )}
                    </button>
                  </td>
                  <td className="py-3 px-2 text-center">
                    <button
                      onClick={() => toggleHeadline(story)}
                      className="p-1.5 rounded-lg transition-colors"
                      title={story.is_headline ? 'Remove headline' : 'Make headline'}
                    >
                      <Star
                        className={`w-4 h-4 ${
                          story.is_headline
                            ? 'text-accent-500 fill-accent-500'
                            : 'text-stone-300'
                        }`}
                      />
                    </button>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => onEdit(story)}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-primary-700 hover:bg-primary-50 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {role === 'admin' && (
                        <>
                          <button
                            onClick={() => toggleLock(story)}
                            className="p-1.5 rounded-lg transition-colors"
                            title={story.locked ? 'Unlock story' : 'Lock story (prevent deletion)'}
                          >
                            {story.locked ? (
                              <Lock className="w-4 h-4 text-primary-700" />
                            ) : (
                              <Unlock className="w-4 h-4 text-stone-400 hover:text-primary-700" />
                            )}
                          </button>
                          <button
                            onClick={() => setActionTarget({ id: story.id, action: 'delete' })}
                            disabled={story.locked}
                            className="p-1.5 rounded-lg text-stone-500 hover:text-error-600 hover:bg-error-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            title={story.locked ? 'Unlock to delete' : 'Delete story'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="font-sans text-xs text-stone-400 mt-3 text-center">
        {filtered.length} {filtered.length === 1 ? 'story' : 'stories'}
        {role === 'writer' && ' — only admins can delete or lock stories'}
      </p>

      {actionTarget && (
        <ConfirmDialog
          title="Delete this story?"
          message="This will permanently remove the story and all its comments. This action cannot be undone."
          confirmLabel="Delete"
          loading={acting}
          onConfirm={() => handleDelete(actionTarget.id)}
          onCancel={() => setActionTarget(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// STORY EDITOR
// ============================================================
function StoryEditor({ story, onBack, authorId }: { story: Story | null; onBack: () => void; authorId: string }) {
  const [title, setTitle] = useState(story?.title ?? '');
  const [slug, setSlug] = useState(story?.slug ?? '');
  const [excerpt, setExcerpt] = useState(story?.excerpt ?? '');
  const [body, setBody] = useState(story?.body ?? '');
  const [imageUrl, setImageUrl] = useState(story?.image_url ?? '');
  const [category, setCategory] = useState(story?.category ?? 'Local News');
  const [isHeadline, setIsHeadline] = useState(story?.is_headline ?? false);
  const [published, setPublished] = useState(story?.published ?? true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugEdited, setSlugEdited] = useState(!!story);

  const slugify = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (!title.trim() || !excerpt.trim() || !body.trim()) {
      setError('Title, excerpt, and body are all required.');
      setSaving(false);
      return;
    }

    const finalSlug = slug.trim() || slugify(title);

    const payload = {
      title: title.trim(),
      slug: finalSlug,
      excerpt: excerpt.trim(),
      body: body.trim(),
      image_url: imageUrl.trim() || null,
      category,
      is_headline: isHeadline,
      published,
      updated_at: new Date().toISOString(),
    };

    if (story) {
      const { error: updateError } = await supabase
        .from('stories')
        .update(payload)
        .eq('id', story.id);
      if (updateError) {
        setError(updateError.message);
        setSaving(false);
        return;
      }
    } else {
      const { error: insertError } = await supabase
        .from('stories')
        .insert({ ...payload, author_id: authorId });
      if (insertError) {
        setError(insertError.message);
        setSaving(false);
        return;
      }
    }

    if (isHeadline && !story?.is_headline) {
      await supabase
        .from('stories')
        .update({ is_headline: false })
        .neq('slug', finalSlug);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => onBack(), 800);
  };

  return (
    <form onSubmit={handleSave}>
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 font-sans text-sm font-semibold text-stone-600 hover:text-primary-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to stories
        </button>
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : saved ? 'Saved!' : story ? 'Update Story' : 'Publish Story'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 rounded-lg bg-error-50 border border-error-200">
          <p className="font-sans text-sm font-semibold text-error-700">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6 space-y-5">
        <div>
          <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
            Title <span className="text-error-500">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-base text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
            placeholder="Enter story title..."
          />
        </div>

        <div>
          <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
            URL Slug
          </label>
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-mono text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
            placeholder="auto-generated-from-title"
          />
          <p className="font-sans text-xs text-stone-400 mt-1">
            The URL path for this story. Leave blank to auto-generate from the title.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm font-semibold text-stone-700 focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
              Featured Image URL
            </label>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
              placeholder="https://..."
            />
          </div>
        </div>

        {imageUrl && (
          <div className="rounded-lg overflow-hidden border border-stone-200 max-h-48">
            <img src={imageUrl} alt="Preview" className="w-full h-48 object-cover" />
          </div>
        )}

        <div>
          <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
            Excerpt <span className="text-error-500">*</span>
          </label>
          <textarea
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            rows={2}
            maxLength={300}
            className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all resize-none"
            placeholder="A short summary that appears on the homepage and story cards..."
          />
          <p className="font-sans text-xs text-stone-400 mt-1 text-right">
            {excerpt.length}/300
          </p>
        </div>

        <div>
          <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
            Body <span className="text-error-500">*</span>
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all resize-y"
            placeholder="Write the full story here. Use blank lines to separate paragraphs."
          />
        </div>

        <div className="flex flex-col sm:flex-row gap-4 pt-2 border-t border-stone-100">
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => setPublished(!published)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                published ? 'bg-success-500' : 'bg-stone-300'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  published ? 'translate-x-5' : ''
                }`}
              />
            </button>
            <span className="font-sans text-sm font-semibold text-stone-700">
              {published ? 'Published' : 'Draft'}
            </span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              onClick={() => setIsHeadline(!isHeadline)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                isHeadline ? 'bg-accent-500' : 'bg-stone-300'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  isHeadline ? 'translate-x-5' : ''
                }`}
              />
            </button>
            <span className="font-sans text-sm font-semibold text-stone-700 flex items-center gap-1">
              <Star className={`w-4 h-4 ${isHeadline ? 'text-accent-500 fill-accent-500' : 'text-stone-400'}`} />
              Headline story
            </span>
          </label>
        </div>
      </div>
    </form>
  );
}

// ============================================================
// CONFIRM DIALOG
// ============================================================
function ConfirmDialog({
  title,
  message,
  confirmLabel,
  loading,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-error-100 flex items-center justify-center flex-shrink-0">
            <Trash2 className="w-5 h-5 text-error-600" />
          </div>
          <div>
            <h3 className="font-serif text-lg font-bold text-stone-900">{title}</h3>
            <p className="font-sans text-sm text-stone-500 mt-1">{message}</p>
          </div>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg font-sans text-sm font-bold text-stone-600 hover:bg-stone-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 rounded-lg font-sans text-sm font-bold text-white bg-error-600 hover:bg-error-700 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
