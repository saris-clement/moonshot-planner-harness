import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvidenceStore, type EvidenceScopeManifest } from '../src/evidence.js';

const score = { verified: { labeled: 0, correct: 0, errors: 0, accuracy: null }, provisional: { labeled: 30, correct: 20, errors: 10, accuracy: 2 / 3 }, decisionErrors: {}, cohortMismatches: [] };
const facts = (swapped = false) => ({
  status: 'completed', sampleSize: 1, decisionAgreement: 1, unitCount: 30, decisions: { reuse: 15, build: 15, extend: 0, defer: 0, question: 0 },
  shortlist: { empty: 0, nonempty: 30, candidates: 90 }, evidence: { discovered: 60, selectedSourceRefs: 30 },
  usage: { calls: 30, inputTokens: 100, outputTokens: 200, totalTokens: 300, costUsd: 0.1, durationMs: 1_000 },
  pins: { inputSetHash: 'input-hash', model: 'test-model' },
  units: Array.from({ length: 30 }, (_, index) => ({
    id: `id-${index}`, key: `unit-${String(index).padStart(2, '0')}`,
    ref: { entity: 'requirement', anchor: `anchor-${index}` }, kind: 'behavior', semantics: `Full semantics for unit ${index}`, confidence: 'high', uncoveredSemantics: [],
    decision: (index < 15) !== (swapped && index % 15 === 0) ? 'reuse' : 'build',
    rationale: 'long rationale '.repeat(2_000), sourceRefs: [{ path: 'src/selected.ts', symbol: 'selected' }],
    selectedCandidateIds: ['candidate-1'], shortlistCandidateCount: 3, discoveredEvidenceCount: 2,
  })),
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = path.join(root, 'artifacts', 'campaign-a');
  const current = path.join(artifacts, 'variant-a');
  const parent = path.join(artifacts, 'parent-a');
  const source = path.join(root, 'source');
  const planner = path.join(root, 'planner');
  const put = async (file: string, value: unknown, raw = false) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw ? String(value) : JSON.stringify(value));
  };
  await mkdir(planner, { recursive: true });
  await put(path.join(source, 'src/selected.ts'), 'export const selected = "needle";\n', true);
  await put(path.join(source, 'src/unselected.ts'), 'export const unselected = "needle";\n', true);
  await put(path.join(source, '.env'), 'needle SECRET', true);
  await put(path.join(source, 'stack.env'), 'needle SECRET', true);
  await put(path.join(source, 'credentials.json'), { secret: 'needle SECRET' });
  const referencePath = path.join(current, 'investigator-reference.json');
  await put(referencePath, {
    labels: facts().units.map((unit) => ({ campaignId: 'campaign-a', benchmark: 'primary', unitKey: unit.key, expectedDecision: unit.decision, status: 'suggested' })),
    labelSetHash: 'fixed-labels', baseline: { id: 'parent-a', facts: facts(), replicateFacts: [facts(), facts(true)] },
  });
  await put(path.join(parent, 'primary/replicate1/facts.json'), facts());
  await put(path.join(parent, 'primary/replicate2/facts.json'), facts(true));
  const receipt = path.join(current, 'investigation/action-002/receipt.json');
  await put(receipt, { patchHash: 'patch-1', artifactDirectory: 'investigation/action-002', result: {
    facts: facts(true), replicateFacts: [facts(true), facts(true)], score, baselineScore: score, labelSetHash: 'fixed-labels',
  } });
  await put(path.join(current, 'investigation/action-002/primary/replicate1/analysis.json'), {
    analysis: { adjudications: [{ requirementUnitId: 'id-0', shortlist: { candidates: [{ id: 'candidate-1' }] }, evidenceGrounding: { sourceReadCount: 2 }, discoveredLinks: ['link-1'] }] },
  });
  await put(path.join(current, 'investigation/action-001/tests.log'), 'line 1\nline 2\nline 3\n', true);
  const scope: EvidenceScopeManifest = { version: 1, campaignId: 'campaign-a', variantId: 'variant-a', artifactRoot: path.join(root, 'artifacts'), currentArtifactDirectory: current, parentArtifactDirectory: parent, workflowsSource: source, plannerSource: planner, referencePath };
  return { root, current, parent, source, receipt, referencePath, put, scope, store: new EvidenceStore(scope) };
}

