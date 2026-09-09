import assert from 'node:assert/strict';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { EvidenceStore } from '../src/evidence.js';
import { DiagnosticReviewSchema, type DiagnosticReview } from '../src/investigatorDiagnostics.js';
import { redactResearchText } from '../src/researchSandboxSnapshot.js';
import { digest, evidenceFixture, measuredFacts } from './evidenceFixtures.js';

const expected = { parentVariantId: 'parent-a', benchmark: 'primary' };
const ref = (kind: string, value = 'a') => `${kind}_${value.repeat(64)}`;
const example = (unitRef = ref('unit')): DiagnosticReview['examples'][number] => ({
  unitRef, assessment: 'uncertain', whyThisExample: 'Tests whether an existing workflow actually covers the requirement.',
  requirementUnderstanding: 'A capability is needed; existence alone does not establish coverage.', expectedDecision: null,
  codeAssessment: 'The recorded source may be relevant; this is not a correctness verdict.',
  citations: [{ evidenceRef: ref('evidence') }], limitations: 'The recorded evidence may be incomplete.',
  discriminatingCheck: 'Check the required behavior rather than just the workflow name.',
});
const review = (examples = [example()]): DiagnosticReview => ({
  schemaVersion: 1, observationRef: ref('snapshot'), selectionRationale: 'Select as many examples as needed to discriminate the hypothesis.',
  examples, mechanism: 'Coverage may depend on an untested precondition.',
  falsificationCriterion: 'Reject this hypothesis if the required precondition is already handled.',
});

async function fixture(t: test.TestContext, options: { count?: number; labels?: 'verified' | 'suggested' | 'absent'; frozen?: boolean } = {}) {
  const f = await evidenceFixture(t);
  const facts = { ...structuredClone(measuredFacts), units: Array.from({ length: options.count ?? 3 }, (_, index) => ({
    ...structuredClone(measuredFacts.units[0]!), id: `id-${index}`, key: `unit-${index}`,
    semantics: `Requirement semantics ${index}`, decision: index === 0 ? 'build' : 'reuse',
  })) };
  const reference = { labelSetHash: 'fixed-labels', labels: options.labels === 'absent' ? [] : facts.units.map((unit) => ({
    campaignId: f.campaign.id, benchmark: 'primary', unitKey: unit.key, expectedDecision: unit.decision,
    status: options.labels ?? 'suggested', rationale: 'A separate reference label, not the diagnostic opinion.',
  })), baseline: { id: 'parent-a', replicateFacts: [facts, facts] } };
  await f.put(path.join(f.parent, 'primary/replicate-1/facts.json'), facts);
  await f.put(path.join(f.parent, 'primary/replicate-2/facts.json'), facts);
  if (options.frozen !== false) await f.put(f.scope.referencePath, reference);
  const store = new EvidenceStore(f.scope);
  const listed = await store.listObservations({ kind: 'observation', limit: 100 });
  const observationRef = listed.baselineSnapshotRef ?? String(listed.items.find((row) => row.variantId === 'parent-a')!.snapshotRef);
  const compared = await store.compareTrial({ snapshotRef: observationRef, limit: 100 });
  const input = { ...review(compared.items.slice(0, options.count ?? 3).map((row) => example(String(row.unitRef)))), observationRef };
  const evidenceRef = String(listed.items.find((row) => row.snapshotRef === observationRef)!.evidenceRef);
  input.examples.forEach((item) => { item.citations = [{ evidenceRef }]; });
  return { ...f, store, facts, reference, input, listed, evidenceRef };
}

