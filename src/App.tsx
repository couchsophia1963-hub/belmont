import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { Header, Footer } from '@/components/Layout';
import { HomePage } from '@/pages/HomePage';
import { StoryDetailPage } from '@/pages/StoryDetailPage';
import { AuthPage } from '@/pages/AuthPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StoryManagerPage } from '@/pages/StoryManagerPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

function App() {
  return (
    <AuthProvider>
      {/* BrowserRouter, not HashRouter (BEL-92). The host returns index.html
          for any path, so `/story/<slug>` reaches this router and renders the
          story. On a HashRouter the same request mounted on an empty hash and
          rendered the homepage with a 200, so a link arriving from anywhere
          outside the site landed on the front page with no error anywhere.
          The cost of BrowserRouter is that the host must serve index.html for
          unknown paths; this one does, verified 2026-10-05. */}
      <BrowserRouter>
        <div className="min-h-screen flex flex-col bg-stone-50">
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
  );
}

export default App;
