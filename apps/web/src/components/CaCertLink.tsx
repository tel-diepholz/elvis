import { useState } from 'react';
import { Download, ShieldCheck } from 'lucide-react';
import { Modal } from './ui';

const CA_URL = '/api/tls/ca.crt';

/**
 * Seitenleiste: CA-Zertifikat von ELVIS herunterladen. Wer es installiert, öffnet die HTTPS-Seiten der Addons
 * (z. B. „Bildschirm teilen“) ohne Zertifikatswarnung – die Addons bekommen ihre Zertifikate aus derselben CA.
 */
export function CaCertLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="nav-item nav-item-button" onClick={() => setOpen(true)} title="Zertifikat installieren">
        <ShieldCheck size={20} />
        <span>Zertifikat installieren</span>
      </button>
      <Modal open={open} title="ELVIS-Zertifikat installieren" onClose={() => setOpen(false)}>
        <div className="ca-cert">
          <p>
            Addons wie die Bildschirmübertragung bieten Seiten über HTTPS an. Ihre Zertifikate stellt ELVIS selbst aus. Damit
            der Browser ihnen ohne Warnung vertraut, das Zertifikat der ELVIS-CA <strong>einmal je Gerät</strong> installieren.
          </p>
          <a className="btn btn-primary" href={CA_URL} download="ELVIS-CA.crt">
            <Download size={18} /> ELVIS-CA.crt herunterladen
          </a>
          <dl>
            <dt>Windows</dt>
            <dd>
              Datei öffnen → <em>Zertifikat installieren</em> → <em>Lokaler Computer</em> → <em>Alle Zertifikate in folgendem Speicher
              speichern</em> → <em>Vertrauenswürdige Stammzertifizierungsstellen</em>. Danach den Browser neu starten.
            </dd>
            <dt>macOS</dt>
            <dd>
              Datei öffnen (Schlüsselbundverwaltung, Schlüsselbund <em>System</em>) → Zertifikat doppelklicken → <em>Vertrauen</em> →{' '}
              <em>Immer vertrauen</em>.
            </dd>
            <dt>iPhone, iPad</dt>
            <dd>
              In Safari herunterladen → <em>Einstellungen → Profil geladen → Installieren</em>. Danach unter{' '}
              <em>Allgemein → Info → Zertifikatsvertrauenseinstellungen</em> „ELVIS Docker CA“ einschalten.
            </dd>
            <dt>Android</dt>
            <dd>
              <em>Einstellungen → Sicherheit → Weitere Einstellungen → Verschlüsselung und Anmeldedaten → Zertifikat installieren →
              CA-Zertifikat</em> (je nach Hersteller leicht anders).
            </dd>
            <dt>Linux</dt>
            <dd>
              Chrome/Edge: <em>Einstellungen → Datenschutz und Sicherheit → Zertifikate verwalten → Zertifizierungsstellen →
              Importieren</em>. Firefox: <em>Einstellungen → Zertifikate anzeigen → Zertifizierungsstellen → Importieren</em>.
            </dd>
          </dl>
          <p className="muted">
            Firefox unter Windows und macOS nutzt die Zertifikate des Systems. Falls er trotzdem warnt: unter{' '}
            <em>about:config</em> <code>security.enterprise_roots.enabled</code> auf <code>true</code> setzen.
          </p>
        </div>
      </Modal>
    </>
  );
}
