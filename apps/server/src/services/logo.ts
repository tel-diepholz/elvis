import { randomBytes } from 'node:crypto';
import {
  EMPTY_LOGO_CONFIG,
  isLogoSignalId,
  logoLabelInputSchema,
  logoLinkInputSchema,
  logoRuleInputSchema,
  type LogoConfig,
  type LogoLink,
  type LogoLinkInput,
  type LogoRule,
  type LogoRuleInput,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { LogoSource } from '../devices/drivers/logo.js';
import { HttpError } from '../errors.js';

function check<T>(r: { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }): T {
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; '));
  return r.data;
}

/** Bezeichnungen, Meldungsregeln und Taster-Verknüpfungen der LOGO (Tabelle logo_config, ein JSON-Dokument) */
export class LogoService implements LogoSource {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly notify: () => void,
  ) {}

  get(): LogoConfig {
    const row = this.db.prepare('SELECT data FROM logo_config WHERE id = 1').get() as { data: string } | undefined;
    return { ...EMPTY_LOGO_CONFIG, ...(row ? (JSON.parse(row.data) as Partial<LogoConfig>) : {}) };
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private save(c: LogoConfig): void {
    this.db.prepare('INSERT INTO logo_config (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(c));
    this.notify();
    this.listeners.forEach((l) => l());
  }

  /** Leere Bezeichnung entfernt sie */
  setLabel(signal: string, input: unknown): string {
    if (!isLogoSignalId(signal)) throw new HttpError(404, `Unbekanntes Signal ${signal}`);
    const { label } = check(logoLabelInputSchema.safeParse(input));
    const c = this.get();
    if (label) c.labels[signal] = label;
    else delete c.labels[signal];
    this.save(c);
    return label;
  }

  createRule(input: LogoRuleInput): LogoRule {
    const rule: LogoRule = { id: randomBytes(4).toString('hex'), ...check(logoRuleInputSchema.safeParse(input)) };
    const c = this.get();
    c.rules.push(rule);
    this.save(c);
    return rule;
  }

  updateRule(id: string, input: LogoRuleInput): LogoRule {
    const c = this.get();
    const i = c.rules.findIndex((r) => r.id === id);
    if (i < 0) throw new HttpError(404, 'Regel nicht gefunden');
    const rule: LogoRule = { id, ...check(logoRuleInputSchema.safeParse(input)) };
    c.rules[i] = rule;
    this.save(c);
    return rule;
  }

  removeRule(id: string): LogoRule {
    const c = this.get();
    const rule = c.rules.find((r) => r.id === id);
    if (!rule) throw new HttpError(404, 'Regel nicht gefunden');
    c.rules = c.rules.filter((r) => r.id !== id);
    this.save(c);
    return rule;
  }

  createLink(input: LogoLinkInput): LogoLink {
    const link: LogoLink = { id: randomBytes(4).toString('hex'), ...check(logoLinkInputSchema.safeParse(input)) };
    const c = this.get();
    this.assertButtonFree(c, link.button);
    c.links.push(link);
    this.save(c);
    return link;
  }

  updateLink(id: string, input: LogoLinkInput): LogoLink {
    const c = this.get();
    const i = c.links.findIndex((l) => l.id === id);
    if (i < 0) throw new HttpError(404, 'Verknüpfung nicht gefunden');
    const link: LogoLink = { id, ...check(logoLinkInputSchema.safeParse(input)) };
    this.assertButtonFree({ ...c, links: c.links.filter((l) => l.id !== id) }, link.button);
    c.links[i] = link;
    this.save(c);
    return link;
  }

  removeLink(id: string): LogoLink {
    const c = this.get();
    const link = c.links.find((l) => l.id === id);
    if (!link) throw new HttpError(404, 'Verknüpfung nicht gefunden');
    c.links = c.links.filter((l) => l.id !== id);
    this.save(c);
    return link;
  }

  private assertButtonFree(c: LogoConfig, button: string): void {
    if (c.links.some((l) => l.button === button)) throw new HttpError(409, `${button} ist schon mit einem Ausgang verknüpft`);
  }
}
