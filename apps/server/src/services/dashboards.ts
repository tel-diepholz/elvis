import { DEFAULT_DASHBOARD, dashboardLayoutSchema, type DashboardLayout, type DashboardResponse } from '@elvis/shared';
import type { Db } from '../db/index.js';

/** Übersicht: Kachelanordnung je Benutzer – ohne eigene Anordnung gilt die Grundeinstellung */
export class DashboardService {
  constructor(private readonly db: Db) {}

  get(userId: number): DashboardResponse {
    const r = this.db.prepare('SELECT layout_json, updated_at FROM user_dashboards WHERE user_id = ?').get(userId) as { layout_json: string; updated_at: string } | undefined;
    if (r) {
      // Gespeicherte Anordnung mit inzwischen entfernten Kacheltypen o. Ä.: lieber Grundeinstellung als Fehler
      const parsed = dashboardLayoutSchema.safeParse(JSON.parse(r.layout_json));
      if (parsed.success) return { layout: parsed.data, custom: true, updatedAt: r.updated_at };
    }
    return { layout: DEFAULT_DASHBOARD, custom: false, updatedAt: null };
  }

  save(userId: number, layout: DashboardLayout): DashboardResponse {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO user_dashboards (user_id, layout_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(layout), now);
    return this.get(userId);
  }

  reset(userId: number): DashboardResponse {
    this.db.prepare('DELETE FROM user_dashboards WHERE user_id = ?').run(userId);
    return this.get(userId);
  }
}
