import { useEffect, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { ApiKey, Profile, Story, UserRole } from '@/types';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  Users,
  Shield,
  PenTool,
  User as UserIcon,
  FileText,
  Cloud,
  Eye,
  EyeOff,
  RefreshCw,
} from 'lucide-react';

export function DashboardPage() {
  const { session, profile, loading, refreshProfile } = useAuth();

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

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="font-serif text-3xl font-black text-stone-900">Dashboard</h1>
        <p className="font-sans text-sm text-stone-500 mt-1">
          Welcome back, {profile.display_name || profile.email}
        </p>
        <div className="mt-3 inline-flex items-center gap-2">
          <span className="font-sans text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full bg-primary-100 text-primary-700">
            {profile.role}
          </span>
        </div>
      </div>

      {profile.role === 'user' && <UserDashboard profile={profile} refreshProfile={refreshProfile} />}
      {profile.role === 'writer' && (
        <>
          <UserDashboard profile={profile} refreshProfile={refreshProfile} />
          <WriterDashboard userId={session.user.id} />
        </>
      )}
      {profile.role === 'admin' && (
        <>
          <UserDashboard profile={profile} refreshProfile={refreshProfile} />
          <WriterDashboard userId={session.user.id} />
          <AdminDashboard />
        </>
      )}
    </div>
  );
}

// ============================================================
// USER DASHBOARD - profile settings
// ============================================================
function UserDashboard({
  profile,
  refreshProfile,
}: {
  profile: Profile;
  refreshProfile: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: displayName })
      .eq('id', profile.id);
    setSaving(false);
    if (!error) {
      setSaved(true);
      await refreshProfile();
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <section className="mb-8">
      <SectionHeader icon={<UserIcon className="w-5 h-5" />} title="Profile Settings" />
      <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
        <form onSubmit={handleSave} className="flex flex-col sm:flex-row gap-4 items-start sm:items-end">
          <div className="flex-1 w-full">
            <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 transition-colors flex items-center gap-2 whitespace-nowrap"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
            {saved ? 'Saved!' : 'Save Changes'}
          </button>
        </form>
      </div>
    </section>
  );
}

