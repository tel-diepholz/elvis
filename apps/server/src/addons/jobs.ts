import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import type Docker from 'dockerode';
import type { Db } from '../db/index.js';

export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface JobRunRow {
  id: number;
  addon_id: string;
  job_id: string;
  status: JobRunStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  triggered_by: string;
  message: string;
  /** JSON: Ergebnis je Schritt (AddonJobStepState[]). */
  steps: string;
}

/** Verlauf der Job-Läufe (für Zeitplan, „wartet auf ersten Lauf“ und Anzeige). */
export class JobRuns {
  constructor(private readonly db: Db) {}

  start(addonId: string, jobId: string, triggeredBy: string): number {
    const info = this.db
      .prepare("INSERT INTO addon_job_runs (addon_id, job_id, status, started_at, triggered_by) VALUES (?, ?, 'running', ?, ?)")
      .run(addonId, jobId, new Date().toISOString(), triggeredBy);
    return Number(info.lastInsertRowid);
  }

  finish(id: number, status: Exclude<JobRunStatus, 'running'>, exitCode: number | null, message: string, steps: unknown[]): void {
    this.db
      .prepare('UPDATE addon_job_runs SET status = ?, finished_at = ?, exit_code = ?, message = ?, steps = ? WHERE id = ?')
      .run(status, new Date().toISOString(), exitCode, message, JSON.stringify(steps), id);
  }

  latest(addonId: string, jobId: string): JobRunRow | null {
    return (this.db.prepare('SELECT * FROM addon_job_runs WHERE addon_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1').get(addonId, jobId) as JobRunRow | undefined) ?? null;
  }

  lastSuccess(addonId: string, jobId: string): JobRunRow | null {
    return (
      (this.db.prepare("SELECT * FROM addon_job_runs WHERE addon_id = ? AND job_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1").get(addonId, jobId) as JobRunRow | undefined) ?? null
    );
  }

  /** Nach einem Neustart von ELVIS: Läufe ohne Abschluss gelten als unterbrochen. */
  markInterrupted(): number {
    return this.db.prepare("UPDATE addon_job_runs SET status = 'interrupted', finished_at = ?, message = 'ELVIS wurde während des Laufs neu gestartet' WHERE status = 'running'").run(new Date().toISOString()).changes;
  }

  deleteForAddon(addonId: string): void {
    this.db.prepare('DELETE FROM addon_job_runs WHERE addon_id = ?').run(addonId);
  }
}

/** Folgt dem Protokoll eines laufenden Containers zeilenweise, bis der Container endet. */
export async function followLogs(docker: Docker, container: Docker.Container, onLine: (line: string) => void): Promise<void> {
  const stream = (await container.logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream;
  const out = new PassThrough();
  docker.modem.demuxStream(stream, out, out);
  const rl = createInterface({ input: out });
  // Fortschrittsanzeigen schreiben oft mit \r statt \n – beides als Zeilenende behandeln.
  rl.on('line', (line) => line.split('\r').forEach((part) => part.trim() && onLine(part)));
  await new Promise<void>((resolve) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', () => resolve());
  });
  out.end();
}