test('receipts and frozen references provide stable scoped snapshots and all-unit comparisons', async (t) => {
  const { store, scope } = await fixture(t);
  const listed = await store.listObservations({});
  const trial = listed.items.find((item) => item.kind === 'observation' && item.actionId === 'action-002')!;
  assert.ok(trial.snapshotRef);
  assert.equal(JSON.stringify(listed).includes('long rationale'), false);
  const compared = await store.compareTrial({ snapshotRef: String(trial.snapshotRef) });
  assert.equal(compared.returnedCount, 20);
  assert.equal(compared.totalMatched, 30);
  assert.ok(compared.nextCursor);
  assert.equal(compared.summary.sameAggregateHistogram, true);
  assert.equal(compared.summary.changedUnitCount, 2);
  assert.equal(compared.summary.baselineMeanAgreement, 29 / 30);
  assert.equal(compared.summary.trialMeanAgreement, 28 / 30);
  assert.deepEqual(compared.recordedScores.trial, score);
  assert.equal(compared.labelBasis.labelSetHash, 'fixed-labels');
  assert.ok(compared.byteLength <= 16 * 1_024);
  assert.equal(compared.byteLength, Buffer.byteLength(JSON.stringify(compared)));
  const smallest = await store.compareTrial({ snapshotRef: String(trial.snapshotRef), maxBytes: 2_048 });
  assert.ok(smallest.byteLength <= 2_048);
  const next = await store.compareTrial({ snapshotRef: String(trial.snapshotRef), cursor: compared.nextCursor! });
  assert.equal(next.returnedCount, 10);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...compared.items, ...next.items].map((row) => row.unitRef)).size, 30);
  const fresh = await new EvidenceStore(scope).listObservations({});
  assert.deepEqual(fresh, listed);
  const inspected = await store.inspectUnit({ unitRef: String(compared.items[0]!.unitRef) });
  assert.equal(inspected.returnedCount, 2);
  assert.equal(inspected.items[0]!.decision, 'build');
  assert.equal(inspected.items[0]!.shortlistCandidateCount, 3);
  assert.equal(JSON.stringify(inspected).includes('long rationale'), false);
  const detail = await store.inspectUnit({ unitRef: String(compared.items[0]!.unitRef), includeRawAnalysis: true, includeRationale: true });
  assert.ok(detail.byteLength <= 16 * 1_024);
  const raw = detail.items[0]!.rawAnalysis as Record<string, unknown>;
  assert.deepEqual(raw.discoveredLinks, ['link-1']);
  assert.ok(detail.omissions.length > 0);
});

test('typed read and literal source search include unselected code, never secrets or symlinks', async (t) => {
  const { store, source, root } = await fixture(t);
  await writeFile(path.join(root, 'outside.ts'), 'needle OUTSIDE');
  await symlink(path.join(root, 'outside.ts'), path.join(source, 'escape.ts'));
  await writeFile(path.join(source, 'Dockerfile'), 'FROM needle\n');
  await writeFile(path.join(source, 'opaque.bin'), Buffer.from([0, 1, 2, 3]));
  const result = await store.searchSource({ query: 'needle' });
  assert.equal(result.totalMatched, 3);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('OUTSIDE'), false);
  assert.equal(result.sourcePolicy, 'normal_frozen_source');
  const sourceText = await store.readEvidence({ evidenceRef: String(result.items[0]!.evidenceRef), offset: 0, limit: 100 });
  assert.match(JSON.stringify(sourceText.items), /needle/);
  assert.equal((await store.searchSource({ query: '.*' })).totalMatched, 0);
  const listing = await store.listObservations({ limit: 100 });
  const log = listing.items.find((row) => row.evidenceKind === 'test_log')!;
  const page = await store.readEvidence({ evidenceRef: String(log.evidenceRef), offset: 0, limit: 7 });
  assert.equal(page.nextOffset, 7);
  assert.equal(page.totalMatched, Buffer.byteLength('line 1\nline 2\nline 3\n'));
  for (const evidenceRef of ['/etc/passwd', '../campaign-b/facts.json', 'ev_fake']) {
    await assert.rejects(store.readEvidence({ evidenceRef }));
  }
  await assert.rejects(store.listObservations({ path: root } as never));
  await assert.rejects(store.searchSource({ query: 'needle', sourceRef: source }));
});

test('snapshots fail closed on artifact mutation, cross-store IDs, and frozen label changes', async (t) => {
  const { store, scope, receipt, referencePath, put } = await fixture(t);
  const listing = await store.listObservations({});
  const trial = listing.items.find((row) => row.actionId === 'action-002')!;
  assert.throws(() => new EvidenceStore({ ...scope, variantId: 'other' }), /scope|variant/);
  await put(receipt, { result: { facts: facts() } });
  await assert.rejects(store.compareTrial({ snapshotRef: String(trial.snapshotRef) }), /changed|integrity|snapshot/i);
  await put(referencePath, { labels: [] });
  await assert.rejects(store.listObservations({}), /changed|integrity|reference/i);
});

test('excluded observations require their own filtered source root', async (t) => {
  const { scope, current, root, put } = await fixture(t);
  const excluded = path.join(current, 'target-excluded');
  await put(path.join(excluded, 'primary/replicate1/facts.json'), facts());
  const registration = { variantId: 'variant-a', artifactDirectory: excluded, arm: 'excluded' as const };
  const store = new EvidenceStore({ ...scope, allowedObservations: [registration] });
  const listed = await store.listObservations({ limit: 100 });
  const observation = listed.items.find((row) => row.kind === 'observation' && row.arm === 'excluded')!;
  assert.ok(observation);
  assert.equal(observation.sourceAvailability, 'not_captured');
  const filtered = path.join(root, 'filtered');
  await put(path.join(filtered, 'safe.ts'), 'needle FILTERED', true);
  const filteredStore = new EvidenceStore({ ...scope, allowedObservations: [{ ...registration, sourceRoot: filtered }] });
  const registered = await filteredStore.listObservations({ limit: 100 });
  const source = registered.items.find((row) => row.kind === 'source' && row.arm === 'excluded')!;
  const searched = await filteredStore.searchSource({ query: 'needle', sourceRef: String(source.sourceRef) });
  assert.equal(searched.totalMatched, 1);
  assert.equal(searched.sourcePolicy, 'filtered_measurement_source');
});

