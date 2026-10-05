import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { Header, Footer } from '@/components/Layout';
import { HomePage } from '@/pages/HomePage';
import { StoryDetailPage } from '@/pages/StoryDetailPage';
import { AuthPage } from '@/pages/AuthPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { StoryManagerPage } from '@/pages/StoryManagerPage';

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <div className="min-h-screen flex flex-col bg-stone-50">
          {/* HashRouter reads the URL fragment as the route, so a plain
              `#main-content` href would route to `/main-content` and land on
              the catch-all home page instead of skipping the nav. Focusing
              the target by hand and cancelling the default keeps the hash on
              the current route. `tabIndex={-1}` below is what makes that
              target focusable. */}
          <a
            href="#main-content"
            className="skip-link"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('main-content')?.focus();
            }}
          >
            Skip to main content
          </a>
          <Header />
          <main id="main-content" tabIndex={-1} className="flex-1">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/story/:slug" element={<StoryDetailPage />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/stories" element={<StoryManagerPage />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          </main>
          <Footer />
        </div>
      </HashRouter>
    </AuthProvider>
  );
}

export default App;