test('review schema supports adaptive counts, uncertainty, and correct build decisions without an error quota', () => {
  for (const count of [1, 2, 7, 20]) {
    const input = review(Array.from({ length: count }, (_, index) => example(`unit_${digest(String(index))}`)));
    input.examples[0]!.expectedDecision = 'build';
    input.selectionRationale = '  Select a useful boundary case.  ';
    const parsed = DiagnosticReviewSchema.parse(input);
    assert.equal(parsed.examples.length, count);
    assert.equal(parsed.examples[0]!.assessment, 'uncertain');
    assert.equal(parsed.examples[0]!.expectedDecision, 'build');
    assert.equal(parsed.selectionRationale, 'Select a useful boundary case.');
  }
  const mixed = review([example(), { ...example(ref('unit', 'b')), assessment: 'not_useful' }]);
  assert.equal(DiagnosticReviewSchema.parse(mixed).examples.length, 2);
});

test('review schema rejects empty, duplicate, all-not-useful, unbounded, and non-strict model input', () => {
  const invalid: unknown[] = [
    review([]), review([example(), example()]), review([{ ...example(), assessment: 'not_useful' }]),
    review(Array.from({ length: 21 }, (_, index) => example(`unit_${digest(String(index))}`))),
    { ...review(), schemaVersion: 2 }, { ...review(), observationRef: ref('unit') }, { ...review(), mechanism: ' ' },
    { ...review(), selectionRationale: 'x'.repeat(4_001) }, { ...review(), trusted: true },
  ];
  for (const field of ['whyThisExample', 'requirementUnderstanding', 'codeAssessment', 'limitations', 'discriminatingCheck']) {
    invalid.push(review([{ ...example(), [field]: ' ' }]), review([{ ...example(), [field]: 'x'.repeat(2_001) }]));
  }
  for (const change of [
    { unitRef: ref('snapshot') }, { expectedDecision: 'error' }, { assessment: 'verified' }, { hidden: 'field' },
    { citations: [] }, { citations: Array.from({ length: 9 }, () => ({ evidenceRef: ref('evidence') })) },
    { citations: [{ evidenceRef: ref('source') }] }, { citations: [{ evidenceRef: ref('evidence'), offset: -1 }] },
    { citations: [{ evidenceRef: ref('evidence'), offset: 0.5 }] }, { citations: [{ evidenceRef: ref('evidence'), limit: 0 }] },
    { citations: [{ evidenceRef: ref('evidence'), limit: 16_385 }] }, { citations: [{ evidenceRef: ref('evidence'), path: '/tmp/host' }] },
  ]) invalid.push(review([{ ...example(), ...change } as DiagnosticReview['examples'][number]]));
  for (const input of invalid) assert.equal(DiagnosticReviewSchema.safeParse(input).success, false, JSON.stringify(input));
});

test('preparation binds reviewed examples and observed decisions to the parent and preserves judgment provenance', async (t) => {
  const f = await fixture(t, { labels: 'verified' });
  f.input.examples[0]!.expectedDecision = 'build';
  f.input.examples[1]!.assessment = 'not_useful';
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.kind, 'diagnostic_review');
  assert.equal(prepared.structuralStatus, 'recorded');
  assert.equal(prepared.interpretationStatus, 'unverified_model_judgment');
  assert.equal(prepared.reviewHash, `sha256:${digest(JSON.stringify(prepared.review))}`);
  assert.equal(prepared.binding.campaignId, f.campaign.id);
  assert.equal(prepared.binding.variantId, expected.parentVariantId);
  assert.equal(prepared.binding.benchmark, expected.benchmark);
  assert.equal(prepared.binding.arm, 'standard');
  assert.equal(prepared.binding.observationRef, f.input.observationRef);
  assert.equal(prepared.binding.referenceRef, f.evidenceRef);
  assert.equal(prepared.binding.referenceHash, `sha256:${digest(await readFile(f.scope.referencePath))}`);
  assert.equal(prepared.examples.length, 3);
  assert.equal(prepared.examples[0]!.unitKey, 'unit-0');
  assert.equal(prepared.examples[0]!.replicates[0]!.requirementSemantics, 'Requirement semantics 0');
  assert.deepEqual(prepared.examples[0]!.replicates.map((row) => row.observedDecision), ['build', 'build']);
  assert.equal(prepared.examples[0]!.referenceLabel?.status, 'verified');
  assert.equal(prepared.examples[0]!.referenceLabel?.expectedDecision, 'build');
  assert.ok(prepared.binding.artifactBindings.every((item) => item.integrity === 'verified_content_hash'));
  assert.match(prepared.limitations.join(' '), /relevance.*judgment|judgment.*relevance/i);
  assert.equal(JSON.stringify(prepared).includes(f.root), false);
  assert.equal('sourceRoots' in prepared, false);
  prepared.examples[0]!.replicates[0]!.observedDecision = 'reuse';
  assert.equal((await f.store.prepareDiagnosticReview(f.input, expected)).examples[0]!.replicates[0]!.observedDecision, 'build');
});

