import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeExecutionFailure, readVariantDiagnostics, safeExecutionError } from '../src/failures.js';
import { executionSnapshotFromRun, mergeExecutionSnapshot } from '../src/executionState.js';
import { harnessPaths } from '../src/paths.js';
import type { CampaignRecord, TargetExcludedEvaluationRecord, VariantRecord } from '../src/types.js';

const code = 'model_boundary_violation_candidate_outside_shortlist';
const occurredAt = '2026-09-08T10:00:00.000Z';
const unownedId = 'sk-SECRET-model-invented-credential';
const candidateDetails = {
  kind: 'candidate_outside_shortlist', version: 1, requirementUnitId: 'unit-a', disposition: 'reuse',
  selected: [
    { index: 0, id: 'capability:a', allowed: true, origin: 'shortlist' },
    { index: 1, id: 'source:b', allowed: true, origin: 'discovered' },
    { index: 2, id: 'source:c', allowed: false, origin: 'supporting' },
    { index: 3, sha256: `sha256:${createHash('sha256').update(unownedId).digest('hex')}`,
      utf8Bytes: Buffer.byteLength(unownedId), allowed: false, origin: 'unknown' },
  ],
  allowedIds: ['capability:a', 'source:b'],
  counts: { selected: 4, allowed: 2, shortlist: 1, discovered: 1, supporting: 1 },
  truncated: false,
};
const failureEvent = {
  schemaVersion: 1, eventId: 'event-failed', caseId: 'case-failed', sequence: 8,
  name: 'run.failed', occurredAt, actor: null,
  payload: { runId: 'run-failed', code, message: 'SECRET raw model response', details: candidateDetails },
};
const failedRun = {
  run: { id: 'run-failed', caseId: 'case-failed', status: 'failed' },
  runtime: {
    id: 'run-failed', caseId: 'case-failed', status: 'failed', failureCode: code,
    failureMessage: 'SECRET raw model response', updatedAt: occurredAt,
    providerRetryBudgetAvailable: false, progress: { completedUnits: 7, totalUnits: 9 },
  },
  checkpointMetadata: { stage: 'adjudicating', caseId: 'case-failed', runId: 'run-failed' },
  checkpoint: { failedRequirementUnitIds: ['unit-a'], completedAdjudications: [] },
};

test('normalizes runtime failure and checkpoint fields without trusting raw messages', () => {
  const failure = normalizeExecutionFailure(failedRun);
  assert.equal(failure?.code, code);
  assert.equal(failure?.origin, 'planner');
  assert.equal(failure?.occurredAt, occurredAt);
  assert.deepEqual(failure?.failedRequirementUnitIds, ['unit-a']);
  assert.equal(failure?.lastCheckpointStage, 'adjudicating');
  assert.equal(failure?.providerRetryBudgetAvailable, false);
  assert.equal(failure?.details, null);
  assert.equal(JSON.stringify(failure).includes('SECRET'), false);
  assert.equal(normalizeExecutionFailure({ runtime: { status: 'completed', failureCode: code } }), null);
  const unknown = normalizeExecutionFailure({ runtime: { status: 'failed', failureCode: 'SECRET', failureMessage: 'SECRET' } });
  assert.equal(unknown?.code, null);
  assert.equal(unknown?.providerRetryBudgetAvailable, null);
  assert.match(unknown!.message, /unavailable/i);
  assert.equal(JSON.stringify(unknown).includes('SECRET'), false);
  assert.equal(safeExecutionError(new Error('SECRET bearer sk-secret response body')), 'Execution failed; diagnostic details are unavailable.');
});

test('selects only matching run.failed events and allowlists versioned structured diagnostics', () => {
  const event = failureEvent;
  const failure = normalizeExecutionFailure({ ...failedRun, events: [event,
    { ...event, payload: { runId: 'other-run', code: 'analysis_failed' } },
    { ...event, caseId: 'other-case', payload: { runId: 'run-failed', code: 'analysis_failed' } },
  ] }, { caseId: 'case-failed', runId: 'run-failed' });
  assert.equal(failure?.code, code);
  assert.deepEqual(failure?.details, candidateDetails);
  assert.equal(JSON.stringify(failure).includes('SECRET'), false);
  assert.match(JSON.stringify(failure), /sha256/);
  assert.equal(normalizeExecutionFailure({ ...failedRun, events: [{ ...event,
    payload: { ...event.payload, details: { ...candidateDetails, version: 2 } } }] })?.details, null);
});

