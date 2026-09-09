import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionSnapshotFromRun,
  mergeExecutionSnapshot,
} from '../src/executionState.js';

test('executionSnapshotFromRun projects progress and accepted partial decisions', () => {
  const snapshot = executionSnapshotFromRun(
    {
      run: { id: 'run-a', caseId: 'case-a', status: 'running' },
      runtime: {
        status: 'running',
        stage: 'adjudicating',
        updatedAt: '2026-09-06T04:44:04.010Z',
        progress: { completedUnits: 3, totalUnits: 8 },
      },
      checkpoint: {
        completedAdjudications: [
          { requirementUnitId: 'unit-a', result: 'build' },
          { requirementUnitId: 'unit-b', result: 'reuse' },
          { requirementUnitId: 'unit-c', result: 'extend' },
        ],
      },
    },
    {
      caseId: 'case-a',
      runId: 'run-a',
      questions: [],
      startedAt: '2026-09-06T04:44:00.000Z',
      completedAt: null,
      elapsedMs: 4_010,
    },
  );

  assert.deepEqual(snapshot.progress, { completedUnits: 3, totalUnits: 8 });
  assert.deepEqual(snapshot.decisions, {
    build: 1,
    reuse: 1,
    extend: 1,
    defer: 0,
    question: 0,
  });
  assert.equal(snapshot.stage, 'adjudicating');
  assert.equal(snapshot.startedAt, '2026-09-06T04:44:00.000Z');
  assert.equal(snapshot.elapsedMs, 4_010);
  assert.deepEqual(snapshot.usage, null);
});

test('executionSnapshotFromRun projects the latest planner usage without separate reasoning tokens', () => {
  const snapshot = executionSnapshotFromRun(
    {
      runtime: {
        status: 'running',
        aggregateUsage: {
          calls: 3,
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          reasoningTokens: 10,
          costUsd: 0.75,
          durationMs: 2_500,
        },
      },
    },
    {
      questions: [],
      startedAt: '2026-09-06T04:44:00.000Z',
      completedAt: null,
      elapsedMs: 5_000,
    },
  );

  assert.deepEqual(snapshot.usage, {
    calls: 3,
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    costUsd: 0.75,
    durationMs: 2_500,
  });
  assert.equal('reasoningTokens' in snapshot.usage!, false);
});

test('executionSnapshotFromRun treats an admitted all-zero usage envelope as unobserved', () => {
  const snapshot = executionSnapshotFromRun(
    {
      runtime: {
        status: 'running',
        aggregateUsage: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          durationMs: 0,
        },
      },
    },
    { questions: [] },
  );

  assert.equal(snapshot.usage, null);
});

test('mergeExecutionSnapshot replaces a successor run instead of summing it', () => {
  const first = mergeExecutionSnapshot(null, {
    benchmark: 'primary-pack',
    role: 'primary',
    replicate: 1,
    replicateCount: 3,
    snapshot: {
      caseId: 'case-a',
      runId: 'run-first',
      status: 'waiting',
      stage: 'waiting_for_input',
      progress: { completedUnits: 5, totalUnits: 8 },
      decisions: { build: 4, reuse: 0, extend: 0, defer: 0, question: 1 },
      questions: [],
      updatedAt: '2026-09-06T04:44:00.000Z',
      startedAt: '2026-09-06T04:43:00.000Z',
      completedAt: null,
      elapsedMs: 60_000,
      usage: null,
    },
  });
  const successor = mergeExecutionSnapshot(first, {
    benchmark: 'primary-pack',
    role: 'primary',
    replicate: 1,
    replicateCount: 3,
    snapshot: {
      caseId: 'case-a',
      runId: 'run-second',
      status: 'running',
      stage: 'adjudicating',
      progress: { completedUnits: 4, totalUnits: 8 },
      decisions: { build: 3, reuse: 1, extend: 0, defer: 0, question: 0 },
      questions: [],
      updatedAt: '2026-09-06T04:45:00.000Z',
      startedAt: '2026-09-06T04:43:00.000Z',
      completedAt: null,
      elapsedMs: 120_000,
      usage: null,
    },
  });

  assert.equal(successor.executions.length, 1);
  assert.equal(successor.executions[0]?.runId, 'run-second');
  assert.equal(successor.executions[0]?.progress?.completedUnits, 4);
  assert.equal(successor.executions[0]?.decisions.build, 3);
});