for (const labels of ['absent', 'suggested'] as const) {
  test(`reviews without verified labels are valid (${labels})`, async (t) => {
    const f = await fixture(t, { labels, count: 1 });
    const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
    assert.equal(prepared.examples.length, 1);
    assert.equal(prepared.review.examples[0]!.expectedDecision, null);
    assert.equal(prepared.examples[0]!.referenceLabel?.status ?? null, labels === 'absent' ? null : 'suggested');
    assert.match(prepared.limitations.join(' '), /verified.*label.*not.*captured/i);
    if (labels === 'absent') {
      assert.equal(prepared.binding.observationBenchmark, null);
      assert.equal(prepared.binding.benchmarkBinding, 'coordinator_primary_frozen_reference');
    }
  });
}

test('only current parent primary standard baseline observations can be reviewed', async (t) => {
  const f = await fixture(t);
  const sibling = path.join(path.dirname(f.scope.currentArtifactDirectory), 'sibling-a');
  await f.put(path.join(sibling, 'primary/replicate-1/facts.json'), f.facts);
  await f.put(path.join(f.parent, 'holdout/replicate-1/facts.json'), f.facts);
  await f.put(path.join(f.parent, 'investigation/action-001/receipt.json'), { result: { replicateFacts: [f.facts] } });
  for (const arm of ['control', 'excluded']) await f.put(path.join(f.parent, arm, 'primary/replicate-1/facts.json'), f.facts);
  const store = new EvidenceStore({ ...f.scope, allowedObservations: [
    { variantId: 'sibling-a', artifactDirectory: sibling, arm: 'standard' },
    ...(['control', 'excluded'] as const).map((arm) => ({ variantId: 'parent-a', artifactDirectory: path.join(f.scope.parentArtifactDirectory, arm), arm })),
  ] });
  const listing = await store.listObservations({ kind: 'observation', limit: 100 });
  const disallowed = listing.items.filter((row) => row.variantId !== 'parent-a' || row.arm !== 'standard' || row.role !== 'baseline' || row.benchmark === 'holdout');
  assert.equal(disallowed.length, 6);
  for (const row of disallowed) {
    await assert.rejects(store.prepareDiagnosticReview({ ...f.input, observationRef: row.snapshotRef }, expected), /current.*parent|baseline|benchmark|scope/i);
  }
  await assert.rejects(store.prepareDiagnosticReview(f.input, { ...expected, parentVariantId: 'sibling-a' }), /parent|scope/i);
  await assert.rejects(store.prepareDiagnosticReview(f.input, { ...expected, benchmark: 'holdout' }), /benchmark|primary/i);
  await assert.rejects(store.prepareDiagnosticReview({ ...f.input, observationRef: ref('snapshot', 'f') }, expected), /snapshot|observation|scope/i);
});

test('historical parent handles are refused even when the old files still exist unchanged', async (t) => {
  const f = await fixture(t, { frozen: false });
  await f.put(path.join(f.parent, 'primary/score-basis.json'), { benchmark: 'primary', labelHash: 'later', labels: [] });
  await f.store.listObservations({ kind: 'observation' });
  await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /current|historical|stale/i);
});