test('JSON limits are hard, cursors are query-bound, and long UTF-8 evidence can be continued', async (t) => {
  const { store, current, put } = await fixture(t);
  const text = '\u00e9\ud83d\ude00'.repeat(20_000);
  await put(path.join(current, 'mutation.patch'), text, true);
  const listing = await store.listObservations({ limit: 100 });
  const patch = listing.items.find((row) => row.evidenceKind === 'patch')!;
  let rebuilt = '';
  let offset = 0;
  do {
    const result = await store.readEvidence({ evidenceRef: String(patch.evidenceRef), offset, limit: 65_536, maxBytes: 4_096 });
    assert.equal(result.byteLength, Buffer.byteLength(JSON.stringify(result)));
    assert.ok(result.byteLength <= 4_096);
    rebuilt += result.items.map((row) => row.text).join('');
    offset = result.nextOffset ?? text.length * 10;
  } while (offset < Buffer.byteLength(text));
  assert.equal(rebuilt, text);
  const trial = listing.items.find((row) => row.actionId === 'action-002')!;
  const compared = await store.compareTrial({ snapshotRef: String(trial.snapshotRef) });
  await assert.rejects(store.compareTrial({ snapshotRef: String(trial.snapshotRef), changedOnly: true, cursor: compared.nextCursor! }), /cursor/i);
  await assert.rejects(store.listObservations({ maxBytes: 65_537 }));
  await assert.rejects(store.readEvidence({ evidenceRef: String(patch.evidenceRef), offset: 1 }), /UTF|offset/i);
});

test('normal final archives handle missing labels, unequal replica counts, and uncaptured analysis honestly', async (t) => {
  const { scope, current, put, referencePath } = await fixture(t);
  const reference = { labels: [], baseline: { id: 'parent-a', replicateFacts: [facts()] } };
  await put(referencePath, reference);
  for (let replicate = 1; replicate <= 3; replicate++) await put(path.join(current, `other/replicate-${replicate}/facts.json`), facts());
  const store = new EvidenceStore(scope);
  const listing = await store.listObservations({ limit: 100 });
  const final = listing.items.find((row) => row.role === 'final')!;
  const result = await store.compareTrial({ snapshotRef: String(final.snapshotRef) });
  assert.equal(result.summary.trialMeanAgreement, null);
  assert.equal(result.summary.baselineMeanAgreement, null);
  assert.equal(result.recordedScores.trial, null);
  assert.equal(result.summary.trialHistogram.reuse, 15);
  assert.ok(result.omissions.some((item) => item.reason === 'fixed_labels_not_captured'));
  const detail = await store.inspectUnit({ unitRef: String(result.items[0]!.unitRef), includeRawAnalysis: true });
  assert.deepEqual(detail.items[0]!.rawAnalysis, { availability: 'not_captured', evidenceRef: null });
});

test('registered evidence rejects source replacement and symlinked artifact ancestors', async (t) => {
  const { store, scope, root, current, source } = await fixture(t);
  const sourceResult = await store.searchSource({ query: 'needle' });
  const fileRef = String(sourceResult.items[0]!.evidenceRef);
  await rm(path.join(source, 'src/selected.ts'));
  await symlink(path.join(source, 'src/unselected.ts'), path.join(source, 'src/selected.ts'));
  await assert.rejects(store.readEvidence({ evidenceRef: fileRef }), /symlink/i);
  const moved = path.join(root, 'moved-variant');
  await rename(current, moved);
  await symlink(moved, current);
  await assert.rejects(new EvidenceStore(scope).listObservations({}), /symlink/i);
});

test('new receipts refresh the catalog without replacing old snapshot IDs; returned data cannot mutate the store', async (t) => {
  const { store, scope, current, put } = await fixture(t);
  const initial = await store.listObservations({});
  const oldTrial = initial.items.find((row) => row.actionId === 'action-002')!;
  const comparison = await store.compareTrial({ snapshotRef: String(oldTrial.snapshotRef) });
  (comparison.recordedScores.trial as { provisional: { accuracy: number } }).provisional.accuracy = -1;
  assert.equal(((await store.compareTrial({ snapshotRef: String(oldTrial.snapshotRef) })).recordedScores.trial as typeof score).provisional.accuracy, 2 / 3);
  await put(path.join(current, 'investigation/action-003/receipt.json'), { result: { replicateFacts: [facts()], labelSetHash: 'different-labels' } });
  const refreshed = await store.listObservations({ limit: 100 });
  assert.notEqual(refreshed.snapshotRef, initial.snapshotRef);
  const trial = refreshed.items.find((row) => row.actionId === 'action-003')!;
  const changed = await store.compareTrial({ snapshotRef: String(trial.snapshotRef), changedOnly: true });
  assert.equal(changed.totalMatched, 2);
  assert.ok(changed.omissions.some((item) => item.reason === 'recorded_score_label_basis_mismatch'));
  await assert.rejects(store.listObservations({ cursor: Buffer.from('{}').toString('base64url') }), /cursor/i);
  const fresh = new EvidenceStore(scope);
  assert.equal((await fresh.compareTrial({ snapshotRef: String(oldTrial.snapshotRef) })).totalMatched, 30);
});