test('candidate diagnostic rejects invalid wire shapes, counts, unsafe IDs and exceeded caps', () => {
  const normalize = (details: unknown) => normalizeExecutionFailure({ ...failedRun, events: [{
    ...failureEvent, payload: { ...failureEvent.payload, details },
  }] })?.details;
  const unknownSelection = candidateDetails.selected[3]!;
  const malformed = [
    { ...candidateDetails, disposition: 'SECRET' },
    { ...candidateDetails, selected: [] },
    { ...candidateDetails, selected: [...candidateDetails.selected, unknownSelection, unknownSelection] },
    { ...candidateDetails, allowedIds: Array.from({ length: 33 }, (_, i) => `candidate:${i}`) },
    { ...candidateDetails, counts: { ...candidateDetails.counts, selected: 5 } },
    { ...candidateDetails, counts: { ...candidateDetails.counts, supporting: -1 } },
    { ...candidateDetails, counts: { ...candidateDetails.counts, discovered: Number.MAX_SAFE_INTEGER + 1 } },
    { ...candidateDetails, counts: { selected: 4, allowed: 2 } },
    { ...candidateDetails, allowedIds: ['capability:a', 'capability:a'] },
    { ...candidateDetails, allowedIds: ['Bearer SECRET', 'source:b'] },
    { ...candidateDetails, truncated: true },
    { ...candidateDetails, truncated: undefined },
    { ...candidateDetails, selected: [{ index: 0, id: { id: 'capability:a' }, allowed: true, origin: 'shortlist' }, ...candidateDetails.selected.slice(1)] },
    { ...candidateDetails, selected: [{ index: 1, id: 'capability:a', allowed: true, origin: 'shortlist' }, ...candidateDetails.selected.slice(1)] },
    { ...candidateDetails, selected: [...candidateDetails.selected.slice(0, 3), { ...unknownSelection, allowed: true }] },
    { ...candidateDetails, selected: [...candidateDetails.selected.slice(0, 3), { ...unknownSelection, id: unownedId }] },
    { ...candidateDetails, selected: [...candidateDetails.selected.slice(0, 3), { index: 3, id: unownedId, allowed: false, origin: 'unknown' }] },
    { ...candidateDetails, selected: [...candidateDetails.selected.slice(0, 3), { ...unknownSelection, sha256: 'a'.repeat(64) }] },
    { ...candidateDetails, selected: [...candidateDetails.selected.slice(0, 3), { ...unknownSelection, utf8Bytes: -1 }] },
    { ...candidateDetails, prompt: 'SECRET'.repeat(1400) },
  ];
  for (const details of malformed) assert.equal(normalize(details), null);
  const capped = {
    ...candidateDetails,
    selected: [...candidateDetails.selected, { ...unknownSelection, index: 4 }],
    allowedIds: Array.from({ length: 32 }, (_, i) => `candidate:${i}`),
    counts: { ...candidateDetails.counts, selected: 6, allowed: 33 }, truncated: true,
  };
  assert.deepEqual(normalize(capped), capped);
  assert.ok(Buffer.byteLength(JSON.stringify(normalize(capped))) <= 8 * 1024);
  for (const disposition of ['build', 'reuse', 'extend', 'defer', 'question']) {
    assert.equal(normalize({ ...candidateDetails, disposition })?.disposition, disposition);
  }
});

test('failure survives sparse same-run snapshots and clears on a successful successor', () => {
  const snapshot = executionSnapshotFromRun(failedRun, { questions: [] });
  const input = { benchmark: 'primary', role: 'primary' as const, replicate: 1, replicateCount: 2 };
  let state = mergeExecutionSnapshot(null, { ...input, snapshot });
  const { failure: _failure, ...sparse } = snapshot;
  state = mergeExecutionSnapshot(state, { ...input, snapshot: sparse });
  assert.equal(state.executions[0]?.failure?.code, code);
  state = mergeExecutionSnapshot(state, { ...input, snapshot: executionSnapshotFromRun({
    run: failedRun.run, runtime: { status: 'failed' },
  }, { questions: [] }) });
  assert.equal(state.executions[0]?.failure?.code, code);
  state = mergeExecutionSnapshot(state, { ...input, snapshot: { ...sparse, runId: 'successor', status: 'completed' } });
  assert.equal(state.executions[0]?.failure ?? null, null);
});

