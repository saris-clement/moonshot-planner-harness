import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface SourceLineRange {
  start: number;
  end: number;
}

const MAX_SOURCE_BYTES = 5 * 1_024 * 1_024;
const MAX_LINE_NUMBER = 1_000_000;
const TYPESCRIPT_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'new', 'of', 'private', 'protected',
  'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'switch', 'throw', 'try', 'type',
  'typeof', 'var', 'while', 'with', 'yield',
]);
const TYPESCRIPT_TYPES = new Set([
  'any', 'Array', 'bigint', 'boolean', 'Date', 'Error', 'Map', 'never', 'number', 'object',
  'Promise', 'Record', 'Set', 'string', 'symbol', 'unknown', 'void',
]);
const TYPESCRIPT_LITERALS = new Set(['false', 'null', 'true', 'undefined']);

export function parseSourceLineRanges(value: string | null): SourceLineRange[] {
  if (!value) return [];
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) {
    throw new Error('invalid source line range');
  }
  return value.split(',').map((part) => {
    const [rawStart, rawEnd = rawStart] = part.split('-');
    const start = Number(rawStart);
    const end = Number(rawEnd);
    if (start < 1 || end < start || end > MAX_LINE_NUMBER) {
      throw new Error('invalid source line range');
    }
    return { start, end };
  });
}

export async function readFrozenSourceFile(root: string, relativePath: string): Promise<string> {
  if (
    !relativePath ||
    relativePath.length > 2_000 ||
    relativePath.includes('\\') ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('unsafe source path');
  }
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('unsafe source path');

  const canonicalRoot = await realpath(resolvedRoot).catch(() => {
    throw new Error('frozen workflows checkout is unavailable');
  });
  const canonicalFile = await realpath(candidate).catch(() => {
    throw new Error('source file was not found in the frozen workflows checkout');
  });
  const containedPath = path.relative(canonicalRoot, canonicalFile);
  if (!containedPath || containedPath.startsWith('..') || path.isAbsolute(containedPath)) {
    throw new Error('unsafe source path');
  }

  const details = await stat(canonicalFile);
  if (!details.isFile()) throw new Error('source path is not a file');
  if (details.size > MAX_SOURCE_BYTES) throw new Error('source file exceeds 5 MiB');
  const bytes = await readFile(canonicalFile);
  if (bytes.includes(0)) throw new Error('source file is not text');
  return bytes.toString('utf8');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function syntaxToken(kind: string, value: string): string {
  return `<span class="syntax-token syntax-${kind}">${escapeHtml(value)}</span>`;
}

function quotedEnd(line: string, start: number, quote: string): number | null {
  let escaped = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];
    if (character === quote && !escaped) return index + 1;
    if (character === '\\') escaped = !escaped;
    else escaped = false;
  }
  return null;
}

function highlightTypeScriptLines(lines: readonly string[]): string[] {
  let blockComment = false;
  let templateString = false;
  return lines.map((line) => {
    let highlighted = '';
    let index = 0;
    while (index < line.length) {
      if (blockComment) {
        const end = line.indexOf('*/', index);
        const stop = end < 0 ? line.length : end + 2;
        highlighted += syntaxToken('comment', line.slice(index, stop));
        index = stop;
        blockComment = end < 0;
        continue;
      }
      if (templateString) {
        const end = quotedEnd(line, index - 1, '`');
        const stop = end ?? line.length;
        highlighted += syntaxToken('string', line.slice(index, stop));
        index = stop;
        templateString = end === null;
        continue;
      }
      if (line.startsWith('//', index)) {
        highlighted += syntaxToken('comment', line.slice(index));
        break;
      }
      if (line.startsWith('/*', index)) {
        const end = line.indexOf('*/', index + 2);
        const stop = end < 0 ? line.length : end + 2;
        highlighted += syntaxToken('comment', line.slice(index, stop));
        index = stop;
        blockComment = end < 0;
        continue;
      }

      const character = line[index] ?? '';
      if (character === "'" || character === '"' || character === '`') {
        const end = quotedEnd(line, index, character);
        const stop = end ?? line.length;
        highlighted += syntaxToken('string', line.slice(index, stop));
        index = stop;
        templateString = character === '`' && end === null;
        continue;
      }
      if (/\d/.test(character)) {
        const match = line.slice(index).match(/^(?:0[xob])?[\da-f._]+n?/i);
        const value = match?.[0] ?? character;
        highlighted += syntaxToken('number', value);
        index += value.length;
        continue;
      }
      if (/[a-z_$]/i.test(character)) {
        const match = line.slice(index).match(/^[a-z_$][\w$]*/i);
        const value = match?.[0] ?? character;
        const nextCharacter = line.slice(index + value.length).match(/^\s*(.)/)?.[1];
        if (TYPESCRIPT_KEYWORDS.has(value)) highlighted += syntaxToken('keyword', value);
        else if (TYPESCRIPT_LITERALS.has(value)) highlighted += syntaxToken('literal', value);
        else if (TYPESCRIPT_TYPES.has(value) || /^[A-Z]/.test(value)) highlighted += syntaxToken('type', value);
        else if (nextCharacter === '(') highlighted += syntaxToken('function', value);
        else highlighted += escapeHtml(value);
        index += value.length;
        continue;
      }

      highlighted += escapeHtml(character);
      index += 1;
    }
    return highlighted;
  });
}

function selected(lineNumber: number, ranges: readonly SourceLineRange[]): boolean {
  return ranges.some((range) => lineNumber >= range.start && lineNumber <= range.end);
}

export function renderSourceViewer(input: {
  campaignId: string;
  workflowsSha: string;
  relativePath: string;
  source: string;
  ranges: readonly SourceLineRange[];
}): string {
  const lines = input.source.split(/\r?\n/);
  const highlightedLines = /\.tsx?$/i.test(input.relativePath)
    ? highlightTypeScriptLines(lines)
    : lines.map(escapeHtml);
  const renderedLines = lines
    .map((line, index) => {
      const lineNumber = index + 1;
      const className = selected(lineNumber, input.ranges)
        ? 'source-line source-line-selected'
        : 'source-line';
      return `<span id="L${lineNumber}" class="${className}"><a class="source-line-number" href="#L${lineNumber}" aria-label="Line ${lineNumber}">${lineNumber}</a><span class="source-line-code">${highlightedLines[index] ?? ''}</span></span>`;
    })
    .join('');
  const ranges = input.ranges.length
    ? input.ranges.map((range) => range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`).join(', ')
    : 'Full file';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(path.basename(input.relativePath))} - Frozen source</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="source-viewer-page">
  <header class="source-viewer-header">
    <div>
      <p class="overline">Frozen workflows source</p>
      <h1>${escapeHtml(input.relativePath)}</h1>
    </div>
    <dl class="source-viewer-meta">
      <div><dt>Campaign</dt><dd>${escapeHtml(input.campaignId)}</dd></div>
      <div><dt>Revision</dt><dd>Pinned ${escapeHtml(input.workflowsSha.slice(0, 10))}</dd></div>
      <div><dt>Lines</dt><dd>${escapeHtml(ranges)}</dd></div>
    </dl>
  </header>
  <main class="source-viewer-code" aria-label="${escapeHtml(input.relativePath)} source code">
    <pre><code>${renderedLines}</code></pre>
  </main>
</body>
</html>`;
}
