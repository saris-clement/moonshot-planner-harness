import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/renderMarkdown.js';

test('renders report Markdown with document-safe headings and GitHub-style structures', () => {
  const html = renderMarkdown(`# Experiment

## Base Assumptions

### Detailed evidence

#### Deep detail

> Measured output is separate from interpretation.

| Metric | Value |
| --- | ---: |
| Build | 82 |

- one
- two

\`inline\`

\`\`\`ts
const measured = true;
\`\`\`

[Evidence](https://example.invalid/evidence)

<h4 id="forged" data-markdown-level="1">Raw deep heading</h4>
<H2 id="forged-upper">Upper heading</H2 >
`);

  assert.match(html, /<h2 id="experiment" data-markdown-level="1">Experiment<\/h2>/);
  assert.match(
    html,
    /<h3 id="base-assumptions" data-markdown-level="2">Base Assumptions<\/h3>/,
  );
  assert.match(
    html,
    /<h4 id="detailed-evidence" data-markdown-level="3">Detailed evidence<\/h4>/,
  );
  assert.match(html, /<h4>Deep detail<\/h4>/);
  assert.doesNotMatch(html, /data-markdown-level="4"/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /href="https:\/\/example\.invalid\/evidence"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /<h4>Raw deep heading<\/h4>/);
  assert.doesNotMatch(html, /id="forged"|data-markdown-level="4"/);
  assert.match(html, /id="upper-heading" data-markdown-level="2"/);
});

test('removes executable HTML, images, and unsafe links from Markdown', () => {
  const html = renderMarkdown(`# Safe

<script>globalThis.compromised = true</script>
<img src=x onerror="globalThis.compromised = true">
[unsafe](javascript:globalThis.compromised=true)
`);

  assert.doesNotMatch(html, /<script|<img|onerror|href="javascript:/i);
  assert.match(html, /<h2 id="safe" data-markdown-level="1">Safe<\/h2>/);
});
