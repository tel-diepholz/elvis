import type { ReactNode } from 'react';
import type { Message } from '@elvis/shared';
import { markdownPreview } from './Markdown';

/** Suchbegriffe: Leerzeichen trennen, alle müssen vorkommen (Groß-/Kleinschreibung egal) */
export const searchTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

const haystack = (m: Message): string =>
  [`#${m.id}`, m.sender, m.recipient ?? '', ...m.copies.map((k) => k.role), m.createdBy, m.claimedBy ?? '', m.repliedBy ?? '', m.body, m.reply ?? ''].join('\n').toLowerCase();

/** Volltextsuche über Text, Antwort, Absender, Empfänger, Kopien, Bearbeiter und Nummer */
export function matchesSearch(m: Message, terms: string[]): boolean {
  if (!terms.length) return true;
  const text = haystack(m);
  return terms.every((t) => text.includes(t));
}

/** Treffer markieren */
export function highlight(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

/** Vorschauzeile: bei einer Suche die erste Zeile aus Text oder Antwort mit einem Treffer */
export function searchSnippet(m: Message, terms: string[]): { label: string | null; text: string } {
  const first = { label: null, text: markdownPreview(m.body) };
  if (!terms.length) return first;
  const sources: [string | null, string][] = [
    [null, m.body],
    ['Antwort', m.reply ?? ''],
  ];
  for (const [label, text] of sources) {
    const line = text.split('\n').find((l) => terms.some((t) => l.toLowerCase().includes(t)));
    if (line) return { label, text: markdownPreview(line) };
  }
  return first;
}