test('final and excluded archives expose recorded score bases without replacing the fixed trial reference', async (t) => {
  const { scope, current, parent, put } = await fixture(t);
  const baselineScore = { ...score, provisional: { labeled: 30, correct: 29, errors: 1, accuracy: 29 / 30 } };
  const archivedBasis = { schemaVersion: 1, benchmark: 'primary', labelHash: 'later-labels', labels: [], referenceJudgment: { verdicts: facts().units.map((unit) => ({ unitKey: unit.key, expectedDecision: unit.decision })) }, score };
  await put(path.join(parent, 'primary/score-basis.json'), { ...archivedBasis, score: baselineScore });
  await put(path.join(current, 'primary/replicate-1/facts.json'), facts(true));
  await put(path.join(current, 'primary/score-basis.json'), archivedBasis);
  const excludedParent = path.join(parent, 'target-excluded/excluded');
  const excludedCurrent = path.join(current, 'target-excluded/excluded');
  await put(path.join(excludedParent, 'primary/replicate-1/facts.json'), facts());
  await put(path.join(excludedParent, 'primary/score-basis.json'), { ...archivedBasis, benchmark: 'primary:target-excluded', score: baselineScore });
  await put(path.join(excludedCurrent, 'primary/replicate-1/facts.json'), facts(true));
  await put(path.join(excludedCurrent, 'primary/score-basis.json'), { ...archivedBasis, benchmark: 'primary:target-excluded' });
  const store = new EvidenceStore({ ...scope, allowedObservations: [
    { variantId: 'parent-a', artifactDirectory: excludedParent, arm: 'excluded' },
    { variantId: 'variant-a', artifactDirectory: excludedCurrent, arm: 'excluded' },
  ] });
  const listing = await store.listObservations({ limit: 100 });
  const final = listing.items.find((row) => row.role === 'final' && row.arm === 'standard')!;
  const result = await store.compareTrial({ snapshotRef: String(final.snapshotRef) });
  assert.deepEqual(result.recordedScores.trial, score);
  assert.deepEqual(result.recordedScores.baseline, baselineScore);
  assert.equal(result.labelBasis.labelSetHash, 'fixed-labels');
  assert.equal(result.labelBasis.recordedLabelSetHash, 'later-labels');
  const excluded = listing.items.find((row) => row.role === 'final' && row.arm === 'excluded')!;
  const comparison = await store.compareTrial({ snapshotRef: String(excluded.snapshotRef) });
  assert.deepEqual(comparison.recordedScores.trial, score);
  assert.equal(comparison.labelBasis.source, 'archived_baseline_score_basis');
  assert.equal(comparison.summary.trialMeanAgreement, 28 / 30);
  assert.equal(comparison.items[0]!.labelStatus, 'suggested');
  assert.ok(comparison.recordedScores.trialBasisRef);
});

test('fixed labels absent from every replicate remain visible and in the agreement denominator', async (t) => {
  const { scope, referencePath, put } = await fixture(t);
  await put(referencePath, { labelSetHash: 'with-missing', labels: [
    ...facts().units.map((unit) => ({ campaignId: 'campaign-a', benchmark: 'primary', unitKey: unit.key, expectedDecision: unit.decision, status: 'suggested' })),
    { campaignId: 'campaign-a', benchmark: 'primary', unitKey: 'missing-both', expectedDecision: 'reuse', status: 'verified' },
  ], baseline: { id: 'parent-a', replicateFacts: [facts(), facts(true)] } });
  const store = new EvidenceStore(scope);
  const listing = await store.listObservations({});
  const trial = listing.items.find((row) => row.actionId === 'action-002')!;
  const comparison = await store.compareTrial({ snapshotRef: String(trial.snapshotRef) });
  assert.equal(comparison.totalMatched, 31);
  assert.equal(comparison.summary.trialMeanAgreement, 28 / 31);
  const missing = comparison.items.find((row) => row.unitKey === 'missing-both')!;
  assert.equal(missing.trialAgreement, 0);
  assert.equal(missing.baselineAgreement, 0);
  const restored = await new EvidenceStore(scope).inspectUnit({ unitRef: String(missing.unitRef) });
  assert.ok(restored.items.every((row) => row.availability === 'not_captured'));
});

test('coordinator artifact handles resolve in a fresh store and do not accept cross-scope paths', async (t) => {
  const { store, scope, current, parent, put } = await fixture(t);
  const names = ['investigator-context.json', 'investigator-turn-003-feedback.json', 'investigator-turn-003-context.json'];
  for (const name of names) await put(path.join(current, name), { marker: name });
  for (const name of names) {
    const reference = await store.referenceForArtifact(name);
    assert.ok(reference);
    const fresh = new EvidenceStore(scope);
    const read = await fresh.readEvidence({ evidenceRef: reference! });
    assert.match(JSON.stringify(read.items), /marker/);
    const listing = await fresh.listObservations({ kind: 'evidence', evidenceKind: 'context', nameQuery: name });
    assert.equal(listing.totalMatched, 1);
    assert.equal(listing.items[0]!.evidenceRef, reference);
  }
  for (const name of ['../parent-a/investigator-context.json', path.join(parent, 'primary/replicate1/facts.json'), 'a/../../facts.json', '.env', 'stack.env', 'credentials.json']) {
    await assert.rejects(store.referenceForArtifact(name), /unsafe|scope/i);
  }
  assert.equal(await store.referenceForArtifact('unsupported.sqlite'), null);
  assert.equal(await store.referenceForArtifact('investigator-turn-999-feedback.json'), null);
  await symlink(path.join(current, names[0]!), path.join(current, 'investigator-turn-004-feedback.json'));
  await assert.rejects(store.referenceForArtifact('investigator-turn-004-feedback.json'), /symlink/i);
  const otherRoot = path.join(scope.artifactRoot, 'campaign-b');
  const other = new EvidenceStore({ ...scope, campaignId: 'campaign-b', currentArtifactDirectory: path.join(otherRoot, scope.variantId), parentArtifactDirectory: path.join(otherRoot, 'parent-a'), referencePath: path.join(otherRoot, scope.variantId, 'investigator-reference.json') });
  await assert.rejects(other.readEvidence({ evidenceRef: (await store.referenceForArtifact(names[0]!))! }), /scope|reference/i);
});

