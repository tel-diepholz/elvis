/**
 * Updates von ELVIS lite (Windows): Einstellungen → Update sucht auf GitHub nach einem neueren Release mit
 * Windows-Installer und installiert es. Der Installer ist mit Ed25519 signiert (Datei <Installer>.sig, Base64).
 */

/** Dateiname des Installers in einem Release; die Gruppe ist die Version */
export const UPDATE_INSTALLER_PATTERN = /^ELVIS-lite-(\d+\.\d+\.\d+)-setup\.exe$/;

export interface UpdateRelease {
  version: string;
  tag: string;
  name: string;
  /** Release-Notizen (Markdown) */
  notes: string;
  publishedAt: string;
  url: string;
  /** Größe des Installers in Bytes */
  size: number;
}

/** idle = nichts läuft; installing = Installer übernommen, ELVIS startet gleich neu */
export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'installing' | 'failed';

/** Ergebnis des letzten Updates, vom Installer nach dem Neustart hinterlegt */
export interface UpdateResult {
  from: string;
  to: string;
  ok: boolean;
  /** Neue Version kam nicht hoch, alte Version und Datenbank wurden wiederhergestellt */
  rolledBack: boolean;
  at: string;
}

export interface UpdateStatus {
  current: string;
  /** Kann hier installiert werden? (nur ELVIS lite als Windows-Dienst) */
  installable: boolean;
  /** Warum nicht installiert werden kann */
  reason: string | null;
  checkedAt: string | null;
  checkError: string | null;
  latest: UpdateRelease | null;
  available: boolean;
  phase: UpdatePhase;
  /** Fortschritt des Downloads 0–1 */
  progress: number | null;
  message: string | null;
  lastResult: UpdateResult | null;
}