test('mergeExecutionSnapshot retains the last checkpoint while a successor is admitted', () => {
  const first = mergeExecutionSnapshot(null, {
    benchmark: 'primary-pack',
    role: 'primary',
    replicate: 1,
    replicateCount: 3,
    snapshot: {
      caseId: 'case-a',
      runId: 'run-first',
      status: 'waiting',
      stage: 'waiting_for_input',
      progress: { completedUnits: 5, totalUnits: 8 },
      decisions: { build: 4, reuse: 0, extend: 0, defer: 0, question: 1 },
      questions: [],
      updatedAt: '2026-09-06T04:44:00.000Z',
      startedAt: '2026-09-06T04:43:00.000Z',
      completedAt: null,
      elapsedMs: 60_000,
      usage: {
        calls: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        costUsd: 0.1,
        durationMs: 25,
      },
    },
  });
  const admitted = mergeExecutionSnapshot(first, {
    benchmark: 'primary-pack',
    role: 'primary',
    replicate: 1,
    replicateCount: 3,
    snapshot: {
      caseId: 'case-a',
      runId: 'run-second',
      status: 'queued',
      stage: null,
      progress: { completedUnits: 0, totalUnits: 136 },
      decisions: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
      questions: [],
      updatedAt: '2026-09-06T04:45:00.000Z',
      startedAt: '2026-09-06T04:43:00.000Z',
      completedAt: null,
      elapsedMs: 120_000,
      usage: null,
    },
  });
  const decomposing = mergeExecutionSnapshot(admitted, {
    benchmark: 'primary-pack',
    role: 'primary',
    replicate: 1,
    replicateCount: 3,
    snapshot: {
      caseId: 'case-a',
      runId: 'run-second',
      status: 'running',
      stage: 'decomposing',
      progress: { completedUnits: 0, totalUnits: 136 },
      decisions: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
      questions: [],
      updatedAt: '2026-09-06T04:45:01.000Z',
      startedAt: '2026-09-06T04:43:00.000Z',
      completedAt: null,
      elapsedMs: 121_000,
      usage: null,
    },
  });

  assert.deepEqual(decomposing.executions[0]?.progress, { completedUnits: 5, totalUnits: 8 });
  assert.equal(decomposing.executions[0]?.decisions.build, 4);
  assert.equal(decomposing.executions[0]?.runId, 'run-second');
  assert.equal(decomposing.executions[0]?.stage, 'decomposing');
  assert.deepEqual(decomposing.executions[0]?.usage, {
    calls: 1,
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    costUsd: 0.1,
    durationMs: 25,
  });
});

test('mergeExecutionSnapshot clears prior failure when case or run identity is unknown', () => {
  const failed = executionSnapshotFromRun({
    runtime: { status: 'failed', failureCode: 'model_timeout' },
  }, { questions: [] });
  const input = { benchmark: 'primary-pack', role: 'primary' as const, replicate: 1, replicateCount: 2 };
  for (const [caseId, runId] of [
    [null, null], ['case-a', null], [null, 'run-a'], ['', ''], ['case-a', ''], ['', 'run-a'],
  ] as const) {
    const snapshot = { ...failed, caseId, runId };
    const state = mergeExecutionSnapshot(null, { ...input, snapshot });
    assert.ok(state.executions[0]?.failure);
    const next = mergeExecutionSnapshot(state, {
      ...input, snapshot: { ...snapshot, status: 'starting', failure: null },
    });
    assert.equal(next.executions[0]?.failure, null, `identity ${JSON.stringify([caseId, runId])}`);
  }
});

test('mergeExecutionSnapshot retains failure only for the same nonempty case and run identity', () => {
  const snapshot = executionSnapshotFromRun({
    run: { id: 'run-a', caseId: 'case-a', status: 'failed' },
    runtime: { status: 'failed', failureCode: 'model_timeout' },
  }, { questions: [] });
  const input = { benchmark: 'primary-pack', role: 'primary' as const, replicate: 1, replicateCount: 2 };
  const state = mergeExecutionSnapshot(null, { ...input, snapshot });
  const next = mergeExecutionSnapshot(state, { ...input, snapshot: { ...snapshot, failure: null } });
  assert.deepEqual(next.executions[0]?.failure, snapshot.failure);
  for (const [caseId, runId] of [['other-case', 'run-a'], ['case-a', 'other-run']] as const) {
    const successor = mergeExecutionSnapshot(state, {
      ...input, snapshot: { ...snapshot, caseId, runId, status: 'starting', failure: null },
    });
    assert.equal(successor.executions[0]?.failure, null);
  }
});
