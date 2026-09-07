import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CampaignConfigSchema,
  DiagnosisFindingSchema,
  DiagnosisProvenanceSchema,
  HypothesisSchema,
  TargetExcludedConfigSchema,
  type BenchmarkQuestionResolution,
  type QuestionResolutionEntry,
  type TargetExcludedComparison,
  TargetNormalArmBindingSchema,
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

test('campaign defaults reserve twelve hours of aggregate Phase 2 model duration', () => {
  const config = CampaignConfigSchema.parse({
    id: 'phase2-duration-default',
    goal: 'Keep large V13 requirement cohorts inside the aggregate duration ceiling.',
    plannerRepo: '/tmp/planner',
    workflowsRepo: '/tmp/workflows',
    environmentFile: '/tmp/planner.env',
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
      { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' },
    ],
  });

  assert.equal(config.limits.phase2TimeoutMs, 43_200_000);
});

test('campaign target-excluded v2 declaration requires exactly two evaluation replicates', () => {
  const input = {
    id: 'target-excluded-v2',
    goal: 'Compare target exclusion against the standard primary evaluation arm.',
    plannerRepo: '/tmp/planner',
    workflowsRepo: '/tmp/workflows',
    environmentFile: '/tmp/planner.env',
    seedRevision: 'seed',
    workflowsRevision: 'source',
    benchmarks: [
      { name: 'primary-pack', role: 'primary' as const, zipPath: '/tmp/primary.zip' },
      { name: 'holdout-pack', role: 'holdout' as const, zipPath: '/tmp/holdout.zip' },
    ],
    targetExcluded: {
      protocol: 'standard-primary-v2' as const,
      targetImplementationWorkflow: 'trumark/deceased-accounts',
    },
  };

  assert.equal(
    CampaignConfigSchema.safeParse({
      ...input,
      evaluation: { replicates: 3, replicateConcurrency: 2 },
    }).success,
    false,
  );
  const parsed = CampaignConfigSchema.parse({
    ...input,
    evaluation: { replicates: 2, replicateConcurrency: 2 },
  });
  assert.equal(parsed.targetExcluded?.protocol, 'standard-primary-v2');
  assert.equal(
    CampaignConfigSchema.safeParse({
      ...input,
      evaluation: { replicates: 2, replicateConcurrency: 2 },
      targetExcluded: { ...input.targetExcluded, extra: true },
    }).success,
    false,
  );
});

test('campaign configs without target-excluded declarations remain valid', () => {
  const parsed = CampaignConfigSchema.parse({
    id: 'legacy-campaign',
    goal: 'Continue accepting existing campaign configuration documents unchanged.',
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

  assert.equal(parsed.targetExcluded, undefined);
  assert.equal(parsed.evaluation.replicates, 3);
});

test('legacy target-excluded config parses as dedicated-control-v1', () => {
  const config = TargetExcludedConfigSchema.parse({
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: 'campaign-v007',
    comparatorImage: `sha256:${'a'.repeat(64)}`,
    configuredAt: '2026-09-06T12:00:00.000Z',
  });

  assert.equal(config.protocol, 'dedicated-control-v1');
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

test('standard-primary-v2 target-excluded runtime config parses with its normal arm source', () => {
  const config = TargetExcludedConfigSchema.parse({
    protocol: 'standard-primary-v2',
    normalArmSource: 'standard_primary',
    primaryResolvedArtifactSha: `sha256:${'b'.repeat(64)}`,
    targetImplementationWorkflow: 'trumark/deceased-accounts',
    baselineVariantId: 'campaign-v007',
    comparatorImage: `sha256:${'a'.repeat(64)}`,
    configuredAt: '2026-09-06T12:00:00.000Z',
  });

  assert.equal(config.protocol, 'standard-primary-v2');
  if (config.protocol !== 'standard-primary-v2') assert.fail('expected v2 config');
  assert.equal(config.normalArmSource, 'standard_primary');
  assert.equal(config.primaryResolvedArtifactSha, `sha256:${'b'.repeat(64)}`);
  assert.equal(config.replicates, 2);
});

test('target normal arm binding is strict and fixes replicate ordinals to one then two', () => {
  const binding = {
    source: 'standard_primary' as const,
    benchmark: 'primary-pack',
    resolvedArtifactSha: `sha256:${'c'.repeat(64)}`,
    replicates: [
      { replicate: 1 as const, caseId: 'case-1', runId: 'run-1' },
      { replicate: 2 as const, caseId: 'case-2', runId: 'run-2' },
    ],
  };

  assert.deepEqual(TargetNormalArmBindingSchema.parse(binding), binding);
  assert.equal(
    TargetNormalArmBindingSchema.safeParse({
      ...binding,
      replicates: [binding.replicates[1], binding.replicates[0]],
    }).success,
    false,
  );
  assert.equal(
    TargetNormalArmBindingSchema.safeParse({
      ...binding,
      replicates: [{ ...binding.replicates[0], caseId: '' }, binding.replicates[1]],
    }).success,
    false,
  );
  assert.equal(
    TargetNormalArmBindingSchema.safeParse({
      ...binding,
      replicates: [binding.replicates[0], { ...binding.replicates[1], runId: 'x'.repeat(257) }],
    }).success,
    false,
  );
  assert.equal(
    TargetNormalArmBindingSchema.safeParse({ ...binding, resolvedArtifactSha: 'not-a-sha' }).success,
    false,
  );
  assert.equal(TargetNormalArmBindingSchema.safeParse({ ...binding, extra: true }).success, false);
});

test('persisted target-excluded comparisons permit absent legacy case and run IDs as null', () => {
  const comparison: TargetExcludedComparison = {
    replicate: 1,
    normalCaseId: null,
    excludedCaseId: null,
    normalRunId: null,
    excludedRunId: null,
    valid: true,
    mismatches: [],
    leakagePaths: [],
    reportHash: null,
  };

  assert.equal(comparison.normalCaseId, null);
  assert.equal(comparison.excludedCaseId, null);
  assert.equal(comparison.normalRunId, null);
  assert.equal(comparison.excludedRunId, null);
});

test('question resolution types represent PM simulation while legacy summaries omit its counter', () => {
  const entry: QuestionResolutionEntry = {
    id: 'question-pm',
    question: 'Which policy should apply?',
    resolution: 'pm_simulation',
    answer: 'Use the reviewed default policy.',
    evidence: ['PM simulation based on the supplied requirements context.'],
  };
  const legacySummary: BenchmarkQuestionResolution = {
    derivationVersion: 2,
    benchmark: 'legacy-pack',
    originalArtifactSha: `sha256:${'a'.repeat(64)}`,
    resolvedArtifactSha: `sha256:${'b'.repeat(64)}`,
    blockingQuestions: 1,
    requirementsAgentRequests: 1,
    requirementsAgentAnswers: 0,
    sourceFallbackAnswers: 1,
    reusedAnswers: 0,
    plannerQuestions: 0,
    plannerRequirementsAgentRequests: 0,
    plannerRequirementsAgentAnswers: 0,
    plannerSourceFallbackAnswers: 0,
    plannerReusedAnswers: 0,
    entries: [],
  };

  assert.equal(entry.resolution, 'pm_simulation');
  assert.equal(legacySummary.pmSimulationAnswers ?? 0, 0);
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
