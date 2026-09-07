import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { CampaignConfigSchema, type TargetNormalArmBinding } from '../src/types.js';

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
      patchHash: `sha256:${'0'.repeat(64)}`,
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
    const normalArmBinding: TargetNormalArmBinding = {
      source: 'standard_primary',
      benchmark: 'primary-pack',
      resolvedArtifactSha: `sha256:${'f'.repeat(64)}`,
      replicates: [
        { replicate: 1, caseId: 'case-primary-1', runId: 'run-primary-1' },
        { replicate: 2, caseId: 'case-primary-2', runId: 'run-primary-2' },
      ],
    };
    database.updateTargetExcludedEvaluation(variant.id, {
      status: 'running',
      artifactCollectionComplete: false,
      normalArmBinding,
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
    assert.equal(targetConfig.protocol, 'dedicated-control-v1');
    assert.equal(targetConfig.replicates, 2);
    assert.equal(targetEvaluation.variantId, variant.id);
    const persistedTargetEvaluation = database.getTargetExcludedEvaluation(variant.id);
    assert.equal(persistedTargetEvaluation?.status, 'running');
    assert.deepEqual(persistedTargetEvaluation?.normalArmBinding, normalArmBinding);
    assert.equal(persistedTargetEvaluation?.controlFacts, null);
    assert.equal(persistedTargetEvaluation?.controlReplicateFacts, null);
    assert.equal(database.listTargetExcludedLabels(config.id)[0]?.expectedDecision, 'build');
    assert.throws(
      () => database.createTargetExcludedConfig(config.id, targetConfig),
      /already configured/,
    );
    const persistedVariant = database.getVariant(variant.id);
    assert.deepEqual(persistedVariant.hypothesisComplianceAttempts, []);
    assert.equal(persistedVariant.elapsedMs, 600_000);
    assert.equal(persistedVariant.patchHash, `sha256:${'0'.repeat(64)}`);
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
    const compliance = {
      kind: 'ainative-planner-eval/hypothesis-compliance' as const,
      schemaVersion: 1 as const,
      interpretationStatus: 'unverified_model_judgment' as const,
      variantId: variant.id,
      patchSha256: `sha256:${'1'.repeat(64)}`,
      mutationContextSha256: `sha256:${'2'.repeat(64)}`,
      status: 'passed' as const,
      summary: 'The patch aligns with the bounded intervention.',
      intervention: {
        status: 'satisfied' as const,
        rationale: 'Runtime behavior changed at the cited mechanism.',
        evidence: ['server/src/policy.ts:12'],
      },
      falsificationTest: {
        status: 'satisfied' as const,
        rationale: 'A positive and negative regression was added.',
        evidence: ['server/test/policy.test.ts:40'],
      },
      limitations: ['This is an unverified model judgment.'],
    };
    database.updateVariant(variant.id, {
      hypothesisComplianceStatus: 'passed',
      hypothesisCompliancePatchHash: compliance.patchSha256,
      hypothesisComplianceCandidatePatchHash: `sha256:${'4'.repeat(64)}`,
      hypothesisComplianceResultHash: `sha256:${'3'.repeat(64)}`,
      hypothesisCompliance: compliance,
      hypothesisComplianceError: null,
    });
    const compliantVariant = database.getVariant(variant.id);
    assert.equal(compliantVariant.hypothesisComplianceStatus, 'passed');
    assert.equal(compliantVariant.hypothesisCompliance?.status, 'passed');
    assert.equal(compliantVariant.hypothesisCompliancePatchHash, compliance.patchSha256);
    assert.equal(
      compliantVariant.hypothesisComplianceCandidatePatchHash,
      `sha256:${'4'.repeat(64)}`,
    );
    assert.equal(compliantVariant.hypothesisComplianceResultHash, `sha256:${'3'.repeat(64)}`);
    const attemptResult = {
      ...compliance,
      schemaVersion: 2 as const,
      codeRegression: {
        status: 'satisfied' as const,
        rationale: 'The deterministic boundary has regression coverage.',
        evidence: ['server/test/policy.test.ts:40'],
      },
    };
    const attempt = {
      variantId: variant.id,
      attempt: 1,
      phase: 'initial' as const,
      outcome: 'passed' as const,
      treatmentPatchSha256: compliance.patchSha256,
      candidatePatchSha256: `sha256:${'4'.repeat(64)}`,
      mutationContextSha256: compliance.mutationContextSha256,
      resultSha256: `sha256:${'3'.repeat(64)}`,
      result: attemptResult,
      error: null,
      startedAt: '2026-09-07T10:00:00.000Z',
      completedAt: '2026-09-07T10:01:00.000Z',
    };
    database.appendHypothesisComplianceAttempt(variant.id, attempt);
    database.appendHypothesisComplianceAttempt(variant.id, attempt);
    assert.deepEqual(database.getVariant(variant.id).hypothesisComplianceAttempts, [attempt]);
    assert.throws(
      () =>
        database.appendHypothesisComplianceAttempt(variant.id, {
          ...attempt,
          completedAt: '2026-09-07T10:02:00.000Z',
        }),
      /immutable hypothesis compliance attempt changed/,
    );
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

test('database additively migrates target-excluded evaluations and reads legacy config JSON as v1', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'planner-eval-db-legacy-'));
  const filePath = path.join(directory, 'test.sqlite');
  const legacyDatabase = new DatabaseSync(filePath);
  legacyDatabase.exec(`
    CREATE TABLE target_excluded_evaluations (
      variant_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      status TEXT NOT NULL,
      control_facts_json TEXT,
      control_replicate_facts_json TEXT,
      holdout_facts_json TEXT,
      holdout_replicate_facts_json TEXT,
      excluded_facts_json TEXT,
      excluded_replicate_facts_json TEXT,
      judgment_json TEXT,
      score_json TEXT,
      question_resolution_json TEXT,
      execution_state_json TEXT,
      comparisons_json TEXT,
      gate_json TEXT,
      artifact_collection_complete INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(campaign_id, variant_id)
    );
    INSERT INTO target_excluded_evaluations
      (variant_id, campaign_id, status, created_at, updated_at)
    VALUES
      ('legacy-variant', 'legacy-campaign', 'queued', '2026-09-06T12:00:00.000Z', '2026-09-06T12:00:00.000Z');
  `);
  const legacyComparisons = [
    {
      replicate: 1,
      valid: true,
      mismatches: [],
      leakagePaths: [],
      reportHash: null,
    },
  ];
  legacyDatabase
    .prepare(
      `UPDATE target_excluded_evaluations
       SET comparisons_json = ?
       WHERE variant_id = 'legacy-variant'`,
    )
    .run(JSON.stringify(legacyComparisons));
  legacyDatabase.close();

  const database = new HarnessDatabase(filePath);
  try {
    const columns = database.database.prepare('PRAGMA table_info(target_excluded_evaluations)').all() as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === 'normal_arm_binding_json'));
    const legacyEvaluation = database.getTargetExcludedEvaluation('legacy-variant');
    assert.equal(legacyEvaluation?.normalArmBinding, null);
    assert.deepEqual(legacyEvaluation?.comparisons, [
      {
        ...legacyComparisons[0],
        normalCaseId: null,
        excludedCaseId: null,
        normalRunId: null,
        excludedRunId: null,
      },
    ]);
    const storedLegacyComparisons = database.database
      .prepare(
        `SELECT comparisons_json
         FROM target_excluded_evaluations
         WHERE variant_id = 'legacy-variant'`,
      )
      .get() as { comparisons_json: string };
    assert.deepEqual(JSON.parse(storedLegacyComparisons.comparisons_json), legacyComparisons);
    database.database
      .prepare(
        `UPDATE target_excluded_evaluations
         SET normal_arm_binding_json = ?
         WHERE variant_id = 'legacy-variant'`,
      )
      .run(
        JSON.stringify({
          source: 'standard_primary',
          benchmark: 'primary-pack',
          resolvedArtifactSha: `sha256:${'f'.repeat(64)}`,
          replicates: [
            { replicate: 2, caseId: 'case-2', runId: 'run-2' },
            { replicate: 1, caseId: 'case-1', runId: 'run-1' },
          ],
        }),
      );
    assert.throws(() => database.getTargetExcludedEvaluation('legacy-variant'));

    const config = CampaignConfigSchema.parse({
      id: 'persisted-legacy-config',
      goal: 'Verify legacy target-excluded configuration remains readable without rewriting it.',
      plannerRepo: '/tmp/planner',
      workflowsRepo: '/tmp/workflows',
      environmentFile: '/tmp/planner.env',
      seedRevision: 'seed',
      workflowsRevision: 'source',
      benchmarks: [
        { name: 'primary-pack', role: 'primary', zipPath: '/tmp/primary.zip' },
        { name: 'holdout-pack', role: 'holdout', zipPath: '/tmp/holdout.zip' },
      ],
    });
    database.createCampaign(
      config,
      'a'.repeat(40),
      'b'.repeat(40),
      `sha256:${'c'.repeat(64)}`,
      'https://github.com/Saris-AI/workflows.git',
    );
    const legacyConfig = {
      targetImplementationWorkflow: 'trumark/deceased-accounts',
      baselineVariantId: 'persisted-legacy-config-v000',
      comparatorImage: `sha256:${'d'.repeat(64)}`,
      configuredAt: '2026-09-06T12:00:00.000Z',
      replicates: 2,
      concurrency: 2,
      warningBuildDropRatio: 0.08,
      blockBuildDropRatio: 0.15,
    };
    database.database
      .prepare(
        `INSERT INTO target_excluded_configs (campaign_id, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(config.id, JSON.stringify(legacyConfig), legacyConfig.configuredAt, legacyConfig.configuredAt);

    assert.equal(database.getTargetExcludedConfig(config.id)?.protocol, 'dedicated-control-v1');
    const stored = database.database
      .prepare('SELECT config_json FROM target_excluded_configs WHERE campaign_id = ?')
      .get(config.id) as { config_json: string };
    assert.equal('protocol' in JSON.parse(stored.config_json), false);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