test('a registered historical directory under the parent ID is not the current parent archive', async (t) => {
  const f = await fixture(t);
  const historical = path.join(f.scope.parentArtifactDirectory, 'history');
  await f.put(path.join(historical, 'primary/replicate-1/facts.json'), f.facts);
  const store = new EvidenceStore({ ...f.scope, allowedObservations: [{ variantId: 'parent-a', artifactDirectory: historical, arm: 'standard' }] });
  const listing = await store.listObservations({ kind: 'observation', limit: 100 });
  const selected = listing.items.find((row) => row.variantId === 'parent-a' && row.role === 'baseline' && row.replicateCount === 1)!;
  assert.ok(selected);
  const comparison = await store.compareTrial({ snapshotRef: String(selected.snapshotRef) });
  const input = { ...f.input, observationRef: String(selected.snapshotRef), examples: [{ ...f.input.examples[0]!,
    unitRef: String(comparison.items[0]!.unitRef), citations: [{ evidenceRef: String(selected.evidenceRef) }] }] };
  await assert.rejects(store.prepareDiagnosticReview(input, expected), /current|historical|parent.*archive/i);
});

test('current archived parent baseline is supported with explicit missing reference and labels', async (t) => {
  const f = await fixture(t, { frozen: false });
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  assert.equal(prepared.binding.referenceRef, null);
  assert.equal(prepared.binding.referenceHash, null);
  assert.equal(prepared.binding.benchmarkBinding, 'observation');
  assert.match(prepared.limitations.join(' '), /reference.*not.*captured/i);
});

test('unknown, other-observation, and label-only unit handles cannot fabricate recorded units', async (t) => {
  const f = await fixture(t);
  const other = f.listed.items.find((row) => row.role === 'final')!;
  const foreign = await f.store.compareTrial({ snapshotRef: String(other.snapshotRef) });
  for (const unitRef of [ref('unit', 'f'), String(foreign.items[0]!.unitRef)]) {
    await assert.rejects(f.store.prepareDiagnosticReview({ ...f.input, examples: [{ ...f.input.examples[0]!, unitRef }] }, expected), /unit|observation/i);
  }
  f.reference.labels.push({ ...f.reference.labels[0]!, unitKey: 'label-only' });
  await f.put(f.scope.referencePath, f.reference);
  const store = new EvidenceStore(f.scope);
  const listing = await store.listObservations();
  const comparison = await store.compareTrial({ snapshotRef: listing.baselineSnapshotRef! });
  const unitRef = String(comparison.items.find((row) => row.unitKey === 'label-only')!.unitRef);
  await assert.rejects(store.prepareDiagnosticReview({ ...f.input, observationRef: listing.baselineSnapshotRef,
    examples: [{ ...f.input.examples[0]!, unitRef }] }, expected), /unit|captured/i);
});

test('citations are restricted to observation files or its workflows source, not planner/global/other-arm evidence', async (t) => {
  const f = await fixture(t);
  const excluded = path.join(f.scope.parentArtifactDirectory, 'excluded');
  const filtered = path.join(f.root, 'filtered');
  await f.put(path.join(excluded, 'primary/replicate-1/facts.json'), f.facts);
  await f.put(path.join(filtered, 'filtered.ts'), 'export const needle = true;');
  await f.put(path.join(f.worktree, 'planner.ts'), 'export const needle = true;');
  const store = new EvidenceStore({ ...f.scope, allowedObservations: [{ variantId: 'parent-a', artifactDirectory: excluded, arm: 'excluded', sourceRoot: filtered }] });
  const listing = await store.listObservations({ limit: 100 });
  const refs = [ref('evidence', 'f'), ...listing.items.filter((row) => row.kind === 'observation' && (row.role === 'final' || row.arm === 'excluded')).map((row) => String(row.evidenceRef))];
  for (const source of listing.items.filter((row) => row.kind === 'source' && (row.role === 'planner' || row.arm === 'excluded'))) {
    const result = await store.searchSource({ sourceRef: String(source.sourceRef), query: 'needle' });
    refs.push(String(result.items[0]!.evidenceRef));
  }
  for (const evidenceRef of refs) await assert.rejects(store.prepareDiagnosticReview({ ...f.input,
    examples: [{ ...f.input.examples[0]!, citations: [{ evidenceRef }] }] }, expected), /citation|evidence|scope/i);
  const selected = await store.searchSource({ query: 'needle' });
  f.input.examples[0]!.citations = [{ evidenceRef: String(selected.items[0]!.evidenceRef) }];
  const prepared = await new EvidenceStore(f.scope).prepareDiagnosticReview(f.input, expected);
  assert.equal(prepared.examples[0]!.citations[0]!.text, 'export const needle = true;');
});

