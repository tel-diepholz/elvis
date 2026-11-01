import { Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Online-Fassung der Doku für Verweise auf andere Seiten (die eingebettete Anleitung ist eine einzelne Seite) */
const DOCS_BASE = 'https://github.com/tel-diepholz/elvis/blob/main/docs/';

/** Anker wie bei GitHub: klein, Satzzeichen weg, Leerzeichen → „-“ */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const textOf = (children: ReactNode): string =>
  Children.toArray(children)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : ''))
    .join('');

/** Relativer Verweis einer Doku-Seite (z. B. ../funktionen/nachrichten.md) → Adresse bei GitHub */
function resolve(href: string, page: string): string {
  const base = new URL(page, 'https://x/docs/');
  const url = new URL(href, base);
  return `${DOCS_BASE}${url.pathname.replace(/^\/docs\//, '')}${url.hash}`;
}

/**
 * Doku-Seite aus docs/ in der Oberfläche (Markdown, beim Bauen eingebunden, also auch offline). Sprünge innerhalb
 * der Seite (#…) scrollen zur Überschrift, Verweise auf andere Seiten öffnen die Online-Fassung.
 */
export function DocView({ markdown, page }: { markdown: string; /** Pfad unter docs/ für Verweise auf andere Seiten; ohne = Verweise bleiben, wie sie sind */ page?: string }) {
  const heading =
    (Tag: 'h1' | 'h2' | 'h3') =>
    ({ children }: { children?: ReactNode }) => <Tag id={`doc-${slug(textOf(children))}`}>{children}</Tag>;
  return (
    <div className="markdown doc-view">
      <ReactMarkdown
        skipHtml
        // Tabellen, durchgestrichen u. Ä. (GitHub-Markdown wie in docs/)
        remarkPlugins={[remarkGfm]}
        components={{
          h1: heading('h1'),
          h2: heading('h2'),
          h3: heading('h3'),
          a: ({ node: _node, href = '', children, ...props }) => {
            if (href.startsWith('#'))
              return (
                <a
                  {...props}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`doc-${href.slice(1)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {children}
                </a>
              );
            const external = /^[a-z]+:/i.test(href) || !page ? href : resolve(href, page);
            return (
              <a {...props} href={external} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
