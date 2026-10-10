import type { ReactNode } from 'react';

// A small renderer for the documents agents write: headings, lists, tables,
// bold and paragraphs. Text is rendered as React nodes, never as raw HTML.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const Tag = (['h2', 'h3', 'h4', 'h5'] as const)[heading[1].length - 1];
      out.push(<Tag key={i}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }

    if (line.includes('|') && isRule(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div className="table-wrap" key={i}>
          <table>
            <thead>
              <tr>{head.map((h, k) => <th key={k}>{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^\s*([-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={i}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</List>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,4}\s/.test(lines[i]) && !bullet.test(lines[i])) para.push(lines[i++]);
    out.push(<p key={i}>{para.map((t, k) => <span key={k}>{inline(t)}{k < para.length - 1 && <br />}</span>)}</p>);
  }

  return <div className="doc">{out}</div>;
}