async function fixture(t: test.TestContext, controls = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'failure-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { ...harnessPaths(root), artifacts: path.join(root, 'artifacts') };
  const campaign = { id: 'pr47-autonomous2', config: { evaluation: { replicates: 2 }, benchmarks: [
    { name: 'primary', role: 'primary' }, { name: 'holdout', role: 'holdout' },
  ] } } as CampaignRecord;
  const snapshot = executionSnapshotFromRun(failedRun, { questions: [] });
  const { failure: _failure, ...legacy } = snapshot;
  const execution = { ...legacy, benchmark: 'primary:excluded', role: 'primary' as const, replicate: 1, replicateCount: 2 };
  const variant = { id: 'variant-a', campaignId: campaign.id, status: 'review', facts: { status: 'completed' },
    executionState: { executions: ['primary', 'holdout'].flatMap((benchmark) => [1, 2].map((replicate) => ({
      ...execution, benchmark, replicate, status: 'completed', caseId: `${benchmark}-${replicate}`, runId: `${benchmark}-run-${replicate}`,
    }))) } } as VariantRecord;
  const target = { campaignId: campaign.id, variantId: variant.id, status: 'failed', executionState: { executions: [execution,
    { ...execution, replicate: 2, status: 'completed', caseId: 'case-success', runId: 'run-success' },
  ] } } as TargetExcludedEvaluationRecord;
  if (controls) {
    target.normalArmBinding = null;
    target.executionState!.executions[0]!.status = 'completed';
    target.executionState!.executions.push(...[1, 2].map((replicate) => ({
      ...execution, benchmark: 'primary:control', replicate,
      status: replicate === 1 ? 'failed' : 'completed',
      caseId: `control-case-${replicate}`, runId: `control-run-${replicate}`,
    })));
  }
  const directory = path.join(paths.artifacts, campaign.id, variant.id, 'target-excluded', 'excluded', 'primary', 'replicate-1');
  await mkdir(directory, { recursive: true });
  return { paths, campaign, variant, target, directory };
}

test('legacy archive projection preserves four completed standard siblings and excluded success without mutation', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'analysis-run-latest.json'), JSON.stringify(failedRun));
  const before = JSON.stringify([f.variant, f.target]);
  const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.counts, { completed: 5, failed: 1, pending: 0, total: 6 });
  assert.equal(result.standardAvailable, true);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.scope, 'excluded');
  assert.equal(result.failures[0]?.failure?.code, code);
  assert.deepEqual(result.failures[0]?.failure?.failedRequirementUnitIds, ['unit-a']);
  assert.match(result.failures[0]?.failure?.provenance?.artifactPath ?? '', /^target-excluded\/excluded\/primary\/replicate-1\//);
  assert.equal(JSON.stringify([f.variant, f.target]), before);
});

test('archived planner wire event retains exact safe selections and completed sibling facts', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'analysis-run-latest.json'), JSON.stringify(failedRun));
  await writeFile(path.join(f.directory, 'events.json'), JSON.stringify({ events: [failureEvent] }));
  const before = JSON.stringify([f.variant, f.target]);
  const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.deepEqual(result.failures[0]?.failure?.details, candidateDetails);
  assert.equal(result.failures[0]?.failure?.provenance?.source, 'archive');
  assert.match(result.failures[0]?.failure?.provenance?.artifactPath ?? '', /\/events\.json$/);
  assert.deepEqual(result.counts, { completed: 5, failed: 1, pending: 0, total: 6 });
  assert.equal(result.standardAvailable, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify([f.variant, f.target]), before);
});

