import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Newspaper, LayoutDashboard, LogOut, User, Menu, X } from 'lucide-react';
import { useState } from 'react';

export function Header() {
  const { session, profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-50 bg-white border-b-2 border-primary-700 shadow-md">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="w-10 h-10 rounded-lg bg-primary-700 flex items-center justify-center group-hover:bg-primary-800 transition-colors">
              <Newspaper className="w-6 h-6 text-white" />
            </div>
            <div className="hidden sm:block">
              <h1 className="font-serif text-xl font-black text-stone-900 leading-none">
                Belmont County News
              </h1>
              <p className="font-sans text-xs text-stone-500 leading-none mt-0.5">
                Belmont, Ohio 43718
              </p>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <NavLink to="/">Home</NavLink>
            {session && <NavLink to="/dashboard">Dashboard</NavLink>}
            {!session ? (
              <>
                <Link
                  to="/auth"
                  className="ml-2 px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 hover:bg-primary-50 transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  to="/auth?mode=signup"
                  className="px-4 py-2 rounded-lg font-sans text-sm font-bold text-white bg-primary-700 hover:bg-primary-800 transition-colors"
                >
                  Sign Up
                </Link>
              </>
            ) : (
              <div className="flex items-center gap-2 ml-2">
                <span className="font-sans text-sm text-stone-600">
                  {profile?.display_name || profile?.email}
                </span>
                {profile && (
                  <span className="font-sans text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary-100 text-primary-700">
                    {profile.role}
                  </span>
                )}
                <button
                  onClick={handleSignOut}
                  className="p-2 rounded-lg text-stone-500 hover:bg-stone-100 transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}
          </nav>

          <button
            className="md:hidden p-2 rounded-lg text-stone-600 hover:bg-stone-100"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="md:hidden border-t border-stone-200 bg-white">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2">
            <Link
              to="/"
              onClick={() => setMenuOpen(false)}
              className="px-3 py-2 rounded-lg font-sans text-sm font-semibold text-stone-700 hover:bg-stone-100"
            >
              Home
            </Link>
            {session && (
              <Link
                to="/dashboard"
                onClick={() => setMenuOpen(false)}
                className="px-3 py-2 rounded-lg font-sans text-sm font-semibold text-stone-700 hover:bg-stone-100"
              >
                Dashboard
              </Link>
            )}
            {!session ? (
              <div className="flex gap-2">
                <Link
                  to="/auth"
                  onClick={() => setMenuOpen(false)}
                  className="flex-1 text-center px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 border border-primary-700"
                >
                  Sign In
                </Link>
                <Link
                  to="/auth?mode=signup"
                  onClick={() => setMenuOpen(false)}
                  className="flex-1 text-center px-4 py-2 rounded-lg font-sans text-sm font-bold text-white bg-primary-700"
                >
                  Sign Up
                </Link>
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-stone-500" />
                  <span className="font-sans text-sm text-stone-700">
                    {profile?.display_name || profile?.email}
                  </span>
                  {profile && (
                    <span className="font-sans text-xs font-bold uppercase px-2 py-0.5 rounded-full bg-primary-100 text-primary-700">
                      {profile.role}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handleSignOut();
                  }}
                  className="p-2 rounded-lg text-stone-500 hover:bg-stone-100"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-2 rounded-lg font-sans text-sm font-semibold text-stone-600 hover:text-primary-700 hover:bg-primary-50 transition-colors flex items-center gap-1.5"
    >
      {to === '/dashboard' && <LayoutDashboard className="w-4 h-4" />}
      {children}
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="bg-stone-900 text-stone-300 mt-16">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-primary-400" />
            <span className="font-serif text-lg font-bold text-white">
              Belmont County News
            </span>
          </div>
          <p className="font-sans text-sm text-stone-400">
            Serving Belmont, Ohio 43718 since 2025
          </p>
        </div>
        <div className="border-t border-stone-800 mt-6 pt-6 text-center">
          <p className="font-sans text-xs text-stone-500">
            © {new Date().getFullYear()} Belmont County News. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