test('catalog filters expose failure artifacts without dumping raw content and bind cursors to filters', async (t) => {
  const { store, current, put } = await fixture(t);
  await put(path.join(current, 'primary/replicate-1/analysis-run-latest.json'), { analysis: { marker: 'RAW_MODEL_RESPONSE' } });
  await put(path.join(current, 'primary/replicate-1/events.json'), [{ type: 'run.failed', message: 'RAW_MODEL_RESPONSE' }]);
  const listing = await store.listObservations({ kind: 'evidence', nameQuery: 'primary/replicate-1/', limit: 1 });
  assert.equal(listing.totalMatched, 2);
  assert.equal(JSON.stringify(listing).includes('RAW_MODEL_RESPONSE'), false);
  const next = await store.listObservations({ kind: 'evidence', nameQuery: 'primary/replicate-1/', limit: 1, cursor: listing.nextCursor! });
  assert.equal(next.returnedCount, 1);
  for (const item of [...listing.items, ...next.items]) {
    assert.match(JSON.stringify((await store.readEvidence({ evidenceRef: String(item.evidenceRef) })).items), /RAW_MODEL_RESPONSE/);
  }
  await assert.rejects(store.listObservations({ kind: 'observation', cursor: listing.nextCursor! }), /cursor/i);
  assert.equal((await store.listObservations({ kind: 'observation', nameQuery: '.*' })).totalMatched, 0);
});

test('listing is source-lazy, unchanged artifact registrations are reused, and source IDs survive fresh stores', async (t) => {
  const { store, scope, current, put } = await fixture(t);
  const internals = store as unknown as {
    readScoped: (root: string, relative: string, max?: number) => Promise<Buffer>;
    scan: (root: string, source: boolean, omissions: unknown[]) => Promise<string[]>;
  };
  const reads: string[] = [];
  let sourceScans = 0;
  const read = internals.readScoped.bind(store);
  const scan = internals.scan.bind(store);
  t.mock.method(internals, 'readScoped', async (root: string, relative: string, max?: number) => {
    reads.push(root);
    return read(root, relative, max);
  });
  t.mock.method(internals, 'scan', async (root: string, source: boolean, omissions: unknown[]) => {
    if (source) sourceScans++;
    return scan(root, source, omissions);
  });
  await put(path.join(current, 'investigator-context.json'), { goal: 'goal' });
  await store.referenceForArtifact('investigator-context.json');
  assert.equal(sourceScans, 0);
  const first = await store.listObservations({ kind: 'source' });
  assert.equal(sourceScans, 0);
  assert.equal(reads.some((root) => root === scope.workflowsSource || root === scope.plannerSource), false);
  assert.equal(first.items[0]!.binding, 'coordinator_scope');
  const initialReadCount = reads.length;
  await store.listObservations({ kind: 'observation' });
  assert.ok(reads.length - initialReadCount <= 3, 'unchanged facts, receipts, transcripts must not be reread');
  const found = await store.searchSource({ query: 'needle', sourceRef: String(first.items[0]!.sourceRef) });
  assert.equal(sourceScans, 1);
  assert.notEqual(found.snapshotRef, first.snapshotRef);
  const afterSearch = reads.length;
  await store.searchSource({ query: 'needle' });
  assert.equal(sourceScans, 1);
  assert.ok(reads.length - afterSearch <= 2, 'static source contents should be reused');
  const restored = await new EvidenceStore(scope).readEvidence({ evidenceRef: String(found.items[0]!.evidenceRef) });
  assert.match(JSON.stringify(restored.items), /needle/);
});

test('cached frozen source rejects changed files and new directory entries instead of silently changing its snapshot', async (t) => {
  const { scope, source, put } = await fixture(t);
  const changedFile = new EvidenceStore(scope);
  await changedFile.searchSource({ query: 'needle' });
  await put(path.join(source, 'src/selected.ts'), 'export const selected = "changed";', true);
  await assert.rejects(changedFile.searchSource({ query: 'changed' }), /integrity|changed/i);
  const addedFile = new EvidenceStore(scope);
  await addedFile.searchSource({ query: 'needle' });
  await put(path.join(source, 'src/new.ts'), 'export const added = "needle";', true);
  await assert.rejects(addedFile.searchSource({ query: 'needle' }), /directory changed/i);
});