test('V1 diagnostics retain a failed control among seven completed siblings and read only its scoped archive', async (t) => {
  const f = await fixture(t, true);
  const before = JSON.stringify([f.variant, f.target]);
  const missing = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(missing.status, 'blocked');
  assert.deepEqual(missing.counts, { completed: 7, failed: 1, pending: 0, total: 8 });
  assert.equal(missing.standardAvailable, true);
  assert.equal(missing.failures.length, 1);
  assert.equal(missing.failures[0]?.scope, 'control');
  assert.equal(missing.failures[0]?.benchmark, 'primary');
  assert.equal(missing.failures[0]?.caseId, 'control-case-1');
  assert.equal(missing.failures[0]?.runId, 'control-run-1');
  assert.equal(missing.failures[0]?.failure, null);

  const root = path.join(f.paths.artifacts, f.campaign.id, f.variant.id);
  const controlRun = {
    ...failedRun,
    run: { ...failedRun.run, caseId: 'control-case-1', id: 'control-run-1' },
    runtime: { ...failedRun.runtime, caseId: 'control-case-1', id: 'control-run-1' },
    checkpointMetadata: { ...failedRun.checkpointMetadata, caseId: 'control-case-1', runId: 'control-run-1' },
  };
  // Even matching IDs in another arm must not supply this control's diagnostics.
  for (const directory of [path.join(root, 'primary', 'replicate-1'), f.directory]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'analysis-run-latest.json'), JSON.stringify(controlRun));
  }
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target)).failures[0]?.failure, null);

  const directory = path.join(root, 'target-excluded', 'control', 'primary', 'replicate-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'analysis-run-latest.json'), JSON.stringify({
    ...controlRun, run: { ...controlRun.run, id: 'wrong-run' },
  }));
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target)).failures[0]?.failure, null);
  await writeFile(path.join(directory, 'analysis-run-latest.json'), JSON.stringify(controlRun));
  await writeFile(path.join(directory, 'events.json'), JSON.stringify({ events: [{
    ...failureEvent, caseId: 'control-case-1', payload: { ...failureEvent.payload, runId: 'control-run-1' },
  }, failureEvent] }));
  const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.counts, { completed: 7, failed: 1, pending: 0, total: 8 });
  assert.equal(result.failures[0]?.failure?.code, code);
  assert.deepEqual(result.failures[0]?.failure?.failedRequirementUnitIds, ['unit-a']);
  assert.deepEqual(result.failures[0]?.failure?.details, candidateDetails);
  assert.equal(result.failures[0]?.failure?.provenance?.artifactPath,
    'target-excluded/control/primary/replicate-1/events.json');
  assert.equal(JSON.stringify([f.variant, f.target]), before);
});

test('V1 standalone holdout controls remain distinct from overlapping standard benchmarks', async (t) => {
  const f = await fixture(t, true);
  const controls = f.target.executionState!.executions.filter((execution) => execution.benchmark === 'primary:control');
  f.target.executionState!.executions.push(...controls.map((execution) => ({
    ...execution, benchmark: 'holdout:control', caseId: `holdout-control-case-${execution.replicate}`,
    runId: `holdout-control-run-${execution.replicate}`,
  })));
  const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.counts, { completed: 8, failed: 2, pending: 0, total: 10 });
  assert.deepEqual(result.failures.map(({ scope, benchmark }) => ({ scope, benchmark })), [
    { scope: 'control', benchmark: 'primary' }, { scope: 'control', benchmark: 'holdout' },
  ]);
  assert.equal(result.standardAvailable, true);
});

test('V2 campaign or normal-arm binding does not double-count historical control executions', async (t) => {
  for (const source of ['campaign', 'binding'] as const) {
    await t.test(source, async (t) => {
      const f = await fixture(t, true);
      if (source === 'campaign') {
        f.campaign.config.targetExcluded = { protocol: 'standard-primary-v2', targetImplementationWorkflow: 'customer/workflow' };
      } else {
        f.target.normalArmBinding = {
          source: 'standard_primary', benchmark: 'primary', resolvedArtifactSha: `sha256:${'a'.repeat(64)}`,
          replicates: [
            { replicate: 1, caseId: 'primary-1', runId: 'primary-run-1' },
            { replicate: 2, caseId: 'primary-2', runId: 'primary-run-2' },
          ],
        };
      }
      const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.counts, { completed: 6, failed: 0, pending: 0, total: 6 });
      assert.equal(result.failures.length, 0);
      assert.equal(result.standardAvailable, true);
    });
  }
});