test('cited text is bounded, redacted, hash-bound, and explicitly a derivative rather than verbatim replay', async (t) => {
  const f = await fixture(t, { count: 1 });
  const raw = `export const needle = true;\nAuthorization: Bearer private_access_123456789\n${f.root}/host-only.ts\n`;
  await f.put(path.join(f.source, 'selected.ts'), raw);
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  f.input.examples[0]!.citations = [{ evidenceRef }];
  f.input.mechanism += ` ${f.root}/host-only.ts Bearer private_access_123456789`;
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  const citation = prepared.examples[0]!.citations[0]!;
  assert.equal(citation.sha256, `sha256:${digest(raw)}`);
  assert.equal(citation.originalBytes, Buffer.byteLength(raw));
  assert.equal(citation.offset, 0);
  assert.equal(citation.endOffset, Buffer.byteLength(raw));
  assert.equal(citation.offsetUnit, 'utf8_bytes');
  assert.equal(citation.complete, true);
  assert.equal(citation.truncated, false);
  assert.equal(citation.copyKind, 'redacted_research_copy');
  assert.equal(citation.integrity, 'verified_content_hash');
  assert.match(citation.text, /REDACTED/);
  assert.equal(JSON.stringify(prepared).includes('private_access_123456789'), false);
  assert.equal(JSON.stringify(prepared).includes(f.root), false);
  f.input.examples[0]!.citations = [{ evidenceRef, offset: 7, limit: 5 }];
  const partial = (await f.store.prepareDiagnosticReview(f.input, expected)).examples[0]!.citations[0]!;
  assert.equal(partial.text, raw.slice(7, 12));
  assert.equal(partial.complete, false);
  assert.equal(partial.truncated, true);
  assert.equal(partial.endOffset, 12);
});

test('ordinary research redaction retains its existing replacements', () => {
  for (const [input, output] of [
    ['prefix Bearer sample_access_material', 'prefix Bearer [REDACTED]'],
    ['prefix Basic dXNlcjpwYXNz', 'prefix Basic [REDACTED]'],
    ['const apiKey = "secret \u00e9";', 'const apiKey = "[REDACTED]";'],
    ['const token = \'escaped\\\'value\';', 'const token = "[REDACTED]";'],
    ['ghp_provider_PRIVATE_material_123456', '[REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----\npublic', '[REDACTED PRIVATE KEY]\npublic'],
    ['https://user:password@example.test/path', 'https://[REDACTED]@example.test/path'],
    ['const publicValue = "\u00e9\ud83d\ude00";', 'const publicValue = "\u00e9\ud83d\ude00";'],
  ]) assert.equal(redactResearchText(input!), output);
});

