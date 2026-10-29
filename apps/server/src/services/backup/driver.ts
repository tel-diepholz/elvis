import type { BackupQuota } from '@elvis/shared';

/** Ein Backup beim Treiber; meta ist mit dem Backup-Schlüssel verschlüsselt */
export interface StoredBackup {
  id: string;
  createdAt: string;
  size: number;
  parts: number;
  meta: string;
}

export interface VaultInfo {
  quota: BackupQuota;
  usedBytes: number;
  /** neueste zuerst */
  backups: StoredBackup[];
}

/**
 * Speicherort der Backups. Ein Treiber kennt nur verschlüsselte Daten: Er bekommt Tresor-ID und Zugang aus dem
 * Wiederherstellungsschlüssel und legt Backups als Folge von Teilen ab.
 */
export interface BackupDriver {
  /** Tresor öffnen; create = anlegen, falls es ihn noch nicht gibt (bei der Einrichtung) */
  open(create: boolean): Promise<VaultInfo>;
  info(): Promise<VaultInfo>;
  /** Teile nacheinander hochladen, liefert die Gesamtgröße */
  upload(id: string, meta: string, parts: AsyncIterable<Buffer>): Promise<number>;
  download(backup: StoredBackup): AsyncIterable<Buffer>;
  remove(id: string): Promise<void>;
}