test('research export contains every typed unit with verified bindings, never raw envelopes or credentials', async (t) => {
  const { scope, source, receipt, put } = await fixture(t);
  const run = { ...facts(true), environment: { key: 'HOST_CREDENTIAL' }, modelApiResponse: 'RAW_MODEL_RESPONSE',
    pins: { ...facts().pins, credentials: 'HOST_CREDENTIAL', environment: { key: 'HOST_CREDENTIAL' } },
    units: facts(true).units.map((unit) => ({ ...unit, modelApiResponse: 'RAW_MODEL_RESPONSE',
      rationale: unit.rationale + ' Authorization: Bearer test_access_secret_123456',
      sourceRefs: [...unit.sourceRefs, { path: '.env', symbol: 'HOST_CREDENTIAL' }] })),
  };
  await put(receipt, { environment: 'HOST_CREDENTIAL', result: { replicateFacts: [run, run], facts: run, labelSetHash: 'fixed-labels', modelApiResponse: 'RAW_MODEL_RESPONSE' } });
  const store = new EvidenceStore(scope);
  const catalog = await store.listObservations({ kind: 'observation' });
  const trial = catalog.items.find((row) => row.actionId === 'action-002')!;
  const exported = await store.exportResearchSnapshot(String(trial.snapshotRef));
  assert.equal(exported.data.replicates.length, 2);
  assert.equal(exported.data.replicates[0]!.facts.units.length, 30);
  assert.equal(exported.data.replicates[0]!.facts.units[0]!.semantics, 'Full semantics for unit 0');
  assert.ok(exported.data.replicates[0]!.facts.units[0]!.rationale.length > 20_000);
  assert.equal(exported.data.reference.labels.length, 30);
  assert.equal(exported.data.reference.source, 'investigator_reference');
  assert.deepEqual(exported.sourceRoots, [{ name: 'workflows', path: await realpath(source) }]);
  assert.ok(exported.data.artifactBindings.every((binding) => /^sha256:[a-f0-9]{64}$/.test(binding.sha256) && binding.integrity === 'verified_content_hash'));
  const json = JSON.stringify(exported.data);
  for (const forbidden of ['HOST_CREDENTIAL', 'RAW_MODEL_RESPONSE', 'test_access_secret_123456', 'modelApiResponse', '.env']) assert.equal(json.includes(forbidden), false);
  assert.deepEqual(JSON.parse(json), exported.data);
  const otherRoot = path.join(scope.artifactRoot, 'campaign-b');
  const other = new EvidenceStore({ ...scope, campaignId: 'campaign-b', currentArtifactDirectory: path.join(otherRoot, scope.variantId),
    parentArtifactDirectory: path.join(otherRoot, 'parent-a'), referencePath: path.join(otherRoot, scope.variantId, 'investigator-reference.json') });
  await assert.rejects(other.exportResearchSnapshot(String(trial.snapshotRef)), /scope|snapshot/i);
  exported.data.replicates[0]!.facts.units[0]!.decision = 'reuse';
  assert.equal((await store.exportResearchSnapshot(String(trial.snapshotRef))).data.replicates[0]!.facts.units[0]!.decision, 'build');
  await assert.rejects(store.exportResearchSnapshot(catalog.snapshotRef), /snapshot|scope/i);
  await assert.rejects(store.exportResearchSnapshot(source));
  await put(receipt, { result: { replicateFacts: [facts()] } });
  await assert.rejects(store.exportResearchSnapshot(String(trial.snapshotRef)), /changed|integrity/i);
});

test('research export redacts string metadata and displayed artifact paths without corrupting JSON, usage, or handles', async (t) => {
  const { scope, current, source, put } = await fixture(t);
  const pathCredential = `ghp_${'a'.repeat(24)}`;
  const metadataCredential = 'metadata_access_123456789';
  const rationaleCredential = 'rationale_access_123456789';
  const usage = { calls: 17, inputTokens: 123456, outputTokens: 654321, totalTokens: 777777, costUsd: 0.125, durationMs: 987.5 };
  const run = { ...facts(), usage, units: facts().units.map((unit) => ({ ...unit,
    rationale: `Preserve "quoted text" and a newline.\nBearer ${rationaleCredential}`,
  })) };
  await put(path.join(current, pathCredential, 'replicate-1/facts.json'), run);
  await put(path.join(current, pathCredential, 'score-basis.json'), {
    benchmark: pathCredential, labelHash: `Bearer ${metadataCredential}`, labels: [], score,
  });
  const store = new EvidenceStore(scope);
  const listed = await store.listObservations({ kind: 'observation' });
  const selected = listed.items.find((row) => row.benchmark === pathCredential)!;
  const { data, sourceRoots } = await store.exportResearchSnapshot(String(selected.snapshotRef));
  const encoded = JSON.stringify(data);
  assert.deepEqual(JSON.parse(encoded), data);
  for (const credential of [pathCredential, metadataCredential, rationaleCredential]) assert.equal(encoded.includes(credential), false);
  assert.equal(data.observation.benchmark, '[REDACTED]');
  assert.equal(data.observation.labelSetHash, 'Bearer [REDACTED]');
  const binding = data.artifactBindings.find((item) => item.kind === 'facts')!;
  assert.match(binding.artifactPath, /\[REDACTED\]\/replicate-1\/facts\.json$/);
  assert.equal(binding.evidenceRef, selected.evidenceRef);
  assert.equal(binding.sha256, `sha256:${createHash('sha256').update(JSON.stringify(run)).digest('hex')}`);
  assert.equal(binding.bytes, Buffer.byteLength(JSON.stringify(run)));
  assert.equal(data.snapshotRef, selected.snapshotRef);
  assert.equal(data.observation.campaignId, scope.campaignId);
  assert.equal(data.observation.variantId, scope.variantId);
  assert.equal(data.sourcePolicy.sourceRef, selected.sourceRef);
  assert.deepEqual(data.replicates[0]!.facts.usage, usage);
  for (const value of Object.values(data.replicates[0]!.facts.usage)) assert.equal(typeof value, 'number');
  assert.equal(data.replicates[0]!.facts.units[0]!.rationale, 'Preserve "quoted text" and a newline.\nBearer [REDACTED]');
  assert.deepEqual(sourceRoots, [{ name: 'workflows', path: await realpath(source) }]);
  const raw = await store.readEvidence({ evidenceRef: binding.evidenceRef, limit: 128 });
  assert.equal(raw.evidenceRef, binding.evidenceRef, 'redacted display paths are not used to resolve artifacts');
  assert.equal(raw.evidenceKind, 'facts');
});

