import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseSourceLineRanges,
  readFrozenSourceFile,
  renderSourceViewer,
} from '../src/sourceViewer.js';

test('parses single and disjoint source line ranges', () => {
  assert.deepEqual(parseSourceLineRanges('247-309,377-443'), [
    { start: 247, end: 309 },
    { start: 377, end: 443 },
  ]);
  assert.deepEqual(parseSourceLineRanges('12'), [{ start: 12, end: 12 }]);
  assert.deepEqual(parseSourceLineRanges(null), []);
  assert.throws(() => parseSourceLineRanges('12-4'), /invalid source line range/);
  assert.throws(() => parseSourceLineRanges('12, words'), /invalid source line range/);
});

test('reads only text files contained by the frozen workflows checkout', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'source-viewer-'));
  const root = path.join(fixture, 'frozen-workflows');
  const outside = path.join(fixture, 'outside.ts');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'example.ts'), 'const safe = true;\n');
  await writeFile(outside, 'const secret = true;\n');
  await symlink(outside, path.join(root, 'src', 'linked.ts'));

  try {
    assert.equal(await readFrozenSourceFile(root, 'src/example.ts'), 'const safe = true;\n');
    await assert.rejects(readFrozenSourceFile(root, '../outside.ts'), /unsafe source path/);
    await assert.rejects(readFrozenSourceFile(root, outside), /unsafe source path/);
    await assert.rejects(readFrozenSourceFile(root, 'src/linked.ts'), /unsafe source path/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('renders escaped source with numbered anchors and selected lines', () => {
  const html = renderSourceViewer({
    campaignId: 'campaign-a',
    workflowsSha: '0123456789abcdef0123456789abcdef01234567',
    relativePath: 'src/example.ts',
    source: [
      '/** Account shape. */',
      'export interface Account {',
      '  accountId: string;',
      '}',
      "const value = makeValue('safe', 42); // build value",
      '<script>',
    ].join('\n'),
    ranges: [{ start: 2, end: 3 }],
  });

  assert.match(html, /id="L2" class="source-line source-line-selected"/);
  assert.match(html, /href="#L2"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Pinned 0123456789/);
  assert.doesNotMatch(html, /<\/span><\/span>\n<span id="L/);
  assert.match(html, /syntax-keyword">export<\/span>/);
  assert.match(html, /syntax-type">Account<\/span>/);
  assert.match(html, /syntax-type">string<\/span>/);
  assert.match(html, /syntax-function">makeValue<\/span>/);
  assert.match(html, /syntax-string">&#39;safe&#39;<\/span>/);
  assert.match(html, /syntax-number">42<\/span>/);
  assert.match(html, /syntax-comment">\/\/ build value<\/span>/);
});

test('keeps non-TypeScript files escaped without syntax markup', () => {
  const html = renderSourceViewer({
    campaignId: 'campaign-a',
    workflowsSha: '0123456789abcdef0123456789abcdef01234567',
    relativePath: 'README.md',
    source: 'const <unsafe>',
    ranges: [],
  });

  assert.match(html, /const &lt;unsafe&gt;/);
  assert.doesNotMatch(html, /syntax-keyword/);
});
