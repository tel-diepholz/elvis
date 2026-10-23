import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { RequireLogin, ViewOnlyUnlessLoggedIn } from './components/auth/Guards';
import { EmptyState } from './components/ui';
import { AuthProvider } from './lib/auth';
import { LiveProvider } from './lib/live';
import { applyTheme } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { AddonDetailPage } from './pages/AddonDetailPage';
import { AddonsPage } from './pages/AddonsPage';
import { ArchivedIncidentPage, ArchivePage } from './pages/ArchivePage';
import { CommsPage } from './pages/CommsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DockerHostsPage } from './pages/DockerHostsPage';
import { DocumentsPage, JournalPage, UnitsPage } from './pages/IncidentAreaPages';
import { IncidentPage } from './pages/IncidentPage';
import { MapPage } from './pages/MapPage';
import { CamerasPage } from './pages/CamerasPage';
import { DisplayScreenPage } from './pages/DisplayScreenPage';
import { DisplaysPage } from './pages/DisplaysPage';
import { MediaPage } from './pages/MediaPage';
import { SignGeneratorPage } from './pages/SignGeneratorPage';
import { SystemPage } from './pages/SystemPage';
import { UsersPage } from './pages/UsersPage';
import { VehiclePage } from './pages/VehiclePage';
import { WeatherPage } from './pages/WeatherPage';
import './styles/app.css';

applyTheme();

// Freshness comes from WebSocket invalidations, so no polling or focus refetching.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
        <LiveProvider>
          <BrowserRouter>
            <Routes>
              {/* Gekoppelte Bildschirme: eigene Seite ohne Menü */}
              <Route path="bildschirm" element={<DisplayScreenPage />} />
              <Route element={<Layout />}>
                {/* Fahrzeugbereich – immer verfügbar */}
                <Route index element={<DashboardPage />} />
                <Route path="fahrzeug" element={<ViewOnlyUnlessLoggedIn><VehiclePage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="karte" element={<MapPage />} />
                <Route path="wetter" element={<WeatherPage />} />
                <Route path="netzwerk" element={<ViewOnlyUnlessLoggedIn><CommsPage /></ViewOnlyUnlessLoggedIn>} />
                {/* alte Adresse (Lesezeichen) */}
                <Route path="kommunikation" element={<Navigate to="/netzwerk" replace />} />
                <Route path="bildschirme" element={<ViewOnlyUnlessLoggedIn><DisplaysPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="kameras" element={<ViewOnlyUnlessLoggedIn><CamerasPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="medien" element={<ViewOnlyUnlessLoggedIn><MediaPage /></ViewOnlyUnlessLoggedIn>} />
                {/* Einsatzbereich – Unterseiten erst mit aufgelegtem Einsatz */}
                <Route path="einsatz" element={<RequireLogin><IncidentPage /></RequireLogin>} />
                <Route path="einsatz/tagebuch" element={<RequireLogin><JournalPage /></RequireLogin>} />
                <Route path="einsatz/kraefte" element={<RequireLogin><UnitsPage /></RequireLogin>} />
                <Route path="einsatz/dokumente" element={<RequireLogin><DocumentsPage /></RequireLogin>} />
                {/* Verwaltung */}
                <Route path="archiv" element={<RequireLogin><ArchivePage /></RequireLogin>} />
                <Route path="archiv/:id" element={<RequireLogin><ArchivedIncidentPage /></RequireLogin>} />
                <Route path="addons" element={<RequireLogin admin><AddonsPage /></RequireLogin>} />
                <Route path="addons/:id" element={<RequireLogin admin><AddonDetailPage /></RequireLogin>} />
                <Route path="docker-hosts" element={<RequireLogin admin><DockerHostsPage /></RequireLogin>} />
                <Route path="benutzer" element={<RequireLogin><UsersPage /></RequireLogin>} />
                <Route path="zeichen" element={<SignGeneratorPage />} />
                <Route path="system" element={<RequireLogin><SystemPage /></RequireLogin>} />
                <Route path="*" element={<EmptyState title="Seite nicht gefunden" />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </LiveProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
