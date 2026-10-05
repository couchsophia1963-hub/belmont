import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import {
  Newspaper,
  LayoutDashboard,
  LogOut,
  User,
  Menu,
  X,
  FileText,
  Sun,
  Moon,
  ChevronDown,
} from 'lucide-react';
import { useState } from 'react';

export function Header() {
  const { session, profile, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate('/');
  };

  return (
    <header className="sticky top-0 z-50 bg-white dark:bg-stone-900 border-b-2 border-primary-700 dark:border-primary-600 shadow-md">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="w-10 h-10 rounded-lg bg-primary-700 flex items-center justify-center group-hover:bg-primary-800 transition-colors">
              <Newspaper className="w-6 h-6 text-white" />
            </div>
            <div className="hidden sm:block">
              <h1 className="font-serif text-xl font-black text-stone-900 dark:text-stone-50 leading-none">
                Belmont County News
              </h1>
              <p className="font-sans text-xs text-stone-500 dark:text-stone-400 leading-none mt-0.5">
                Belmont, Ohio 43718
              </p>
            </div>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <NavLink to="/">Home</NavLink>
            {!session ? (
              <>
                <Link
                  to="/auth"
                  className="ml-2 px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/30 transition-colors"
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
              <ProfileMenu profile={profile} onSignOut={handleSignOut} />
            )}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </nav>

          <div className="flex items-center gap-1 md:hidden">
            {session && <ProfileMenu profile={profile} onSignOut={handleSignOut} />}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <button
              className="p-2 rounded-lg text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            >
              {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {menuOpen && (
        <div className="md:hidden border-t border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900">
          <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-2">
            <Link
              to="/"
              onClick={() => setMenuOpen(false)}
              className="px-3 py-2 rounded-lg font-sans text-sm font-semibold text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              Home
            </Link>
            {!session && (
              <div className="flex gap-2">
                <Link
                  to="/auth"
                  onClick={() => setMenuOpen(false)}
                  className="flex-1 text-center px-4 py-2 rounded-lg font-sans text-sm font-bold text-primary-700 dark:text-primary-400 border border-primary-700 dark:border-primary-500"
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
            )}
          </div>
        </div>
      )}
    </header>
  );
}

function ProfileMenu({
  profile,
  onSignOut,
}: {
  profile: ReturnType<typeof useAuth>['profile'];
  onSignOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative ml-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg px-3 py-2 font-sans text-sm font-semibold text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300">
          <User className="h-4 w-4" />
        </span>
        <span className="hidden lg:inline max-w-32 truncate">
          {profile?.display_name || profile?.email || 'Profile'}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-56 rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 p-2 shadow-xl"
        >
          <div className="border-b border-stone-200 dark:border-stone-700 px-3 pb-2 mb-2">
            <p className="truncate font-sans text-sm font-bold text-stone-900 dark:text-stone-50">
              {profile?.display_name || profile?.email}
            </p>
            {profile && (
              <p className="mt-0.5 font-sans text-xs font-bold uppercase tracking-wider text-primary-700 dark:text-primary-300">
                {profile.role}
              </p>
            )}
          </div>
          <ProfileLink
            to="/dashboard"
            icon={<LayoutDashboard className="h-4 w-4" />}
            onClick={() => setOpen(false)}
          >
            Dashboard
          </ProfileLink>
          {profile && (profile.role === 'writer' || profile.role === 'admin') && (
            <ProfileLink
              to="/stories"
              icon={<FileText className="h-4 w-4" />}
              onClick={() => setOpen(false)}
            >
              Stories
            </ProfileLink>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 font-sans text-sm font-semibold text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileLink({
  to,
  icon,
  children,
  onClick,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-3 py-2 font-sans text-sm font-semibold text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-primary-700 dark:hover:text-primary-400 transition-colors"
    >
      {icon}
      {children}
    </Link>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="ml-1 p-2 rounded-lg text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
    </button>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="px-3 py-2 rounded-lg font-sans text-sm font-semibold text-stone-600 dark:text-stone-300 hover:text-primary-700 dark:hover:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/30 transition-colors flex items-center gap-1.5"
    >
      {children}
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="bg-stone-900 dark:bg-black text-stone-300 dark:text-stone-400 mt-16">
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
        <div className="border-t border-stone-800 dark:border-stone-800 mt-6 pt-6 text-center">
          <p className="font-sans text-xs text-stone-500">
            © {new Date().getFullYear()} Belmont County News. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
