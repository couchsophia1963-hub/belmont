import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { Header, Footer } from '@/components/Layout';
import { HomePage } from '@/pages/HomePage';
import { StoryDetailPage } from '@/pages/StoryDetailPage';
import { AuthPage } from '@/pages/AuthPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StoryManagerPage } from '@/pages/StoryManagerPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { legacyHashRouteTarget } from '@/lib/legacyHashRoute';

/**
 * Rewrites a stranded `#/story/<slug>` address to `/story/<slug>` (BEL-142).
 *
 * `BrowserRouter` (BEL-92) reads the path and ignores the hash, so every link
 * the old `HashRouter` app handed out mounted on `/` and rendered the
 * homepage with a 200. The decision is in `legacyHashRouteTarget`; this only
 * applies it.
 *
 * `replace` rather than `push`, because the reader never chose to be on the
 * homepage. Pushing would put the homepage in their history and Back would
 * appear to do nothing.
 *
 * After the rewrite the hash is gone, so the target becomes `null` and the
 * effect stops. That is what keeps this from looping.
 */
function LegacyHashRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  const target = legacyHashRouteTarget(location.hash, location.pathname, location.search);

  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target, navigate]);

  return null;
}

function App() {
  return (
    <ThemeProvider>
    <AuthProvider>
      {/* BrowserRouter, not HashRouter (BEL-92). The host returns index.html
          for any path, so `/story/<slug>` reaches this router and renders the
          story. On a HashRouter the same request mounted on an empty hash and
          rendered the homepage with a 200, so a link arriving from anywhere
          outside the site landed on the front page with no error anywhere.
          The cost of BrowserRouter is that the host must serve index.html for
          unknown paths; this one does, verified 2026-10-05. */}
      <BrowserRouter>
        <LegacyHashRedirect />
        <div className="min-h-screen flex flex-col bg-stone-50 dark:bg-stone-950">
          <Header />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/story/:slug" element={<StoryDetailPage />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/stories" element={<StoryManagerPage />} />
              {/* A mistyped or retired slug must say so. This used to render
                  HomePage, which made a bad link indistinguishable from the
                  front page. */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
          <Footer />
        </div>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