// ============================================================
// WRITER DASHBOARD - API keys, stories, weather management
// ============================================================
function WriterDashboard({ userId }: { userId: string }) {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [loadingStories, setLoadingStories] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadApiKeys = useCallback(async () => {
    const { data, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (!error) setApiKeys((data ?? []) as ApiKey[]);
    setLoadingKeys(false);
  }, [userId]);

  const loadStories = useCallback(async () => {
    const { data, error } = await supabase
      .from('stories')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);
    if (!error) setStories((data ?? []) as Story[]);
    setLoadingStories(false);
  }, []);

  useEffect(() => {
    loadApiKeys();
    loadStories();
  }, [loadApiKeys, loadStories]);

  const generateApiKey = (): string => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'bcn_';
    for (let i = 0; i < 40; i++) {
      key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreating(true);

    const rawKey = generateApiKey();
    const prefix = rawKey.substring(0, 12);
    const { error } = await supabase.from('api_keys').insert({
      user_id: userId,
      key_hash: rawKey,
      key_prefix: prefix,
      name: newKeyName.trim(),
    });

    setCreating(false);
    if (error) {
      alert('Failed to create API key: ' + error.message);
      return;
    }
    setNewKey(rawKey);
    setNewKeyName('');
    await loadApiKeys();
  };

  const handleRerollKey = async (keyId: string) => {
    if (!confirm('Generate a new key? The old key will stop working immediately.')) return;
    const rawKey = generateApiKey();
    const prefix = rawKey.substring(0, 12);
    const { error } = await supabase
      .from('api_keys')
      .update({ key_hash: rawKey, key_prefix: prefix })
      .eq('id', keyId);
    if (error) {
      alert('Failed to reroll key: ' + error.message);
      return;
    }
    setNewKey(rawKey);
    await loadApiKeys();
  };

  const handleDeleteKey = async (keyId: string) => {
    if (!confirm('Delete this API key? This cannot be undone.')) return;
    const { error } = await supabase.from('api_keys').delete().eq('id', keyId);
    if (error) {
      alert('Failed to delete key: ' + error.message);
      return;
    }
    await loadApiKeys();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {/* API Keys Section */}
      <section className="mb-8">
        <SectionHeader icon={<Key className="w-5 h-5" />} title="API Keys" />
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
          <p className="font-sans text-sm text-stone-500 mb-4">
            Use your API keys to programmatically manage stories and weather via the REST API.
          </p>

          {newKey && (
            <div className="mb-6 p-4 rounded-lg bg-success-500/10 border border-success-500/30">
              <p className="font-sans text-sm font-bold text-success-700 mb-2">
                Your new API key (copy it now — you won't see it again):
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded bg-white border border-stone-200 font-mono text-xs text-stone-800 break-all">
                  {newKey}
                </code>
                <button
                  onClick={() => copyToClipboard(newKey)}
                  className="p-2 rounded-lg bg-success-600 text-white hover:bg-success-700 transition-colors flex-shrink-0"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setNewKey(null)}
                  className="p-2 rounded-lg bg-stone-200 text-stone-600 hover:bg-stone-300 transition-colors flex-shrink-0"
                >
                  <EyeOff className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {loadingKeys ? (
            <div className="h-16 rounded-lg shimmer" />
          ) : apiKeys.length === 0 ? (
            <div className="py-8 text-center">
              <Key className="w-10 h-10 text-stone-300 mx-auto mb-2" />
              <p className="font-sans text-sm text-stone-400">No API keys yet</p>
            </div>
          ) : (
            <div className="space-y-3 mb-6">
              {apiKeys.map((key) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between p-4 rounded-lg bg-stone-50 border border-stone-200"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-sans text-sm font-bold text-stone-800">
                        {key.name}
                      </span>
                      {key.last_used_at && (
                        <span className="font-sans text-xs text-stone-400">
                          Last used {new Date(key.last_used_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <code className="font-mono text-xs text-stone-500 mt-1 block">
                      {key.key_prefix}…
                    </code>
                  </div>
                  <div className="flex items-center gap-1 ml-3 flex-shrink-0">
                    <button
                      onClick={() => handleRerollKey(key.id)}
                      className="p-2 rounded-lg text-stone-400 hover:text-primary-700 hover:bg-primary-50 transition-colors"
                      title="Reroll key"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteKey(key.id)}
                      className="p-2 rounded-lg text-stone-400 hover:text-error-600 hover:bg-error-50 transition-colors"
                      title="Delete key"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleCreateKey} className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block font-sans text-sm font-semibold text-stone-700 mb-1.5">
                New API Key Name
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production Writer Bot"
                className="w-full px-4 py-2.5 rounded-lg border border-stone-300 font-sans text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
              />
            </div>
            <button
              type="submit"
              disabled={creating || !newKeyName.trim()}
              className="px-5 py-2.5 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 transition-colors flex items-center gap-2 whitespace-nowrap"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Generate
            </button>
          </form>

          {/* API Documentation */}
          <div className="mt-6 p-4 rounded-lg bg-stone-900 text-stone-300 overflow-x-auto">
            <p className="font-sans text-xs font-bold text-white mb-3 uppercase tracking-wider">
              API Usage Examples
            </p>
            <pre className="font-mono text-xs leading-relaxed whitespace-pre">{`# Create a story
curl -X POST ${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"resource":"stories","action":"create",
       "data":{"title":"...","body":"...","category":"..."}}'

# Update weather
curl -X POST ${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"resource":"weather","action":"upsert",
       "data":{"forecast_date":"2026-10-05","high_temp":70,...}}'`}</pre>
          </div>
        </div>
      </section>

      {/* Recent Stories */}
      <section className="mb-8">
        <SectionHeader icon={<FileText className="w-5 h-5" />} title="Recent Stories" />
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
          {loadingStories ? (
            <div className="h-16 rounded-lg shimmer" />
          ) : stories.length === 0 ? (
            <p className="font-sans text-sm text-stone-400 py-4 text-center">
              No stories published yet.
            </p>
          ) : (
            <div className="space-y-3">
              {stories.map((story) => (
                <div
                  key={story.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-stone-50 border border-stone-200"
                >
                  <div className="min-w-0 flex-1">
                    <h4 className="font-sans text-sm font-bold text-stone-800 truncate">
                      {story.title}
                    </h4>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-sans text-xs text-primary-600 font-semibold">
                        {story.category}
                      </span>
                      {story.is_headline && (
                        <span className="font-sans text-xs font-bold text-accent-600 bg-accent-50 px-2 py-0.5 rounded-full">
                          Headline
                        </span>
                      )}
                      <span className="font-sans text-xs text-stone-400">
                        {new Date(story.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Weather Management */}
      <WeatherManagement />
    </>
  );
}

// ============================================================
// WEATHER MANAGEMENT
// ============================================================
function WeatherManagement() {
  const [forecasts, setForecasts] = useState<Array<{
    id: string;
    forecast_date: string;
    high_temp: number;
    low_temp: number;
    condition: string;
    icon: string;
    humidity: number;
    wind_speed: number;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadWeather = useCallback(async () => {
    const { data } = await supabase
      .from('weather_forecasts')
      .select('*')
      .order('forecast_date', { ascending: true })
      .limit(7);
    setForecasts(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadWeather();
  }, [loadWeather]);

  const updateField = (id: string, field: string, value: string | number) => {
    setForecasts((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f))
    );
  };

  const handleSave = async () => {
    setSaving(true);
    for (const f of forecasts) {
      await supabase
        .from('weather_forecasts')
        .update({
          high_temp: f.high_temp,
          low_temp: f.low_temp,
          condition: f.condition,
          icon: f.icon,
          humidity: f.humidity,
          wind_speed: f.wind_speed,
        })
        .eq('id', f.id);
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const CONDITIONS = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Showers', 'Rain', 'Thunderstorms', 'Snow', 'Fog'];
  const ICONS = ['sun', 'cloud-sun', 'cloud', 'cloud-rain', 'cloud-lightning', 'cloud-snow', 'cloud-fog'];

  return (
    <section className="mb-8">
      <SectionHeader icon={<Cloud className="w-5 h-5" />} title="Weather Management" />
      <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
        <p className="font-sans text-sm text-stone-500 mb-4">
          Edit the weather forecast. Changes appear on the homepage immediately.
        </p>

        {loading ? (
          <div className="h-32 rounded-lg shimmer" />
        ) : forecasts.length === 0 ? (
          <p className="font-sans text-sm text-stone-400 py-4 text-center">
            No weather data available.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200">
                    <th className="text-left py-2 px-2 font-sans font-bold text-stone-600">Date</th>
                    <th className="py-2 px-2 font-sans font-bold text-stone-600">High</th>
                    <th className="py-2 px-2 font-sans font-bold text-stone-600">Low</th>
                    <th className="text-left py-2 px-2 font-sans font-bold text-stone-600">Condition</th>
                    <th className="text-left py-2 px-2 font-sans font-bold text-stone-600">Icon</th>
                    <th className="py-2 px-2 font-sans font-bold text-stone-600">Humidity</th>
                    <th className="py-2 px-2 font-sans font-bold text-stone-600">Wind</th>
                  </tr>
                </thead>
                <tbody>
                  {forecasts.map((f) => (
                    <tr key={f.id} className="border-b border-stone-100">
                      <td className="py-2 px-2 font-sans text-stone-700 whitespace-nowrap">
                        {new Date(f.forecast_date + 'T00:00:00').toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          value={f.high_temp}
                          onChange={(e) => updateField(f.id, 'high_temp', parseInt(e.target.value) || 0)}
                          className="w-16 px-2 py-1 rounded border border-stone-300 font-sans text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary-500"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          value={f.low_temp}
                          onChange={(e) => updateField(f.id, 'low_temp', parseInt(e.target.value) || 0)}
                          className="w-16 px-2 py-1 rounded border border-stone-300 font-sans text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary-500"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          value={f.condition}
                          onChange={(e) => updateField(f.id, 'condition', e.target.value)}
                          className="px-2 py-1 rounded border border-stone-300 font-sans text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                        >
                          {CONDITIONS.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <select
                          value={f.icon}
                          onChange={(e) => updateField(f.id, 'icon', e.target.value)}
                          className="px-2 py-1 rounded border border-stone-300 font-sans text-sm focus:outline-none focus:ring-1 focus:ring-primary-500"
                        >
                          {ICONS.map((i) => (
                            <option key={i} value={i}>{i}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          value={f.humidity}
                          onChange={(e) => updateField(f.id, 'humidity', parseInt(e.target.value) || 0)}
                          className="w-16 px-2 py-1 rounded border border-stone-300 font-sans text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary-500"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="number"
                          value={f.wind_speed}
                          onChange={(e) => updateField(f.id, 'wind_speed', parseInt(e.target.value) || 0)}
                          className="w-16 px-2 py-1 rounded border border-stone-300 font-sans text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary-500"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : null}
                {saved ? 'Saved!' : 'Save Weather'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ============================================================
// ADMIN DASHBOARD - user management
// ============================================================
function AdminDashboard() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    setUsers((data ?? []) as Profile[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    setUpdating(userId);
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', userId);
    setUpdating(null);
    if (error) {
      alert('Failed to update role: ' + error.message);
      return;
    }
    await loadUsers();
  };

  return (
    <section className="mb-8">
      <SectionHeader icon={<Shield className="w-5 h-5" />} title="Admin — User Management" />
      <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-6">
        <p className="font-sans text-sm text-stone-500 mb-4">
          Manage user roles and permissions across the platform.
        </p>

        {loading ? (
          <div className="h-32 rounded-lg shimmer" />
        ) : users.length === 0 ? (
          <div className="py-8 text-center">
            <Users className="w-10 h-10 text-stone-300 mx-auto mb-2" />
            <p className="font-sans text-sm text-stone-400">No users found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="text-left py-2 px-3 font-sans font-bold text-stone-600">User</th>
                  <th className="text-left py-2 px-3 font-sans font-bold text-stone-600">Email</th>
                  <th className="text-left py-2 px-3 font-sans font-bold text-stone-600">Joined</th>
                  <th className="text-left py-2 px-3 font-sans font-bold text-stone-600">Role</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b border-stone-100">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-sans font-bold text-sm">
                          {(user.display_name || user.email).charAt(0).toUpperCase()}
                        </div>
                        <span className="font-sans font-semibold text-stone-800">
                          {user.display_name || '—'}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-3 font-sans text-stone-500">{user.email}</td>
                    <td className="py-3 px-3 font-sans text-stone-400 whitespace-nowrap">
                      {new Date(user.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-3">
                      <select
                        value={user.role}
                        disabled={updating === user.id}
                        onChange={(e) => handleRoleChange(user.id, e.target.value as UserRole)}
                        className="px-3 py-1.5 rounded-lg border border-stone-300 font-sans text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-50"
                      >
                        <option value="user">User</option>
                        <option value="writer">Writer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================
// SHARED
// ============================================================
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="w-8 h-8 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
        {icon}
      </div>
      <h2 className="font-serif text-xl font-bold text-stone-900">{title}</h2>
    </div>
  );
}
