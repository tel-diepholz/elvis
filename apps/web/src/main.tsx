import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
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
import { FunkPage } from './pages/FunkPage';
import { DashboardPage } from './pages/DashboardPage';
import { DockerHostsPage } from './pages/DockerHostsPage';
import { DamagePage, DocumentsPage, JournalPage, MessagesPage, RequestsPage, TasksPage, UnitsPage } from './pages/IncidentAreaPages';
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
import { MailPage } from './pages/MailPage';
import { ChatPage } from './pages/ChatPage';
import { TelefoniePage } from './pages/TelefoniePage';
import { PhonesPage } from './pages/PhonesPage';
import { ContactsPage } from './pages/ContactsPage';
import { LibraryPage } from './pages/LibraryPage';
import { ScanPage } from './pages/ScanPage';
import { UsersPage } from './pages/UsersPage';
import { WeatherPage } from './pages/WeatherPage';
import { AuditPage } from './pages/AuditPage';
import { EnergyPage } from './pages/EnergyPage';
import { SettingsPage } from './pages/SettingsPage';
import { LogoPage } from './pages/LogoPage';
import { MonitoringPage } from './pages/MonitoringPage';
import './styles/app.css';

applyTheme();

/** Alte Adressen /einsatz/… → /lage/… (Unterseite, Suche und Anker bleiben erhalten) */
function LegacyIncidentRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${pathname.replace(/^\/einsatz/, '/lage')}${search}${hash}`} replace />;
}
function LegacyUnitRedirect() {
  const { id } = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`/lage/kraefte/${id}${search}${hash}`} replace />;
}

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
                <Route path="logo" element={<LogoPage />} />
                <Route path="netzwerk" element={<ViewOnlyUnlessLoggedIn><CommsPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="funk" element={<ViewOnlyUnlessLoggedIn><FunkPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="telefonie" element={<ViewOnlyUnlessLoggedIn><TelefoniePage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="telefone" element={<RequireLogin><PhonesPage /></RequireLogin>} />
                {/* alte Adresse (Lesezeichen) */}
                <Route path="kommunikation" element={<Navigate to="/netzwerk" replace />} />
                <Route path="fahrzeug" element={<Navigate to="/" replace />} />
                <Route path="bildschirme" element={<ViewOnlyUnlessLoggedIn><DisplaysPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="kameras" element={<ViewOnlyUnlessLoggedIn><CamerasPage /></ViewOnlyUnlessLoggedIn>} />
                <Route path="medien" element={<Navigate to="/" replace />} />
                {/* Lagebereich – Unterseiten erst mit aufgelegter Lage */}
                <Route path="lage" element={<RequireLogin><IncidentPage /></RequireLogin>} />
                <Route path="lage/tagebuch" element={<RequireLogin><JournalPage /></RequireLogin>} />
                <Route path="lage/aufgaben" element={<RequireLogin><TasksPage /></RequireLogin>} />
                <Route path="lage/meldungen" element={<RequireLogin><MessagesPage /></RequireLogin>} />
                <Route path="lage/anforderungen" element={<RequireLogin><RequestsPage /></RequireLogin>} />
                <Route path="lage/schadenkonten" element={<RequireLogin><DamagePage /></RequireLogin>} />
                <Route path="lage/kraefte" element={<RequireLogin><UnitsPage /></RequireLogin>} />
                {/* auch für abgeschlossene Lagen (aus dem Archiv) */}
                <Route path="lage/kraefte/:id" element={<RequireLogin><UnitDetailPage /></RequireLogin>} />
                <Route path="lage/dokumente" element={<RequireLogin><DocumentsPage /></RequireLogin>} />
                {/* alte Adressen /einsatz/… (Lesezeichen) */}
                <Route path="einsatz" element={<Navigate to="/lage" replace />} />
                <Route path="einsatz/kraefte/:id" element={<LegacyUnitRedirect />} />
                <Route path="einsatz/*" element={<LegacyIncidentRedirect />} />
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
                <Route path="mail" element={<RequireLogin><MailPage /></RequireLogin>} />
                <Route path="nachrichten" element={<RequireLogin><ChatPage /></RequireLogin>} />
                <Route path="sms" element={<Navigate to="/nachrichten" replace />} />
                <Route path="kontakte" element={<RequireLogin><ContactsPage /></RequireLogin>} />
                <Route path="objekte" element={<RequireLogin><LibraryPage /></RequireLogin>} />
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