for (const prefix of ['needle\n', 'needle \u00e9\ud83d\ude00\n']) {
  for (const sample of [
    { name: 'Bearer token', source: 'Authorization: Bearer bearer_PRIVATE_material_123456', secret: 'bearer_PRIVATE_material_123456' },
    { name: 'credential assignment', source: 'const password = "assignment_PRIVATE_material_123456";', secret: 'assignment_PRIVATE_material_123456' },
    { name: 'multiline private key', source: '-----BEGIN RSA PRIVATE KEY-----\nfirst_PRIVATE_material_123456\nsecond_PRIVATE_material_789012\n-----END RSA PRIVATE KEY-----',
      secret: 'first_PRIVATE_material_123456\nsecond_PRIVATE_material_789012' },
    { name: 'provider token', source: 'const value = "ghp_provider_PRIVATE_material_123456";', secret: 'ghp_provider_PRIVATE_material_123456' },
    { name: 'URL credentials', source: 'https://user_PRIVATE:password_PRIVATE@example.test/path', secret: 'user_PRIVATE:password_PRIVATE' },
  ]) {
    test(`citation redaction uses full ${sample.name} context (${prefix.includes('\u00e9') ? 'Unicode' : 'ASCII'} prefix)`, async (t) => {
      const f = await fixture(t, { count: 1 });
      const suffix = '\nconst publicSuffix = true;';
      const raw = prefix + sample.source + suffix;
      await f.put(path.join(f.source, 'selected.ts'), raw);
      const found = await f.store.searchSource({ query: 'needle' });
      const evidenceRef = String(found.items[0]!.evidenceRef);
      const start = Buffer.byteLength(raw.slice(0, raw.indexOf(sample.secret)));
      const end = start + Buffer.byteLength(sample.secret);
      const windows = [
        { offset: start + 3, endOffset: end - 3 }, // Both boundaries inside sensitive bytes.
        { offset: Buffer.byteLength(prefix), endOffset: end - 3 }, // Prefix present, secret truncated.
        { offset: start + 3, endOffset: Buffer.byteLength(raw) }, // Prefix outside the window.
        { offset: start, endOffset: end }, // Exactly the payload, without identifying context.
        { offset: 0, endOffset: Buffer.byteLength(prefix) },
        { offset: Buffer.byteLength(raw) - Buffer.byteLength(suffix), endOffset: Buffer.byteLength(raw) },
      ];
      f.input.examples[0]!.citations = windows.map(({ offset, endOffset }) => ({ evidenceRef, offset, limit: endOffset - offset }));
      const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
      const citations = prepared.examples[0]!.citations;
      for (const [index, citation] of citations.entries()) {
        assert.equal(citation.sha256, `sha256:${digest(raw)}`);
        assert.equal(citation.originalBytes, Buffer.byteLength(raw));
        assert.equal(citation.offset, windows[index]!.offset);
        assert.equal(citation.endOffset, windows[index]!.endOffset);
        assert.equal(citation.offsetUnit, 'utf8_bytes');
        assert.equal(citation.complete, false);
        assert.equal(citation.truncated, true);
        assert.equal(citation.copyKind, 'redacted_research_copy');
        assert.ok(Buffer.byteLength(citation.text) <= 16_384);
        if (index < 4) assert.equal(citation.text.includes('PRIVATE'), false, `${sample.name} leaked through window ${index}`);
      }
      assert.equal(citations[4]!.text, prefix, 'redaction must not shift original offsets before a secret');
      assert.equal(citations[5]!.text, suffix, 'redaction must not shift original offsets after a secret');
    });
  }
}

test('private-key redaction retains context across 16 KiB reads and multiple citation windows', async (t) => {
  const f = await fixture(t, { count: 1 });
  const marker = 'PRIVATE_KEY_MATERIAL';
  const raw = `needle \u00e9\ud83d\ude00\n-----BEGIN PRIVATE KEY-----\n${'a'.repeat(16_384)}\n${marker}\n${'b'.repeat(16_384)}\n-----END PRIVATE KEY-----\npublicSuffix`;
  await f.put(path.join(f.source, 'selected.ts'), raw);
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  const offset = Buffer.byteLength(raw.slice(0, raw.indexOf(marker)));
  f.input.examples[0]!.citations = [{ evidenceRef, offset, limit: marker.length },
    { evidenceRef, offset: offset + 2, limit: marker.length - 4 }];
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  for (const [index, citation] of prepared.examples[0]!.citations.entries()) {
    assert.equal(citation.text.includes('KEY_MATERIAL'), false);
    assert.equal(citation.offset, offset + index * 2);
    assert.equal(citation.endOffset, offset + marker.length - index * 2);
    assert.equal(citation.sha256, `sha256:${digest(raw)}`);
  }
});

