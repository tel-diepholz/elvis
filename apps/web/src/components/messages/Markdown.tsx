import ReactMarkdown from 'react-markdown';

/** Meldungstext; rohes HTML wird nicht ausgegeben (skipHtml), Links öffnen in neuem Tab */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown skipHtml components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Erste Zeile ohne Markdown-Zeichen für Listen */
export function markdownPreview(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/[*_`~]/g, '')
    .trim();
}
