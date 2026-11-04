import type { FastifyInstance } from 'fastify';
import { energyFlowInputSchema, type EnergyFlowConfig, type EnergyFlowSettings, type Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { operatorOf, parse } from './util.js';

const KEY = 'energyFlow';

/** Gespeicherte Belegung des Energieflusses (Tabelle settings); null = automatisch aus den Geräten */
export function loadEnergyFlow(db: Db): EnergyFlowSettings {
  const r = db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get(KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
  return { config: r ? (JSON.parse(r.value) as EnergyFlowConfig | null) : null, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
}

export function energyFlowRoutes(app: FastifyInstance, deps: { db: Db; store: Store; notify: (topics: Topic[]) => void }): void {
  /** Lesen dürfen alle, die die Energie-Seite sehen (wie der Fahrzeugzustand) */
  app.get('/api/energy-flow', async () => loadEnergyFlow(deps.db));

  // Ändern nur Admins (über /api/system/)
  app.put('/api/system/energy-flow', async (req) => {
    const { config } = parse(energyFlowInputSchema, req.body);
    const actor = operatorOf(req);
    deps.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(KEY, JSON.stringify(config), new Date().toISOString(), actor);
    deps.store.addAudit({
      operator: actor,
      target: 'energiefluss',
      action: 'einstellungen',
      params: '',
      success: true,
      message: config ? `${config.nodes.length} Plätze belegt` : 'automatisch aus den Geräten',
    });
    deps.notify(['energyFlow', 'audit']);
    return loadEnergyFlow(deps.db);
  });
}
