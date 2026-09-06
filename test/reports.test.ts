import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    assert.match(report, /The baseline plan below is harness-authored/);
    assert.ok(report.indexOf('## Actual Facts') < report.indexOf('## Model-Generated Diagnosis'));

    const historyPath = path.join(paths.campaigns, 'history.json');
    const historicalPath = path.join(
      paths.reports,
      'history',
      'planner-7ca5cad',
      'phase2-v13c-experiment-axes.md',
    );
    const historicalContent = '# V13c experiment axes\n\nNo results claimed.\n';
    await mkdir(path.dirname(historicalPath), { recursive: true });
    await writeFile(historicalPath, historicalContent);
    await writeFile(
      path.join(paths.reports, 'history', 'manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceRepository: 'Saris-AI/moonshot-planner-poc',
          sourceRevision: '7ca5cadcc64a0b3951ebb24d481343ec8d23f5a1',
          materials: [
            {
              name: 'V13c experiment axes',
              path: 'history/planner-7ca5cad/phase2-v13c-experiment-axes.md',
              sha256: `sha256:${createHash('sha256').update(historicalContent).digest('hex')}`,
              kind: 'experiment_plan',
              comparability: 'historical_context_only',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(path.join(paths.reports, 'unverified.md'), 'This must not enter strategist history.\n');
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
    assert.match(serialized, /"name":"V13c experiment axes"/);
    assert.match(serialized, /"comparability":"historical_context_only"/);
    assert.match(serialized, /No results claimed/);
    assert.doesNotMatch(serialized, /This must not enter strategist history/);

    const manifestPath = path.join(paths.reports, 'history', 'manifest.json');
    const outsideManifest = path.join(root, 'outside-manifest.json');
    await writeFile(outsideManifest, await readFile(manifestPath, 'utf8'));
    await rm(manifestPath);
    await symlink(outsideManifest, manifestPath);
    await assert.rejects(
      writeAgentHistory(historyPath, paths.reports, campaign, [variant], [label]),
      /historical research manifest must be a contained regular file/,
    );

    const outsideHistory = path.join(root, 'outside-history');
    await rm(path.join(paths.reports, 'history'), { recursive: true });
    await mkdir(outsideHistory);
    await symlink(outsideHistory, path.join(paths.reports, 'history'));
    await assert.rejects(
      writeAgentHistory(historyPath, paths.reports, campaign, [variant], [label]),
      /historical research root must be a real directory/,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('experiment Markdown records the planned change, evidence-backed conclusion, and preserved human notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-narrative-'));
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
      id: 'report-narrative',
      goal: 'Test one bounded, source-backed planner intervention.',
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
    const diagnosisInputHash = `sha256:${'d'.repeat(64)}`;
    const parent = database.updateVariant(
      database.createVariant({
        id: 'report-narrative-v000',
        campaignId: campaign.id,
        parentVariantId: null,
        round: 0,
        ordinal: 0,
        hypothesis: {
          title: 'Baseline',
          rationale: 'Measure the seed.',
          instructions: 'Do not change the planner.',
          expectedImpact: 'Establish facts.',
          risk: 'Provider variance.',
          findingIds: [],
        },
      }).id,
      {
        status: 'completed',
        artifactCollectionComplete: true,
        facts: runFacts,
        replicateFacts: [runFacts],
        score: {
          cohortMismatches: [],
          verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
          provisional: { labeled: 1, correct: 0, errors: 1, accuracy: 0 },
          decisionErrors: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
        },
        diagnosisStatus: 'completed',
        diagnosisInputHash,
        diagnosisResultHash: `sha256:${'e'.repeat(64)}`,
        diagnosis: {
          kind: 'ainative-planner-eval/model-diagnosis',
          schemaVersion: 1,
          interpretationStatus: 'unverified_model_judgment',
          inputSha256: diagnosisInputHash,
          summary: 'Evidence admission may create false absence.',
          findings: [
            {
              id: 'finding-admission',
              category: 'evidence_hydration',
              affectedUnitKeys: ['unit-a'],
              causalMechanism: 'Qualified evidence is rejected before adjudication.',
              supportingEvidenceRefs: ['evidence-1111111111111111'],
              counterEvidenceRefs: ['evidence-2222222222222222'],
              confidence: 'high',
              genericIntervention: 'Retain qualified evidence.',
              falsificationTest: 'Admit valid evidence while rejecting declarations.',
              limitations: ['This is model inference.'],
              provenance: 'model_inference',
            },
          ],
          limitations: ['This is model inference.'],
        },
      },
    );
    const child = database.updateVariant(
      database.createVariant({
        id: 'report-narrative-v001',
        campaignId: campaign.id,
        parentVariantId: parent.id,
        round: 1,
        ordinal: 1,
        hypothesis: {
          title: 'Retain qualified evidence',
          rationale: 'Test the cited admission mechanism.',
          instructions: 'Preserve qualified executable evidence through adjudication.',
          expectedImpact: 'Reduce unsupported build decisions.',
          risk: 'Could admit declarations without behavioral evidence.',
          findingIds: ['finding-admission'],
          assumptions: [
            'Rejected qualified evidence contributes to unsupported build decisions.',
          ],
          findingSnapshots: [
            {
              id: 'finding-admission',
              category: 'evidence_hydration',
              causalMechanism: 'Qualified evidence is rejected before adjudication.',
              supportingEvidenceRefs: ['evidence-1111111111111111'],
              counterEvidenceRefs: ['evidence-2222222222222222'],
              confidence: 'high',
              genericIntervention: 'Retain qualified evidence.',
              falsificationTest: 'Admit valid evidence while rejecting declarations.',
              limitations: ['This is model inference.'],
            },
          ],
        },
      }).id,
      {
        status: 'review',
        artifactCollectionComplete: true,
        facts: runFacts,
        replicateFacts: [runFacts],
        score: {
          cohortMismatches: [],
          verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
          provisional: { labeled: 1, correct: 0, errors: 1, accuracy: 0 },
          decisionErrors: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 },
        },
        diagnosisStatus: 'not_started',
      },
    );
    const notesPath = path.join(paths.reports, campaign.id, 'human', `${child.id}.md`);
    await mkdir(path.dirname(notesPath), { recursive: true });
    await writeFile(notesPath, '  Reviewer note: inspect the rejected evidence cohort.\n');

    const changedParent = database.updateVariant(parent.id, {
      diagnosis: { ...parent.diagnosis!, findings: [] },
    });
    const reportPath = await writeVariantReport(paths, campaign, child, [], null, changedParent);
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /## Base Assumptions/);
    assert.match(report, /Rejected qualified evidence contributes/);
    assert.match(report, /## Observed Issues/);
    assert.match(report, /finding-admission/);
    assert.match(report, /## Planned Change/);
    assert.match(report, /Preserve qualified executable evidence through adjudication/);
    assert.match(report, /## Baseline Metrics/);
    assert.match(report, /## Conclusion/);
    assert.match(report, /Correctness remains unverified/);
    assert.match(report, /\| Question \| Agreement \|/);
    assert.match(report, /## Evidence Ledger/);
    assert.ok(report.includes(path.join(paths.artifacts, campaign.id, child.id)));
    assert.match(report, /## Human Notes/);
    assert.match(report, /Reviewer note: inspect the rejected evidence cohort/);
    assert.ok(report.includes('\n  Reviewer note: inspect the rejected evidence cohort.\n'));

    await writeVariantReport(paths, campaign, child, [], null, changedParent);
    assert.equal(
      await readFile(notesPath, 'utf8'),
      '  Reviewer note: inspect the rejected evidence cohort.\n',
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
