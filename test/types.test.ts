import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CampaignConfigSchema,
  DiagnosisFindingSchema,
  DiagnosisProvenanceSchema,
  HypothesisSchema,
  TargetExcludedConfigSchema,
} from '../src/types.js';

test('campaign benchmark names are unique across primary and holdouts', () => {
  const result = CampaignConfigSchema.safeParse({
    id: 'duplicate-benchmarks',
    goal: 'Reject benchmark names that would overwrite replicate execution telemetry.',
    plannerRepo: '/tmp/planner',
    workflowsRepo: '/tmp/workflows',
    environmentFile: '/tmp/planner.env',
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'same-pack', role: 'primary', zipPath: '/tmp/primary.zip' },
      { name: 'same-pack', role: 'holdout', zipPath: '/tmp/holdout.zip' },
    ],
  });

  assert.equal(result.success, false);
});

test('target-excluded protocol is fixed to two parallel replicates', () => {
  const config = TargetExcludedConfigSchema.parse({
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: 'campaign-v007',
    comparatorImage: `sha256:${'a'.repeat(64)}`,
    configuredAt: '2026-09-06T12:00:00.000Z',
  });

  assert.equal(config.replicates, 2);
  assert.equal(config.concurrency, 2);
  assert.equal(config.warningBuildDropRatio, 0.08);
  assert.equal(config.blockBuildDropRatio, 0.15);
  assert.equal(
    TargetExcludedConfigSchema.safeParse({
      targetImplementationWorkflow: 'Deceased Accounts',
      baselineVariantId: 'campaign-v007',
      comparatorImage: `sha256:${'a'.repeat(64)}`,
      configuredAt: '2026-09-06T12:00:00.000Z',
    }).success,
    false,
  );
});

test('diagnosis and strategist handoff schemas are strict and provenance-explicit', () => {
  const provenance = DiagnosisProvenanceSchema.parse({
    classification: 'observed_durable',
    source: 's3',
    artifactPath: 's3/prefix/tool-transcripts/entry.json',
    artifactSha256: `sha256:${'a'.repeat(64)}`,
    integrity: 'verified',
    caseId: 'case-a',
    runId: 'run-a',
    unitKey: 'unit-a',
    limitation: null,
  });
  assert.equal(provenance.classification, 'observed_durable');
  assert.equal(
    DiagnosisProvenanceSchema.safeParse({ ...provenance, credentials: 'not allowed' }).success,
    false,
  );

  const finding = {
    id: 'finding-hydration',
    category: 'evidence_hydration',
    affectedUnitKeys: ['unit-a'],
    causalMechanism: 'A source read was rejected before admission.',
    supportingEvidenceRefs: ['evidence-1111111111111111'],
    counterEvidenceRefs: ['evidence-2222222222222222'],
    confidence: 'medium',
    genericIntervention: 'Retain qualified executable evidence.',
    falsificationTest: 'Admit executable declarations while rejecting type-only aliases.',
    limitations: ['Model inference is not verified truth.'],
    provenance: 'model_inference',
  };
  assert.equal(DiagnosisFindingSchema.parse(finding).category, 'evidence_hydration');
  assert.equal(
    DiagnosisFindingSchema.safeParse({ ...finding, counterEvidenceRefs: [] }).success,
    false,
  );
  assert.deepEqual(
    HypothesisSchema.parse({
      title: 'Historical baseline',
      rationale: 'No strategist generated this baseline.',
      instructions: 'Do not edit.',
      expectedImpact: 'Facts.',
      risk: 'Variance.',
    }).findingIds,
    [],
  );
});