test('masking Unicode secrets preserves original UTF-8 boundary validation and following text', async (t) => {
  const f = await fixture(t, { count: 1 });
  const raw = 'needle\nconst password = "\u00e9\ud83d\ude00PRIVATE_value";\npublicSuffix';
  await f.put(path.join(f.source, 'selected.ts'), raw);
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  const offset = Buffer.byteLength(raw.slice(0, raw.indexOf('\u00e9')));
  for (const citation of [{ evidenceRef, offset: offset + 1, limit: 8 }, { evidenceRef, offset, limit: 1 }]) {
    f.input.examples[0]!.citations = [citation];
    await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /UTF|offset|limit/i);
  }
  f.input.examples[0]!.citations = [{ evidenceRef, offset, limit: Buffer.byteLength('\u00e9\ud83d\ude00PRIVATE_value') }];
  const citation = (await f.store.prepareDiagnosticReview(f.input, expected)).examples[0]!.citations[0]!;
  assert.equal(citation.text.includes('PRIVATE_value'), false);
  assert.equal(citation.text.includes('\u00e9'), false);
  assert.equal(citation.endOffset, offset + Buffer.byteLength('\u00e9\ud83d\ude00PRIVATE_value'));
});

test('empty and out-of-range citations fail instead of becoming empty successes', async (t) => {
  const f = await fixture(t, { count: 1 });
  await f.put(path.join(f.source, 'selected.ts'), 'needle\n\u00e9!');
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  for (const citation of [{ evidenceRef, offset: 10 }, { evidenceRef, offset: 11 }, { evidenceRef, offset: 8 }, { evidenceRef, offset: 7, limit: 1 }]) {
    f.input.examples[0]!.citations = [citation];
    await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /offset|range|UTF|empty|limit/i);
  }
  await f.put(path.join(f.parent, 'primary/replicate-1/analysis.json'), '');
  const store = new EvidenceStore(f.scope);
  const listing = await store.listObservations({ limit: 100 });
  const observation = listing.items.find((row) => row.kind === 'observation' && row.variantId === 'parent-a' && row.snapshotRef !== listing.baselineSnapshotRef)!;
  const comparison = await store.compareTrial({ snapshotRef: String(observation.snapshotRef) });
  const emptyRef = String(listing.items.find((row) => row.evidenceKind === 'analysis')!.evidenceRef);
  await assert.rejects(store.prepareDiagnosticReview({ ...f.input, observationRef: observation.snapshotRef,
    examples: [{ ...f.input.examples[0]!, unitRef: String(comparison.items[0]!.unitRef), citations: [{ evidenceRef: emptyRef }] }] }, expected), /empty|range/i);
});

for (const target of ['reference', 'replica', 'source', 'basis'] as const) {
  test(`preparation rejects stale ${target} content hashes`, async (t) => {
    const f = await fixture(t, { frozen: target !== 'replica' });
    const filename = target === 'reference' ? f.scope.referencePath : target === 'replica' ? path.join(f.parent, 'primary/replicate-1/facts.json') :
      target === 'basis' ? path.join(f.parent, 'primary/score-basis.json') : path.join(f.source, 'selected.ts');
    if (target === 'source') {
      const found = await f.store.searchSource({ query: 'needle' });
      f.input.examples[0]!.citations = [{ evidenceRef: String(found.items[0]!.evidenceRef) }];
    }
    if (target === 'basis') {
      await f.put(filename, { benchmark: 'primary', labels: [] });
      const listing = await f.store.listObservations();
      f.input.observationRef = listing.baselineSnapshotRef!;
      const compared = await f.store.compareTrial({ snapshotRef: f.input.observationRef });
      f.input.examples = [example(String(compared.items[0]!.unitRef))];
      f.input.examples[0]!.citations = [{ evidenceRef: String(listing.items.find((row) => row.snapshotRef === f.input.observationRef)!.evidenceRef) }];
    }
    await f.put(filename, target === 'source' ? 'export const changed = true;' : { changed: true });
    await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /integrity|changed|current|stale|benchmark/i);
  });
}