test('research exports isolate excluded facts and labels, with filtered roots or explicit absence only', async (t) => {
  const { scope, current, parent, root, put, source } = await fixture(t);
  const excluded = path.join(current, 'target-excluded/excluded');
  const parentExcluded = path.join(parent, 'target-excluded/excluded');
  await put(path.join(excluded, 'primary/replicate-1/facts.json'), facts());
  const excludedBasis = { benchmark: 'primary:target-excluded', labelHash: 'excluded-labels', labels: [
    { campaignId: 'campaign-a', benchmark: 'primary:target-excluded', unitKey: 'unit-00', expectedDecision: 'build', status: 'suggested', rationale: 'Counterfactual label' },
    { campaignId: 'campaign-b', benchmark: 'primary:target-excluded', unitKey: 'cross-scope', expectedDecision: 'build', status: 'verified', rationale: 'FOREIGN_LABEL' },
  ] };
  await put(path.join(excluded, 'primary/score-basis.json'), excludedBasis);
  await put(path.join(parentExcluded, 'primary/replicate-1/facts.json'), facts());
  await put(path.join(parentExcluded, 'primary/score-basis.json'), excludedBasis);
  const registration = { variantId: scope.variantId, arm: 'excluded' as const, artifactDirectory: excluded };
  const parentRegistration = { variantId: 'parent-a', arm: 'excluded' as const, artifactDirectory: parentExcluded };
  const store = new EvidenceStore({ ...scope, allowedObservations: [registration, parentRegistration] });
  const catalog = await store.listObservations({ kind: 'observation' });
  const observation = catalog.items.find((row) => row.arm === 'excluded')!;
  const withoutSource = await store.exportResearchSnapshot(String(observation.snapshotRef));
  assert.deepEqual(withoutSource.sourceRoots, []);
  assert.equal(withoutSource.data.sourcePolicy.availability, 'not_captured');
  assert.equal(withoutSource.data.reference.labels.length, 1);
  assert.equal(withoutSource.data.reference.labelSetHash, 'excluded-labels');
  assert.equal(JSON.stringify(withoutSource.data).includes('fixed-labels'), false);
  assert.equal(JSON.stringify(withoutSource.data).includes('FOREIGN_LABEL'), false);
  const filtered = path.join(root, 'filtered');
  await put(path.join(filtered, 'safe.ts'), 'export const safe = true;', true);
  const filteredStore = new EvidenceStore({ ...scope, allowedObservations: [{ ...registration, sourceRoot: filtered }, parentRegistration] });
  const filteredCatalog = await filteredStore.listObservations({ kind: 'observation' });
  const selected = filteredCatalog.items.find((row) => row.arm === 'excluded')!;
  assert.deepEqual((await filteredStore.exportResearchSnapshot(String(selected.snapshotRef))).sourceRoots, [{ name: 'filtered-workflows', path: await realpath(filtered) }]);
  await rm(filtered, { recursive: true });
  await symlink(source, filtered);
  await assert.rejects(filteredStore.exportResearchSnapshot(String(selected.snapshotRef)), /symlink|source|scope/i);
  const alias = path.join(root, 'source-parent-alias');
  await symlink(root, alias);
  const aliasedStore = new EvidenceStore({ ...scope, allowedObservations: [{ ...registration, sourceRoot: path.join(alias, 'source') }, parentRegistration] });
  const aliasedCatalog = await aliasedStore.listObservations({ kind: 'observation' });
  const aliased = aliasedCatalog.items.find((row) => row.arm === 'excluded')!;
  await assert.rejects(aliasedStore.exportResearchSnapshot(String(aliased.snapshotRef)), /separate filtered root/i);
});

test('research export never uses primary labels for a different benchmark', async (t) => {
  const { scope, current, put } = await fixture(t);
  await put(path.join(current, 'holdout/replicate-1/facts.json'), facts());
  const store = new EvidenceStore(scope);
  const listing = await store.listObservations({ kind: 'observation' });
  const holdout = listing.items.find((row) => row.benchmark === 'holdout')!;
  const exported = await store.exportResearchSnapshot(String(holdout.snapshotRef));
  assert.equal(exported.data.reference.availability, 'not_captured');
  assert.deepEqual(exported.data.reference.labels, []);
  assert.ok(exported.data.artifactBindings.every((binding) => binding.kind === 'facts'));
});

