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
        findingIds: [],
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
    const targetConfig = database.createTargetExcludedConfig(config.id, {
      targetImplementationWorkflow: 'trumark/deceased-accounts',
      baselineVariantId: variant.id,
      comparatorImage: `sha256:${'d'.repeat(64)}`,
      configuredAt: '2026-09-06T12:00:00.000Z',
      replicates: 2,
      concurrency: 2,
      warningBuildDropRatio: 0.08,
      blockBuildDropRatio: 0.15,
    });
    const targetEvaluation = database.createTargetExcludedEvaluation(config.id, variant.id);
    database.updateTargetExcludedEvaluation(variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
    });
    database.upsertTargetExcludedLabel({
      campaignId: config.id,
      unitKey: 'unit-a',
      expectedDecision: 'build',
      classification: 'real_gap',
      rationale: 'The target is excluded and no shared source implements the behavior.',
      status: 'verified',
    });

    assert.equal(database.getCampaign(config.id).currentParentVariantId, variant.id);
    assert.equal(database.getCampaign(config.id).noImprovementRounds, 1);
    assert.equal(database.acquireLease(config.id, 'owner-a', 60_000), true);
    assert.equal(database.acquireLease(config.id, 'owner-b', 60_000), false);
    database.releaseLease(config.id, 'owner-a');
    assert.equal(database.acquireLease(config.id, 'owner-b', 60_000), true);
    assert.equal(database.listLabels(config.id)[0]?.status, 'verified');
    assert.equal(targetConfig.replicates, 2);
    assert.equal(targetEvaluation.variantId, variant.id);
    assert.equal(database.getTargetExcludedEvaluation(variant.id)?.status, 'running');
    assert.equal(database.listTargetExcludedLabels(config.id)[0]?.expectedDecision, 'build');
    assert.throws(
      () => database.createTargetExcludedConfig(config.id, targetConfig),
      /already configured/,
    );
    const persistedVariant = database.getVariant(variant.id);
    assert.equal(persistedVariant.elapsedMs, 600_000);
    assert.equal(persistedVariant.phase2ElapsedMs, 240_000);
    assert.equal(persistedVariant.executionState?.executions[0]?.caseId, 'case-a');
    assert.equal(persistedVariant.executionState?.executions[0]?.elapsedMs, 120_000);
    assert.equal(persistedVariant.executionState?.executions[0]?.usage?.totalTokens, 120);
    const diagnosisInputHash = `sha256:${'e'.repeat(64)}`;
    database.updateVariant(variant.id, {
      diagnosisStatus: 'completed',
      diagnosisInputHash,
      diagnosis: {
        kind: 'ainative-planner-eval/model-diagnosis',
        schemaVersion: 1,
        interpretationStatus: 'unverified_model_judgment',
        inputSha256: diagnosisInputHash,
        summary: 'A model-generated diagnosis.',
        findings: [
          {
            id: 'finding-hydration',
            category: 'evidence_hydration',
            affectedUnitKeys: ['unit-a'],
            causalMechanism: 'Evidence was rejected after a source read.',
            supportingEvidenceRefs: ['evidence-1111111111111111'],
            counterEvidenceRefs: ['evidence-2222222222222222'],
            confidence: 'medium',
            genericIntervention: 'Retain qualified executable evidence.',
            falsificationTest: 'Admit a valid source declaration and preserve build decisions for gaps.',
            limitations: ['This is model inference.'],
            provenance: 'model_inference',
          },
        ],
        limitations: ['This is model inference.'],
      },
      diagnosisError: null,
    });
    assert.equal(database.getVariant(variant.id).diagnosisStatus, 'completed');
    assert.equal(database.getVariant(variant.id).diagnosis?.findings[0]?.id, 'finding-hydration');
    database.upsertLabel({
      campaignId: config.id,
      benchmark: 'primary-pack',
      unitKey: 'unit-a',
      expectedDecision: 'reuse',
      classification: 'system_error',
      rationale: 'Human review updated the verified rationale.',
      status: 'verified',
    });
    const staleVariant = database.getVariant(variant.id);
    assert.equal(staleVariant.diagnosisStatus, 'stale');
    assert.equal(staleVariant.diagnosisInputHash, diagnosisInputHash);
    assert.match(staleVariant.diagnosisError ?? '', /Human label changed.*primary-pack\/unit-a/);
    const events = database.listEvents(config.id);
    assert.ok(events.length >= 3);
    assert.ok(events.some((event) => event.type === 'diagnosis.stale'));
    assert.deepEqual(
      events.map((event) => event.id),
      [...events.map((event) => event.id)].sort((left, right) => left - right),
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
