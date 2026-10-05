import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { Header, Footer } from '@/components/Layout';
import { HomePage } from '@/pages/HomePage';
import { StoryDetailPage } from '@/pages/StoryDetailPage';
import { AuthPage } from '@/pages/AuthPage';
import { DashboardPage } from '@/pages/DashboardPage';

function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <div className="min-h-screen flex flex-col bg-stone-50">
          <Header />
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/story/:slug" element={<StoryDetailPage />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
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
