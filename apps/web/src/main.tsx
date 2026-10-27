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
import { DocumentsPage, JournalPage, MessagesPage, RequestsPage, TasksPage, UnitsPage } from './pages/IncidentAreaPages';
import { IncidentPage } from './pages/IncidentPage';
import { UnitDetailPage } from './pages/incident/UnitDetailPage';
import { MapPage } from './pages/MapPage';
import { AircraftDetailPage, ShipDetailPage } from './pages/map/TrafficDetailPage';
import { CamerasPage } from './pages/CamerasPage';
import { DisplayScreenPage } from './pages/DisplayScreenPage';
import { DisplaysPage } from './pages/DisplaysPage';
import { DocumentEditorPage, TemplateEditorPage } from './pages/OfficeEditorPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SignGeneratorPage } from './pages/SignGeneratorPage';
import { PrintPage } from './pages/PrintPage';
import { ScanPage } from './pages/ScanPage';
import { UsersPage } from './pages/UsersPage';
import { WeatherPage } from './pages/WeatherPage';
import { AuditPage } from './pages/AuditPage';
import { EnergyPage } from './pages/EnergyPage';
import { SettingsPage } from './pages/SettingsPage';
import { MonitoringPage } from './pages/MonitoringPage';
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
                <Route path="karte" element={<MapPage />} />
                <Route path="karte/flugzeug/:hex" element={<AircraftDetailPage />} />
                <Route path="karte/schiff/:mmsi" element={<ShipDetailPage />} />
                <Route path="wetter" element={<WeatherPage />} />
                <Route path="energie" element={<EnergyPage />} />
                <Route path="monitoring" element={<MonitoringPage />} />
                <Route path="netzwerk" element={<ViewOnlyUnlessLoggedIn><CommsPage /></ViewOnlyUnlessLoggedIn>} />
                {/* alte Adresse (Lesezeichen) */}
                <Route path="kommunikation" element={<Navigate to="/netzwerk" replace />} />
                <Route path="fahrzeug" element={<Navigate to="/" replace />} />
                <Route path="bildschirme" element={<ViewOnlyUnlessLoggedIn><DisplaysPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="kameras" element={<ViewOnlyUnlessLoggedIn><CamerasPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="medien" element={<Navigate to="/" replace />} />
                {/* Einsatzbereich – Unterseiten erst mit aufgelegtem Einsatz */}
                <Route path="einsatz" element={<RequireLogin><IncidentPage /></RequireLogin>} />
                <Route path="einsatz/tagebuch" element={<RequireLogin><JournalPage /></RequireLogin>} />
                <Route path="einsatz/aufgaben" element={<RequireLogin><TasksPage /></RequireLogin>} />
                <Route path="einsatz/meldungen" element={<RequireLogin><MessagesPage /></RequireLogin>} />
                <Route path="einsatz/anforderungen" element={<RequireLogin><RequestsPage /></RequireLogin>} />
                <Route path="einsatz/kraefte" element={<RequireLogin><UnitsPage /></RequireLogin>} />
                {/* auch für abgeschlossene Einsätze (aus dem Archiv) */}
                <Route path="einsatz/kraefte/:id" element={<RequireLogin><UnitDetailPage /></RequireLogin>} />
                <Route path="einsatz/dokumente" element={<RequireLogin><DocumentsPage /></RequireLogin>} />
                <Route path="dokument/:id" element={<RequireLogin><DocumentEditorPage /></RequireLogin>} />
                {/* Verwaltung */}
                <Route path="archiv" element={<RequireLogin><ArchivePage /></RequireLogin>} />
                <Route path="archiv/:id" element={<RequireLogin><ArchivedIncidentPage /></RequireLogin>} />
                <Route path="addons" element={<RequireLogin admin><AddonsPage /></RequireLogin>} />
                <Route path="addons/:id" element={<RequireLogin admin><AddonDetailPage /></RequireLogin>} />
                <Route path="docker-hosts" element={<RequireLogin admin><DockerHostsPage /></RequireLogin>} />
                <Route path="vorlagen" element={<RequireLogin admin><TemplatesPage /></RequireLogin>} />
                <Route path="vorlagen/:id/bearbeiten" element={<RequireLogin admin><TemplateEditorPage /></RequireLogin>} />
                <Route path="benutzer" element={<RequireLogin><UsersPage /></RequireLogin>} />
                <Route path="zeichen" element={<SignGeneratorPage />} />
                <Route path="drucken" element={<PrintPage />} />
                <Route path="scans" element={<RequireLogin><ScanPage /></RequireLogin>} />
                <Route path="protokoll" element={<RequireLogin admin><AuditPage /></RequireLogin>} />
                <Route path="einstellungen" element={<RequireLogin admin><SettingsPage /></RequireLogin>} />
                {/* alte Adresse (Lesezeichen) */}
                <Route path="system" element={<Navigate to="/einstellungen" replace />} />
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