test('missing, corrupt, mismatched, oversized and symlinked archives are unavailable, never invented failures', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'analysis-run-latest.json');
  const unavailable = async () => {
    const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
    assert.equal(result.failures[0]?.failure, null);
    assert.deepEqual(result.counts, { completed: 5, failed: 1, pending: 0, total: 6 });
  };
  await unavailable();
  await writeFile(file, '{corrupt SECRET');
  await unavailable();
  await writeFile(file, JSON.stringify({ ...failedRun, run: { id: 'another-run', caseId: 'another-case' } }));
  await unavailable();
  await writeFile(file, JSON.stringify(failedRun));
  await truncate(file, 16 * 1024 * 1024 + 1);
  await unavailable();
  await rm(file);
  const outside = path.join(path.dirname(f.paths.artifacts), 'outside.json');
  await writeFile(outside, JSON.stringify(failedRun));
  await symlink(outside, file);
  await unavailable();
  await rm(f.directory, { recursive: true });
  await mkdir(path.join(path.dirname(outside), 'outside-dir'));
  await writeFile(path.join(path.dirname(outside), 'outside-dir', 'analysis-run-latest.json'), JSON.stringify(failedRun));
  await symlink(path.join(path.dirname(outside), 'outside-dir'), f.directory);
  await unavailable();
});

test('archive events require matching case/run identity even when runtime archive is absent', async (t) => {
  const f = await fixture(t);
  const event = { name: 'run.failed', caseId: 'wrong-case', occurredAt,
    payload: { runId: 'run-failed', code, message: 'SECRET' } };
  await writeFile(path.join(f.directory, 'events.json'), JSON.stringify({ events: [event] }));
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target)).failures[0]?.failure, null);
  await writeFile(path.join(f.directory, 'events.json'), JSON.stringify({ events: [{ ...event, caseId: 'case-failed' }] }));
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target)).failures[0]?.failure?.code, code);
});

test('archive reads are scoped to the campaign, variant, benchmark and replicate', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'analysis-run-latest.json'), JSON.stringify(failedRun));
  const sibling = { ...f.variant, id: 'other-variant' };
  const otherTarget = { ...f.target, variantId: sibling.id };
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, sibling, otherTarget)).failures[0]?.failure, null);
  const wrongCampaign = await readVariantDiagnostics(f.paths, { ...f.campaign, id: '../escape' }, f.variant, f.target);
  assert.equal(wrongCampaign.status, 'unknown');
  assert.equal(wrongCampaign.counts.total, 0);
  f.target.executionState!.executions[0]!.benchmark = '../primary:excluded';
  const wrongBenchmark = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(wrongBenchmark.failures.length, 0);
  assert.equal(wrongBenchmark.counts.pending, 1);
  assert.equal(wrongBenchmark.standardAvailable, true);
});

test('diagnostic status distinguishes completed, active, waiting and unavailable executions', async (t) => {
  const f = await fixture(t);
  const complete = await readVariantDiagnostics(f.paths, f.campaign, f.variant);
  assert.equal(complete.status, 'complete');
  assert.deepEqual(complete.counts, { completed: 4, failed: 0, pending: 0, total: 4 });
  const first = f.variant.executionState!.executions[0]!;
  first.status = 'running';
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant)).status, 'running');
  first.status = 'waiting';
  assert.equal((await readVariantDiagnostics(f.paths, f.campaign, f.variant)).status, 'blocked');
  f.variant.executionState = null;
  const missing = await readVariantDiagnostics(f.paths, f.campaign, f.variant);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.failures.length, 0);
});

test('persisted failure projections are sanitized and never reused from a completed execution', async (t) => {
  const f = await fixture(t);
  const execution = f.target.executionState!.executions[0]!;
  execution.failure = { ...normalizeExecutionFailure(failedRun)!, message: 'SECRET',
    details: { SECRET: 'SECRET' }, provenance: { source: 'archive', artifactPath: '../SECRET' } };
  const result = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(result.failures[0]?.failure?.code, code);
  execution.status = 'completed';
  const completed = await readVariantDiagnostics(f.paths, f.campaign, f.variant, f.target);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.failures.length, 0);
});
