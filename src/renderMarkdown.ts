import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const allowedTags = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];

function withHeadingAnchors(html: string): string {
  const seen = new Map<string, number>();
  const normalized = html.replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `<h${level}>`);
  return normalized.replace(
    /<h([1-3])>([\s\S]*?)<\/h\1\s*>/gi,
    (_match, level: string, body: string) => {
      const label = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} });
      const base = label
        .toLowerCase()
        .replace(/&[a-z0-9#]+;/g, '-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'section';
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      const id = occurrence === 1 ? base : `${base}-${occurrence}`;
      return `<h${level} id="${id}" data-markdown-level="${level}">${body}</h${level}>`;
    },
  );
}

export function renderMarkdown(markdown: string): string {
  const rendered = marked.parse(markdown, { async: false, gfm: true });
  if (typeof rendered !== 'string') throw new Error('Markdown renderer returned asynchronously');
  return sanitizeHtml(withHeadingAnchors(rendered), {
    allowedTags,
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      code: ['class'],
      h1: ['id', 'data-markdown-level'],
      h2: ['id', 'data-markdown-level'],
      h3: ['id', 'data-markdown-level'],
      h4: ['id', 'data-markdown-level'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      h1: 'h2',
      h2: 'h3',
      h3: 'h4',
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: { ...attributes, rel: 'noreferrer noopener' },
      }),
    },
  });
}