for (const arm of ['standard', 'excluded'] as const) {
  test(`automatic ${arm} comparisons and research references never substitute a sibling for the scoped parent`, async (t) => {
    const { scope, current, parent, referencePath, put } = await fixture(t);
    await rm(referencePath);
    await rm(parent, { recursive: true });
    const sibling = path.join(path.dirname(current), 'sibling-a');
    const suffix = arm === 'excluded' ? 'target-excluded/excluded' : '';
    const candidateRoot = path.join(current, suffix);
    const siblingRoot = path.join(sibling, suffix);
    const parentRoot = path.join(parent, suffix);
    const benchmark = arm === 'excluded' ? 'primary:target-excluded' : 'primary';
    const basis = (labelHash: string, expectedDecision: string, recordedScore = score) => ({ benchmark, labelHash, score: recordedScore,
      labels: facts().units.map((unit) => ({ campaignId: scope.campaignId, benchmark, unitKey: unit.key,
        expectedDecision, status: 'suggested', rationale: labelHash })) });
    await put(path.join(candidateRoot, 'primary/replicate-1/facts.json'), facts(true));
    await put(path.join(candidateRoot, 'primary/score-basis.json'), basis('candidate-labels', 'build'));
    const siblingScore = { ...score, provisional: { labeled: 30, correct: 30, errors: 0, accuracy: 1 } };
    await put(path.join(siblingRoot, 'primary/replicate-1/facts.json'), facts());
    await put(path.join(siblingRoot, 'primary/score-basis.json'), basis('sibling-labels', 'build', siblingScore));
    const registrations = [{ variantId: 'sibling-a', artifactDirectory: siblingRoot, arm },
      ...(arm === 'excluded' ? [{ variantId: scope.variantId, artifactDirectory: candidateRoot, arm },
        { variantId: 'parent-a', artifactDirectory: parentRoot, arm }] : [])];
    const store = new EvidenceStore({ ...scope, allowedObservations: registrations });
    const listed = await store.listObservations({ kind: 'observation', limit: 100 });
    const selected = listed.items.find((row) => row.variantId === scope.variantId && row.arm === arm && row.actionId === null)!;
    const historical = listed.items.find((row) => row.variantId === 'sibling-a' && row.arm === arm)!;
    assert.equal(historical.role, 'final');
    assert.equal(selected.role, 'final');
    const comparison = await store.compareTrial({ snapshotRef: String(selected.snapshotRef) });
    assert.equal(comparison.baselineSnapshotRef, null);
    assert.equal(comparison.summary.baselineHistogram, null);
    assert.equal(comparison.summary.baselineMeanAgreement, null);
    assert.equal(comparison.summary.trialMeanAgreement, null);
    assert.equal(comparison.recordedScores.baseline, null);
    assert.deepEqual(comparison.recordedScores.trial, score);
    assert.equal(comparison.labelBasis.source, 'not_captured');
    assert.ok(comparison.omissions.some((item) => item.reason === 'baseline_not_captured'));
    const exported = await store.exportResearchSnapshot(String(selected.snapshotRef));
    assert.equal(exported.data.reference.availability, 'not_captured');
    assert.deepEqual(exported.data.reference.labels, []);
    assert.ok(exported.data.omissions.some((item) => item.reason === 'baseline_not_captured'));
    assert.equal(JSON.stringify(exported.data.reference).includes('sibling-labels'), false);

    // A later archived parent must win even though the sibling was registered first.
    await put(path.join(parentRoot, 'primary/replicate-1/facts.json'), facts());
    const capturedFacts = await store.listObservations({ kind: 'observation', limit: 100 });
    const unscoredParent = capturedFacts.items.find((row) => row.variantId === 'parent-a' && row.arm === arm)!;
    const withoutLabels = await store.compareTrial({ snapshotRef: String(selected.snapshotRef) });
    assert.equal(withoutLabels.baselineSnapshotRef, unscoredParent.snapshotRef);
    assert.equal(withoutLabels.labelBasis.source, 'not_captured');
    assert.equal((await store.exportResearchSnapshot(String(selected.snapshotRef))).data.reference.availability, 'not_captured');
    await put(path.join(parentRoot, 'primary/score-basis.json'), basis('parent-labels', 'reuse'));
    const refreshed = await store.listObservations({ kind: 'observation', limit: 100 });
    const actualParent = refreshed.items.find((row) => row.variantId === 'parent-a' && row.arm === arm)!;
    assert.equal(actualParent.role, 'baseline');
    const withParent = await store.compareTrial({ snapshotRef: String(selected.snapshotRef) });
    assert.equal(withParent.baselineSnapshotRef, actualParent.snapshotRef);
    assert.equal(withParent.labelBasis.labelSetHash, 'parent-labels');
    assert.equal((await store.exportResearchSnapshot(String(selected.snapshotRef))).data.reference.labelSetHash, 'parent-labels');
    const explicit = await store.compareTrial({ snapshotRef: String(selected.snapshotRef), baselineSnapshotRef: String(historical.snapshotRef) });
    assert.equal(explicit.baselineSnapshotRef, historical.snapshotRef);
    assert.equal(explicit.labelBasis.labelSetHash, 'parent-labels', 'explicit measurement comparisons cannot replace the fixed parent label basis');
  });
}

test('a self-parent UI scope identifies its final archive as baseline, never a sibling', async (t) => {
  const { scope, current, referencePath, put } = await fixture(t);
  await rm(referencePath);
  await put(path.join(current, 'primary/replicate-1/facts.json'), facts());
  await put(path.join(current, 'primary/score-basis.json'), { benchmark: 'primary', labelHash: 'self-labels', score,
    labels: [{ campaignId: scope.campaignId, benchmark: 'primary', unitKey: 'unit-00', expectedDecision: 'reuse', status: 'suggested' }] });
  const sibling = path.join(path.dirname(current), 'sibling-a');
  await put(path.join(sibling, 'primary/replicate-1/facts.json'), facts(true));
  const store = new EvidenceStore({ ...scope, parentArtifactDirectory: current,
    allowedObservations: [{ variantId: 'sibling-a', artifactDirectory: sibling, arm: 'standard' }] });
  const listed = await store.listObservations({ kind: 'observation', limit: 100 });
  const self = listed.items.filter((row) => row.variantId === scope.variantId && row.actionId === null);
  assert.equal(self.length, 1);
  assert.equal(self[0]!.role, 'baseline');
  assert.equal(listed.items.find((row) => row.variantId === 'sibling-a')!.role, 'final');
  const comparison = await store.compareTrial({ snapshotRef: String(self[0]!.snapshotRef) });
  assert.equal(comparison.baselineSnapshotRef, self[0]!.snapshotRef);
  assert.equal(comparison.summary.changedUnitCount, 0);
  assert.equal(comparison.labelBasis.labelSetHash, 'self-labels');
  assert.equal((await store.exportResearchSnapshot(String(self[0]!.snapshotRef))).data.reference.labelSetHash, 'self-labels');
});
