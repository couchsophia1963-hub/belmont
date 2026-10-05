import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { Header, Footer } from '@/components/Layout';
import { Loader2 } from 'lucide-react';

const HomePage = lazy(() => import('@/pages/HomePage').then((m) => ({ default: m.HomePage })));
const StoryDetailPage = lazy(() => import('@/pages/StoryDetailPage').then((m) => ({ default: m.StoryDetailPage })));
const AuthPage = lazy(() => import('@/pages/AuthPage').then((m) => ({ default: m.AuthPage })));
const DashboardPage = lazy(() => import('@/pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const StoryManagerPage = lazy(() => import('@/pages/StoryManagerPage').then((m) => ({ default: m.StoryManagerPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

function PageSpinner() {
  return (
    <div className="flex items-center justify-center py-32">
      <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
    </div>
  );
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
          unknown paths.

          Both hosts are handled, and they need different things. The Bolt host
          serves the app at the domain root and returns index.html for unknown
          paths already, verified 2026-10-05. GitHub Pages serves a project site
          from `/<repo>/` and answers unknown paths with 404.html instead, which
          is what `public/404.html` and the restore in `main.tsx` exist for.

          `basename` is what makes one route table serve both. Without it the
          router would read `/belmont/story/<slug>` as an unknown route and
          render NotFoundPage for a story that exists. It is `/` on the Bolt
          host, so the live deploy is unaffected. Note that the share URL is
          built independently, from the runtime pathname, in `lib/storyUrl.ts` —
          that is deliberate, so the two cannot disagree. */}
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <div className="min-h-screen flex flex-col bg-stone-50 dark:bg-stone-950">
          <Header />
          <main className="flex-1">
            <Suspense fallback={<PageSpinner />}>
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
            </Suspense>
          </main>
          <Footer />
        </div>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
