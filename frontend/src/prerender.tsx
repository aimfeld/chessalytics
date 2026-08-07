import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { QueryClient } from '@tanstack/react-query';
import { AuthProvider } from './hooks/useAuth';
import { HomePageContent } from './pages/Home';
import { PrivacyPage } from './pages/Privacy';

export async function prerender(data: { url: string }) {
  // A fresh QueryClient per render — avoids shared state between prerendered routes.
  // AuthProvider is required because HomePageContent uses useAuth() for the guest login handler.
  const prerenderQueryClient = new QueryClient();
  const html = renderToString(
    <QueryClientProvider client={prerenderQueryClient}>
      <AuthProvider>
        <StaticRouter location={data.url}>
          <Routes>
            <Route path="/" element={<HomePageContent />} />
            <Route path="/privacy" element={<PrivacyPage />} />
          </Routes>
        </StaticRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
  return { html };
}