test('selected source symlinks are rejected at the preparation boundary', async (t) => {
  const f = await fixture(t, { count: 1 });
  const found = await f.store.searchSource({ query: 'needle' });
  f.input.examples[0]!.citations = [{ evidenceRef: String(found.items[0]!.evidenceRef) }];
  await rm(path.join(f.source, 'selected.ts'));
  await symlink(path.join(f.worktree, 'planner.ts'), path.join(f.source, 'selected.ts'));
  await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /symlink|changed|scope/i);
});

test('missing replica inputs are explicit, not invented from the review', async (t) => {
  const f = await fixture(t, { count: 1, frozen: false });
  await f.put(path.join(f.parent, 'primary/replicate-2/facts.json'), { ...f.facts, units: [] });
  const store = new EvidenceStore(f.scope);
  const listed = await store.listObservations({ kind: 'observation' });
  const observationRef = String(listed.items.find((row) => row.variantId === 'parent-a')!.snapshotRef);
  const compared = await store.compareTrial({ snapshotRef: observationRef });
  const input = { ...f.input, observationRef, examples: [{ ...f.input.examples[0]!, unitRef: String(compared.items[0]!.unitRef) }] };
  const prepared = await store.prepareDiagnosticReview(input, expected);
  assert.equal(prepared.examples[0]!.replicates[1]!.availability, 'not_captured');
  assert.equal(prepared.examples[0]!.replicates[1]!.observedDecision, null);
  assert.equal(prepared.examples[0]!.replicates[1]!.requirementSemantics, null);
  assert.match(prepared.limitations.join(' '), /unit.*not.*captured/i);
});

test('16 KiB citation windows and the 2 MiB preparation limit are hard caps, not silent truncation', async (t) => {
  const f = await fixture(t, { count: 20 });
  const raw = `needle ${'x'.repeat(20_000)}`;
  await f.put(path.join(f.source, 'selected.ts'), raw);
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  f.input.examples.forEach((item) => { item.citations = [{ evidenceRef }]; });
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  assert.equal(prepared.examples[0]!.citations[0]!.endOffset, 16_384);
  assert.equal(prepared.examples[0]!.citations[0]!.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(prepared)) <= 2 * 1_024 * 1_024);
  f.input.examples.forEach((item) => { item.citations = Array.from({ length: 8 }, () => ({ evidenceRef })); });
  await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /2 MiB|byte.*limit|too large|exceeds/i);
});

test('redaction cannot silently expand a published citation beyond 16 KiB', async (t) => {
  const f = await fixture(t, { count: 1 });
  await f.put(path.join(f.source, 'selected.ts'), `needle\n${'Bearer x\n'.repeat(1_800)}`);
  const found = await f.store.searchSource({ query: 'needle' });
  f.input.examples[0]!.citations = [{ evidenceRef: String(found.items[0]!.evidenceRef) }];
  await assert.rejects(f.store.prepareDiagnosticReview(f.input, expected), /16 KiB|citation.*byte.*limit/i);
});

test('preparation reads original citation bytes rather than republishing cached source text', async (t) => {
  const f = await fixture(t, { count: 1 });
  const found = await f.store.searchSource({ query: 'needle' });
  const evidenceRef = String(found.items[0]!.evidenceRef);
  f.input.examples[0]!.citations = [{ evidenceRef }];
  const cache = (f.store as unknown as { sourceText: Map<string, string> }).sourceText;
  cache.set(evidenceRef, 'cached content is not the original evidence');
  const prepared = await f.store.prepareDiagnosticReview(f.input, expected);
  assert.equal(prepared.examples[0]!.citations[0]!.text, 'export const needle = true;');
  assert.equal(prepared.examples[0]!.citations[0]!.sha256, `sha256:${digest('export const needle = true;')}`);
});
