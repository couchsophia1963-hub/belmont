import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Newspaper, Mail, Lock, User, Loader2, AlertCircle } from 'lucide-react';

export function AuthPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { signIn, signUp, session } = useAuth();
  const isSignUp = searchParams.get('mode') === 'signup';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) navigate('/dashboard');
  }, [session, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    if (isSignUp) {
      const { error: signUpError } = await signUp(email, password, displayName);
      if (signUpError) {
        setError(signUpError);
        setLoading(false);
        return;
      }
      navigate('/dashboard');
    } else {
      const { error: signInError } = await signIn(email, password);
      if (signInError) {
        setError(signInError);
        setLoading(false);
        return;
      }
      navigate('/dashboard');
    }
  };

  const switchMode = () => {
    setError(null);
    setSearchParams(isSignUp ? {} : { mode: 'signup' });
  };

  return (
    <div className="min-h-[calc(100vh-200px)] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-primary-700 items-center justify-center mb-4 shadow-lg">
            <Newspaper className="w-9 h-9 text-white" />
          </div>
          <h1 className="font-serif text-3xl font-black text-stone-900 dark:text-stone-50">
            {isSignUp ? 'Create Account' : 'Welcome Back'}
          </h1>
          <p className="font-sans text-sm text-stone-500 dark:text-stone-400 mt-2">
            {isSignUp
              ? 'Join the Belmont County News community'
              : 'Sign in to comment and manage your account'}
          </p>
        </div>

        <div className="bg-white dark:bg-stone-900 rounded-2xl shadow-lg border border-stone-200 dark:border-stone-700 p-8">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-error-500/10 border border-error-500/30 flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-error-600 flex-shrink-0 mt-0.5" />
              <p className="font-sans text-sm text-error-700">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <div>
                <label className="block font-sans text-sm font-semibold text-stone-700 dark:text-stone-200 mb-1.5">
                  Display Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-400 dark:text-stone-500" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    className="w-full pl-11 pr-4 py-3 rounded-lg border border-stone-300 dark:border-stone-600 font-sans text-sm text-stone-900 dark:text-stone-100 dark:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                    placeholder="Your name"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block font-sans text-sm font-semibold text-stone-700 dark:text-stone-200 mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-400 dark:text-stone-500" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-stone-300 dark:border-stone-600 font-sans text-sm text-stone-900 dark:text-stone-100 dark:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div>
              <label className="block font-sans text-sm font-semibold text-stone-700 dark:text-stone-200 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-stone-400 dark:text-stone-500" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-stone-300 dark:border-stone-600 font-sans text-sm text-stone-900 dark:text-stone-100 dark:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={switchMode}
              className="font-sans text-sm text-primary-700 dark:text-primary-400 hover:underline"
            >
              {isSignUp
                ? 'Already have an account? Sign in'
                : "Don't have an account? Sign up"}
            </button>
          </div>
        </div>

        <p className="text-center mt-4">
          <Link
            to="/"
            className="font-sans text-sm text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
          >
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
