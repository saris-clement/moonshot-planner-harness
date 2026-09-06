import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import type { HarnessPaths } from '../src/paths.js';
import { writeAgentHistory, writeVariantReport } from '../src/reports.js';
import { CampaignConfigSchema, type RunFacts } from '../src/types.js';

const runFacts: RunFacts = {
  status: 'completed',
  sampleSize: 1,
  decisionAgreement: 1,
  unitCount: 1,
  decisions: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
  shortlist: { empty: 1, nonempty: 0, candidates: 0 },
  evidence: { discovered: 0, selectedSourceRefs: 0 },
  usage: {
    calls: 1,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: 0.01,
    durationMs: 1,
  },
  pins: {},
  units: [
    {
      id: 'unit-a',
      key: 'unit-a',
      ref: { entity: 'solution/main', anchor: 'unit-a' },
      kind: 'field',
      semantics: 'A field.',
      decision: 'build',
      confidence: 'high',
      rationale: 'No evidence.',
      selectedCandidateIds: [],
      sourceRefs: [],
      discoveredEvidenceCount: 0,
      shortlistCandidateCount: 0,
      uncoveredSemantics: ['field'],
    },
  ],
};

test('reports and history keep diagnosis separate from measured, judge, and human evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-diagnosis-'));
  const paths: HarnessPaths = {
    root,
    database: path.join(root, 'harness.sqlite'),
    campaigns: path.join(root, 'campaigns'),
    worktrees: path.join(root, 'worktrees'),
    artifacts: path.join(root, 'artifacts'),
    reports: path.join(root, 'reports'),
  };
  await Promise.all([mkdir(paths.reports), mkdir(paths.campaigns)]);
  const database = new HarnessDatabase(paths.database);
  try {
    const config = CampaignConfigSchema.parse({
      id: 'report-diagnosis',
      goal: 'Keep measured outputs and model-generated diagnoses visibly separate in reports.',
      plannerRepo: root,
      workflowsRepo: root,
      environmentFile: path.join(root, 'environment.env'),
      seedRevision: 'seed',
      workflowsRevision: 'workflows',
      benchmarks: [
        { name: 'primary-pack', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout-pack', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
      ],
    });
    const campaign = database.createCampaign(
      config,
      'a'.repeat(40),
      'b'.repeat(40),
      `sha256:${'c'.repeat(64)}`,
      'https://example.invalid/workflows.git',
    );
    const created = database.createVariant({
      id: 'report-diagnosis-v000',
      campaignId: campaign.id,
      parentVariantId: null,
      round: 0,
      ordinal: 0,
      hypothesis: {
        title: 'Seed',
        rationale: 'Observe.',
        instructions: 'Do not edit.',
        expectedImpact: 'Facts.',
        risk: 'Variance.',
        findingIds: [],
      },
    });
    const diagnosisInputHash = `sha256:${'d'.repeat(64)}`;
    const judgment = {
      summary: 'Blind judge suggestion.',
      verdicts: [
        {
          unitKey: 'unit-a',
          expectedDecision: 'reuse' as const,
          classification: 'system_error' as const,
          confidence: 'medium' as const,
          rationale: 'Suggested only.',
          evidence: ['src/a.ts:1'],
        },
      ],
    };
    const variant = database.updateVariant(created.id, {
      status: 'review',
      artifactCollectionComplete: true,
      facts: runFacts,
      replicateFacts: [runFacts],
      holdoutFacts: { 'holdout-pack': runFacts },
      holdoutReplicateFacts: { 'holdout-pack': [runFacts] },
      judgment,
      score: {
        cohortMismatches: [],
        verified: { labeled: 1, correct: 0, errors: 1, accuracy: 0 },
        provisional: { labeled: 0, correct: 0, errors: 0, accuracy: null },
        decisionErrors: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
      },
      diagnosisStatus: 'completed',
      diagnosisInputHash,
      diagnosis: {
        kind: 'ainative-planner-eval/model-diagnosis',
        schemaVersion: 1,
        interpretationStatus: 'unverified_model_judgment',
        inputSha256: diagnosisInputHash,
        summary: 'Model-generated diagnosis summary.',
        findings: [
          {
            id: 'finding-hydration',
            category: 'evidence_hydration',
            affectedUnitKeys: ['unit-a'],
            causalMechanism: 'Evidence may have been lost.',
            supportingEvidenceRefs: ['evidence-1111111111111111'],
            counterEvidenceRefs: ['evidence-2222222222222222'],
            confidence: 'medium',
            genericIntervention: 'Retain evidence.',
            falsificationTest: 'Exercise valid and invalid declarations.',
            limitations: ['Unverified model inference.'],
            provenance: 'model_inference',
          },
        ],
        limitations: ['Unverified model inference.'],
      },
    });
    const label = database.upsertLabel({
      campaignId: campaign.id,
      benchmark: 'primary-pack',
      unitKey: 'unit-a',
      expectedDecision: 'reuse',
      classification: 'system_error',
      rationale: 'Human verified.',
      status: 'verified',
    });
    const reportPath = await writeVariantReport(paths, campaign, variant, [label]);
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /## Actual Facts/);
    assert.match(report, /## LLM Suggestion/);
    assert.match(report, /## Model-Generated Diagnosis/);
    assert.match(report, /does not contribute to numeric scoring/);
    assert.ok(report.indexOf('## Actual Facts') < report.indexOf('## Model-Generated Diagnosis'));

    const historyPath = path.join(paths.campaigns, 'history.json');
    await writeAgentHistory(historyPath, paths.reports, campaign, [variant], [label]);
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as Record<string, unknown>;
    const serialized = JSON.stringify(history);
    assert.match(serialized, /"benchmark":"primary-pack"/);
    assert.match(serialized, /"interpretationStatus":"unverified_model_judgment"/);
    assert.match(serialized, /"unverified":true/);
    assert.match(serialized, /"holdouts":\{"holdout-pack"/);
    assert.match(serialized, /"supportingEvidenceRefs"/);
    assert.match(serialized, /"counterEvidenceRefs"/);
    assert.match(serialized, /"falsificationTest"/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
