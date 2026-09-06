import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { CampaignConfigSchema } from '../src/types.js';

test('database persists campaign lineage, labels, and ordered events', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-db-'));
  const database = new HarnessDatabase(path.join(directory, 'test.sqlite'));
  try {
    const config = CampaignConfigSchema.parse({
      id: 'phase2-search',
      goal: 'Find generic improvements to evidence-backed Phase 2 adjudication.',
      plannerRepo: '/tmp/planner',
      workflowsRepo: '/tmp/workflows',
      environmentFile: '/tmp/planner.env',
      seedRevision: 'abc',
      workflowsRevision: 'def',
      benchmarks: [
        { name: 'primary-pack', role: 'primary', zipPath: '/tmp/a.zip' },
        { name: 'holdout-pack', role: 'holdout', zipPath: '/tmp/b.zip' },
      ],
    });
    database.createCampaign(
      config,
      'a'.repeat(40),
      'b'.repeat(40),
      `sha256:${'c'.repeat(64)}`,
      'https://github.com/Saris-AI/workflows.git',
    );
    const variant = database.createVariant({
      id: 'phase2-search-v000',
      campaignId: config.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: {
        title: 'Seed',
        rationale: 'Observe the selected seed.',
        instructions: 'Do not change files.',
        expectedImpact: 'Create an observation.',
        risk: 'One run is nondeterministic.',
      },
    });
    database.updateCampaign(config.id, {
      currentParentVariantId: variant.id,
      noImprovementRounds: 1,
    });
    database.updateVariant(variant.id, {
      startedAt: '2026-09-06T04:40:00.000Z',
      completedAt: '2026-09-06T04:50:00.000Z',
      elapsedMs: 600_000,
      phase2StartedAt: '2026-09-06T04:44:00.000Z',
      phase2CompletedAt: '2026-09-06T04:48:00.000Z',
      phase2ElapsedMs: 240_000,
    });
    database.updateVariantExecution(variant.id, {
      benchmark: 'primary-pack',
      role: 'primary',
      replicate: 1,
      replicateCount: 3,
      snapshot: {
        caseId: 'case-a',
        runId: 'run-a',
        status: 'running',
        stage: 'adjudicating',
        progress: { completedUnits: 2, totalUnits: 8 },
        decisions: { build: 1, reuse: 1, extend: 0, defer: 0, question: 0 },
        questions: [],
        updatedAt: '2026-09-06T04:44:00.000Z',
        startedAt: '2026-09-06T04:43:00.000Z',
        completedAt: '2026-09-06T04:45:00.000Z',
        elapsedMs: 120_000,
        usage: {
          calls: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costUsd: 0.5,
          durationMs: 1_000,
        },
      },
    });
    database.upsertLabel({
      campaignId: config.id,
      benchmark: 'primary-pack',
      unitKey: 'unit-a',
      expectedDecision: 'reuse',
      classification: 'system_error',
      rationale: 'Source proves reuse.',
      status: 'verified',
    });

    assert.equal(database.getCampaign(config.id).currentParentVariantId, variant.id);
    assert.equal(database.getCampaign(config.id).noImprovementRounds, 1);
    assert.equal(database.acquireLease(config.id, 'owner-a', 60_000), true);
    assert.equal(database.acquireLease(config.id, 'owner-b', 60_000), false);
    database.releaseLease(config.id, 'owner-a');
    assert.equal(database.acquireLease(config.id, 'owner-b', 60_000), true);
    assert.equal(database.listLabels(config.id)[0]?.status, 'verified');
    const persistedVariant = database.getVariant(variant.id);
    assert.equal(persistedVariant.elapsedMs, 600_000);
    assert.equal(persistedVariant.phase2ElapsedMs, 240_000);
    assert.equal(persistedVariant.executionState?.executions[0]?.caseId, 'case-a');
    assert.equal(persistedVariant.executionState?.executions[0]?.elapsedMs, 120_000);
    assert.equal(persistedVariant.executionState?.executions[0]?.usage?.totalTokens, 120);
    const events = database.listEvents(config.id);
    assert.ok(events.length >= 3);
    assert.deepEqual(
      events.map((event) => event.id),
      [...events.map((event) => event.id)].sort((left, right) => left - right),
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
