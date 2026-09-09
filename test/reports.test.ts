import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import type { InvestigationState } from '../src/investigator.js';
import { computeReplicateMeanScore } from '../src/metrics.js';
import type { HarnessPaths } from '../src/paths.js';
import { writeAgentHistory, writeCampaignIndex, writeVariantReport } from '../src/reports.js';
import {
  CampaignConfigSchema,
  type RunFacts,
  type TargetNormalArmBinding,
} from '../src/types.js';

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

test('investigator reports distinguish session states, trial evidence, budgets, and incomplete final measurements', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-investigator-'));
  const paths: HarnessPaths = {
    root, database: path.join(root, 'harness.sqlite'), campaigns: path.join(root, 'campaigns'),
    worktrees: path.join(root, 'worktrees'), artifacts: path.join(root, 'artifacts'), reports: path.join(root, 'reports'),
  };
  const database = new HarnessDatabase(paths.database);
  try {
    const config = CampaignConfigSchema.parse({
      id: 'report-investigator', goal: 'Separate agent development trials from final measured outcomes.',
      plannerRepo: root, workflowsRepo: root, environmentFile: path.join(root, 'environment.env'),
      seedRevision: 'seed', workflowsRevision: 'workflows', investigator: { enabled: true, maxWallTimeMs: 7_200_000 },
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: path.join(root, 'primary.zip') },
        { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
      ],
    });
    const campaign = database.createCampaign(config, 'a'.repeat(40), 'b'.repeat(40), `sha256:${'c'.repeat(64)}`, 'https://example.invalid/workflows.git');
    const created = database.createVariant({
      id: `${campaign.id}-v001`, campaignId: campaign.id, parentVariantId: null, round: 1, ordinal: 1,
      hypothesis: { title: 'Source guard', rationale: 'Challenge the diagnosis.', instructions: 'Inspect source boundaries.', expectedImpact: 'Unverified.', risk: 'Variance.', findingIds: [] },
    });
    const label = database.upsertLabel({ campaignId: campaign.id, benchmark: 'primary', unitKey: 'unit-a', expectedDecision: 'reuse', classification: 'system_error', rationale: 'Provisional baseline reference.', status: 'suggested' });
    const score = computeReplicateMeanScore([runFacts, runFacts], [label], null);
    const action = {
      id: 'action-001', kind: 'test', hypothesis: created.hypothesis, rationale: 'Check the treatment.',
      startedAt: '2026-09-07T10:00:00.000Z', completedAt: '2026-09-07T10:01:00.000Z',
      patchHash: `sha256:${'d'.repeat(64)}`, artifactDirectory: 'investigation/action-001', error: null,
    };
    const diagnosticReview = {
      reviewHash: `sha256:${'1'.repeat(64)}`, artifactHash: `sha256:${'2'.repeat(64)}`,
      artifactPath: 'diagnostic-review.json', interpretationStatus: 'unverified_model_judgment',
    };
    const investigation: InvestigationState = {
      schemaVersion: 1, sessionId: 'session-report', status: 'running', startedAt: action.startedAt,
      updatedAt: '2026-09-07T10:02:00.000Z', turnCount: 4, agentTokens: null, agentCostUsd: null,
      reason: 'A recorded interpretation, not human-reviewed truth.',
      harnessPins: { contextHash: `sha256:${'e'.repeat(64)}`, labelSetHash: `sha256:${'f'.repeat(64)}` },
      actions: [
        { ...action, status: 'failed', patchHash: null, artifactDirectory: null, result: null, error: 'Test failed.\nArtifacts: investigation/action-001' },
        { ...action, id: 'action-002', status: 'completed', result: { passed: true, testFiles: ['server/test/source.test.ts'], logPaths: ['/local/investigation/action-002/tests.log'] } },
        { ...action, id: 'action-003', kind: 'evaluate_primary', status: 'completed', result: { score, baselineScore: score, facts: runFacts, replicateFacts: [runFacts, runFacts], labelSetHash: `sha256:${'f'.repeat(64)}`, diagnosticReview, comparisonNotes: ['Runtime answers are not globally frozen.'], transitions: [{ rawMarker: 'DO_NOT_COPY_RAW_MODEL_OUTPUT' }] } },
        { ...action, id: 'action-004', kind: 'finalize', status: 'completed', result: { passed: true, tests: { passed: true, testFiles: [], logPaths: [] }, compliance: { status: 'passed' } } },
        { ...action, id: 'action-005', kind: 'evaluate_primary', status: 'completed', result: { unknown: 'DO_NOT_COPY_UNKNOWN_RESULT', passed: true } },
        { ...action, id: 'action-006', kind: 'probe', status: 'completed', artifactDirectory: 'investigation/action-006', result: {
          kind: 'diagnostic_probe', executionPassed: true, providerCalls: 0,
          inputHash: `sha256:${'3'.repeat(64)}`, imageId: `sha256:${'4'.repeat(64)}`,
          testFiles: ['server/test/diagnostic.test.ts'], logPaths: ['investigation/action-006/probe.log'],
          interpretation: 'DO_NOT_COPY_RAW_PROBE_INTERPRETATION', diagnosticReview,
        } },
        { ...action, admitted: false, id: 'action-007', kind: 'evaluate_primary', status: 'failed', result: null, error: 'Not admitted: diagnostic review required' },
        { ...action, admitted: true, id: 'action-008', kind: 'evaluate_primary', status: 'failed', result: null, error: 'Admitted planner execution failed.' },
        { ...action, admitted: false, id: 'action-009', kind: 'evaluate_primary', status: 'completed', result: null },
      ],
    };
    for (const status of ['running', 'stopped', 'finalized', 'abandoned', 'budget_exhausted', 'failed'] as const) {
      const variant = database.updateVariant(created.id, {
        status: status === 'failed' ? 'failed' : status === 'finalized' ? 'gating' : ['abandoned', 'budget_exhausted'].includes(status) ? 'rejected' : 'mutating',
        investigation: { ...investigation, status },
      });
      const report = await readFile(await writeVariantReport(paths, campaign, variant, [label]), 'utf8');
      assert.match(report, /## Investigation/);
      assert.ok(report.includes(`| Session status | ${status} |`));
      assert.match(report, /\| Agent tokens \| unknown \| 2000000 \|/);
      assert.match(report, /\| Agent cost USD \| unknown \|/);
      assert.match(report, /\| Turns \| 4 \| 12 \|/);
      assert.match(report, /\| Primary evaluation attempts \| 3 \| 3 \|/);
      assert.match(report, /\| Wall elapsed at last update ms \| 120000 \| 7200000 \|/);
      assert.match(report, /### Action Timeline/);
      assert.match(report, /action-001.*failed/);
      assert.match(report, /Tests passed \(execution only\)/);
      assert.match(report, /Finalization passed; full tests passed; compliance passed \(unverified\)/);
      assert.match(report, /Trial verified: unknown; provisional: 0\.0%/);
      assert.match(report, /Primary result unknown/);
      const probeRow = report.split('\n').find((line) => line.startsWith('| action-006 |'))!;
      assert.match(probeRow, /Offline diagnostic probe.*Execution passed \(diagnostic only\)/);
      assert.match(probeRow, /Provider calls: 0/);
      assert.ok(probeRow.includes(`Input hash: sha256:${'3'.repeat(64)}`));
      assert.ok(probeRow.includes(`Image: sha256:${'4'.repeat(64)}`));
      assert.doesNotMatch(probeRow, /Tests passed|Trial verified|score|Finalization passed/);
      for (const id of ['action-003', 'action-006']) {
        const row = report.split('\n').find((line) => line.startsWith(`| ${id} |`))!;
        assert.ok(row.includes(`Review hash: ${diagnosticReview.reviewHash}`));
        assert.ok(row.includes(`Review artifact hash: ${diagnosticReview.artifactHash}`));
        assert.match(row, /diagnostic-review\.json.*unverified_model_judgment/);
      }
      for (const id of ['action-007', 'action-009']) {
        assert.match(report.split('\n').find((line) => line.startsWith(`| ${id} |`))!, /Not admitted: diagnostic review required/);
      }
      assert.match(report, /Admitted planner execution failed/);
      assert.match(report, /not full configured tests, primary evaluation, or promotion/i);
      assert.match(report, /## Score Basis/);
      assert.match(report, /raw-replicate mean/);
      assert.match(report, /Runtime answers are not globally frozen/);
      assert.match(report, /investigation\/action-001/);
      assert.doesNotMatch(report, /DO_NOT_COPY_|NaN|undefined/);
      const conclusion = report.split('## Conclusion')[1]!.split('## LLM Suggestion')[0]!;
      assert.match(conclusion, status === 'failed' ? /Status: `failed`/ : /Status: `incomplete`/);
      assert.doesNotMatch(conclusion, /pending/);
      assert.match(conclusion, /No final measured facts/);
    }
    const measured = database.updateVariant(created.id, {
      status: 'review', facts: runFacts, score, investigation: { ...investigation, status: 'finalized', agentTokens: 0, agentCostUsd: 0 },
    });
    const report = await readFile(await writeVariantReport(paths, campaign, measured, [label]), 'utf8');
    assert.match(report, /\| Agent tokens \| 0 \| 2000000 \|/);
    assert.match(report, /\| Agent cost USD \| 0\.0000 \|/);
    assert.match(report, /Status: `measured`/);
    assert.match(report, /Consensus decision counts/);
    const index = await readFile(await writeCampaignIndex(paths, campaign, [measured]), 'utf8');
    assert.match(index, /## Investigator Sessions/);
    assert.match(index, /session-report/);
    assert.match(index, /finalized/);
    assert.match(index, /\| report-investigator-v001 \| session-report \| finalized \| 4 \| 3 \| 0 \|/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed runs without facts are failed, not pending, even without an investigator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-failed-'));
  const paths: HarnessPaths = { root, database: path.join(root, 'db.sqlite'), campaigns: path.join(root, 'campaigns'), worktrees: path.join(root, 'worktrees'), artifacts: path.join(root, 'artifacts'), reports: path.join(root, 'reports') };
  const database = new HarnessDatabase(paths.database);
  try {
    const config = CampaignConfigSchema.parse({ id: 'failed-report', goal: 'Do not describe failed experiments as pending measurement.', plannerRepo: root, workflowsRepo: root, environmentFile: path.join(root, 'env'), seedRevision: 'seed', workflowsRevision: 'source', benchmarks: [{ name: 'primary', role: 'primary', zipPath: path.join(root, 'p.zip') }, { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'h.zip') }] });
    const campaign = database.createCampaign(config, 'a'.repeat(40), 'b'.repeat(40), `sha256:${'c'.repeat(64)}`, 'https://example.invalid/workflows.git');
    const variant = database.updateVariant(database.createVariant({ id: 'failed-report-v000', campaignId: campaign.id, parentVariantId: null, round: 0, ordinal: 0, hypothesis: { title: 'Failed baseline', rationale: 'Measure.', instructions: 'No edits.', expectedImpact: 'Baseline.', risk: 'Infrastructure.', findingIds: [] } }).id, { status: 'failed', error: 'Image build failed.' });
    const report = await readFile(await writeVariantReport(paths, campaign, variant, []), 'utf8');
    assert.match(report, /## Conclusion\s+Status: `failed`/);
    assert.match(report, /\| Standard \| failed \(no final facts\) \|/);
    assert.doesNotMatch(report, /Status: `pending`|\| Standard \| pending \|/);
    assert.match(report, /\| Verified errors \| unavailable \|/);
    assert.match(report, /Image build failed/);
    database.createTargetExcludedEvaluation(campaign.id, variant.id);
    const excluded = database.updateTargetExcludedEvaluation(variant.id, { status: 'failed', error: 'Excluded run failed before producing facts.' });
    const failedGuardReport = await readFile(await writeVariantReport(paths, campaign, variant, [], excluded), 'utf8');
    assert.match(failedGuardReport, /Gate: `not evaluated`/);
    assert.match(failedGuardReport, /Pair validity: unavailable/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    let variant = database.updateVariant(created.id, {
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
      hypothesisComplianceStatus: 'passed',
      hypothesisCompliancePatchHash: `sha256:${'1'.repeat(64)}`,
      hypothesisComplianceCandidatePatchHash: `sha256:${'4'.repeat(64)}`,
      hypothesisComplianceResultHash: `sha256:${'2'.repeat(64)}`,
      hypothesisCompliance: {
        kind: 'ainative-planner-eval/hypothesis-compliance',
        schemaVersion: 2,
        interpretationStatus: 'unverified_model_judgment',
        variantId: created.id,
        patchSha256: `sha256:${'1'.repeat(64)}`,
        mutationContextSha256: `sha256:${'3'.repeat(64)}`,
        status: 'passed',
        summary: 'The patch and regression test align with the stated intervention.',
        intervention: {
          status: 'satisfied',
          rationale: 'Runtime code changes the cited mechanism.',
          evidence: ['server/src/policy.ts:12'],
        },
        codeRegression: {
          status: 'satisfied',
          rationale: 'The deterministic boundary has positive and negative coverage.',
          evidence: ['server/test/policy.test.ts:40'],
        },
        falsificationTest: {
          status: 'satisfied',
          rationale: 'The test covers the positive and negative cases.',
          evidence: ['server/test/policy.test.ts:40'],
        },
        limitations: ['This is an unverified model judgment.'],
      },
      hypothesisComplianceError: null,
    });
    const passedCompliance = variant.hypothesisCompliance;
    if (!passedCompliance || passedCompliance.schemaVersion !== 2) {
      throw new Error('fixture requires compliance V2');
    }
    const failedCompliance = {
      ...passedCompliance,
      status: 'failed' as const,
      patchSha256: `sha256:${'5'.repeat(64)}`,
      intervention: {
        ...variant.hypothesisCompliance!.intervention,
        status: 'not_satisfied' as const,
      },
    };
    database.appendHypothesisComplianceAttempt(variant.id, {
      variantId: variant.id,
      attempt: 1,
      phase: 'initial',
      outcome: 'semantic_failed',
      treatmentPatchSha256: failedCompliance.patchSha256,
      candidatePatchSha256: `sha256:${'6'.repeat(64)}`,
      mutationContextSha256: failedCompliance.mutationContextSha256,
      resultSha256: `sha256:${'7'.repeat(64)}`,
      result: failedCompliance,
      error: null,
      startedAt: '2026-09-07T10:00:00.000Z',
      completedAt: '2026-09-07T10:01:00.000Z',
    });
    database.appendHypothesisComplianceAttempt(variant.id, {
      variantId: variant.id,
      attempt: 2,
      phase: 'repair',
      outcome: 'passed',
      treatmentPatchSha256: variant.hypothesisCompliancePatchHash,
      candidatePatchSha256: variant.hypothesisComplianceCandidatePatchHash,
      mutationContextSha256: passedCompliance.mutationContextSha256,
      resultSha256: variant.hypothesisComplianceResultHash,
      result: passedCompliance,
      error: null,
      startedAt: '2026-09-07T10:02:00.000Z',
      completedAt: '2026-09-07T10:03:00.000Z',
    });
    variant = database.getVariant(variant.id);
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
    assert.match(report, /## Hypothesis Compliance Preflight/);
    assert.match(report, /unverified model judgment/i);
    assert.match(report, /Runtime code changes the cited mechanism/);
    assert.match(report, /### Code Regression/);
    assert.match(report, /### Attempt History/);
    assert.match(report, /\| 1 \| initial \| semantic_failed \|/);
    assert.match(report, /\| 2 \| repair \| passed \|/);
    assert.match(report, /Cumulative candidate patch hash: `sha256:4444/);
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
    const frozenResearchContent = '# Campaign research\n\nHistorical context, not current evidence.\n';
    const frozenResearchDirectory = path.join(root, 'frozen-research');
    const frozenResearchPath = path.join(frozenResearchDirectory, '001-campaign-research.md');
    await mkdir(frozenResearchDirectory, { recursive: true });
    await writeFile(frozenResearchPath, frozenResearchContent);
    await writeFile(
      path.join(frozenResearchDirectory, 'manifest.json'),
      `${JSON.stringify({
        kind: 'ainative-planner-eval/frozen-research-manifest',
        schemaVersion: 1,
        materials: [
          {
            name: 'campaign-research.md',
            path: '001-campaign-research.md',
            sha256: `sha256:${createHash('sha256').update(frozenResearchContent).digest('hex')}`,
            bytes: Buffer.byteLength(frozenResearchContent),
          },
        ],
      })}\n`,
    );
    const campaignWithResearch = {
      ...campaign,
      currentParentVariantId: variant.id,
      config: {
        ...campaign.config,
        researchPaths: [frozenResearchPath],
        researchSha256: [
          `sha256:${createHash('sha256').update(frozenResearchContent).digest('hex')}`,
        ],
      },
    };
    const sibling = {
      ...variant,
      id: 'report-diagnosis-v999',
      hypothesis: {
        ...variant.hypothesis,
        findingSnapshots: [
          {
            ...variant.diagnosis!.findings[0]!,
            id: 'finding-sibling-snapshot',
          },
        ],
      },
      diagnosis: {
        ...variant.diagnosis!,
        summary: 'Sibling semantic summary must stay hidden.',
        findings: [
          {
            ...variant.diagnosis!.findings[0]!,
            id: 'finding-sibling-secret',
          },
        ],
      },
    };
    await writeAgentHistory(
      historyPath,
      paths.reports,
      campaignWithResearch,
      [variant, sibling],
      [label],
    );
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as Record<string, unknown>;
    const serialized = JSON.stringify(history);
    assert.match(serialized, /"benchmark":"primary-pack"/);
    assert.match(serialized, /"currentParent":\{"id":"report-diagnosis-v000"/);
    assert.match(serialized, /"allowedFindingIds":\["finding-hydration"\]/);
    assert.doesNotMatch(serialized, /finding-sibling-secret/);
    assert.doesNotMatch(serialized, /finding-sibling-snapshot/);
    assert.doesNotMatch(serialized, /Sibling semantic summary/);
    assert.match(serialized, /"interpretationStatus":"unverified_model_judgment"/);
    assert.match(serialized, /"unverified":true/);
    assert.match(serialized, /"holdouts":\{"holdout-pack"/);
    assert.match(serialized, /"supportingEvidenceRefs"/);
    assert.match(serialized, /"counterEvidenceRefs"/);
    assert.match(serialized, /"falsificationTest"/);
    assert.match(serialized, /"hypothesisCompliance":\{"status":"passed"/);
    assert.match(serialized, /"patchSha256":"sha256:1111/);
    assert.match(serialized, /"candidatePatchSha256":"sha256:4444/);
    assert.match(serialized, /"attempts":\[\{"variantId":"report-diagnosis-v000"/);
    const index = await readFile(
      await writeCampaignIndex(paths, campaignWithResearch, [variant]),
      'utf8',
    );
    assert.match(index, /## Compliance Throughput/);
    assert.match(index, /\| First-pass compliant \| 0 \|/);
    assert.match(index, /\| Compliant after bounded repair \| 1 \|/);
    assert.match(index, /\| Executed generated variants \| 0 \|/);
    assert.match(serialized, /"name":"V13c experiment axes"/);
    assert.match(serialized, /"comparability":"historical_context_only"/);
    assert.match(serialized, /No results claimed/);
    assert.match(serialized, /"researchContext":\{"authority":"historical_context_only"/);
    assert.match(serialized, /Historical context, not current evidence/);
    assert.doesNotMatch(serialized, /This must not enter strategist history/);

    const manifestPath = path.join(paths.reports, 'history', 'manifest.json');
    const outsideManifest = path.join(root, 'outside-manifest.json');
    await writeFile(outsideManifest, await readFile(manifestPath, 'utf8'));
    await rm(manifestPath);
    await symlink(outsideManifest, manifestPath);
    await assert.rejects(
      writeAgentHistory(historyPath, paths.reports, campaignWithResearch, [variant, sibling], [label]),
      /historical research manifest must be a contained regular file/,
    );

    const outsideHistory = path.join(root, 'outside-history');
    await rm(path.join(paths.reports, 'history'), { recursive: true });
    await mkdir(outsideHistory);
    await symlink(outsideHistory, path.join(paths.reports, 'history'));
    await assert.rejects(
      writeAgentHistory(historyPath, paths.reports, campaignWithResearch, [variant, sibling], [label]),
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

test('reports count PM-simulation answers and preserve their unverified provenance in history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-pm-simulation-'));
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
      id: 'report-pm-simulation',
      goal: 'Keep synthetic PM answers distinct from human-verified planning authority.',
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
    const baseResolution = {
      derivationVersion: 2 as const,
      originalArtifactSha: `sha256:${'d'.repeat(64)}`,
      resolvedArtifactSha: `sha256:${'e'.repeat(64)}`,
      blockingQuestions: 1,
      requirementsAgentRequests: 0,
      requirementsAgentAnswers: 0,
      sourceFallbackAnswers: 0,
      reusedAnswers: 0,
      plannerQuestions: 0,
      plannerRequirementsAgentRequests: 0,
      plannerRequirementsAgentAnswers: 0,
      plannerSourceFallbackAnswers: 0,
      plannerReusedAnswers: 0,
    };
    const pmEntry = {
      id: 'question-pm-simulation',
      question: 'Which behavior should this requirement assume?',
      resolution: 'pm_simulation' as const,
      answer: 'Assume the user confirms the proposed behavior.',
      evidence: ['Synthetic PM simulation; not human-reviewed.'],
    };
    const variant = database.updateVariant(
      database.createVariant({
        id: 'report-pm-simulation-v000',
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
      }).id,
      {
        status: 'review',
        facts: runFacts,
        replicateFacts: [runFacts],
        artifactCollectionComplete: true,
        questionResolutions: {
          'primary-pack': {
            ...baseResolution,
            benchmark: 'primary-pack',
            pmSimulationAnswers: 1,
            entries: [pmEntry],
          },
          'holdout-pack': {
            ...baseResolution,
            benchmark: 'holdout-pack',
            entries: [],
          },
        },
      },
    );

    const report = await readFile(
      await writeVariantReport(paths, campaign, variant, []),
      'utf8',
    );
    assert.match(report, /### primary-pack[\s\S]*\| PM-simulation answers \| 1 \|/);
    assert.match(report, /### holdout-pack[\s\S]*\| PM-simulation answers \| 0 \|/);
    assert.match(report, /Resolution: `pm_simulation`/);
    assert.match(report, /Authority: `unverified_pm_simulation`/);
    assert.match(report, /not human-verified authority/);

    const historyPath = path.join(paths.campaigns, 'pm-simulation-history.json');
    await writeAgentHistory(historyPath, paths.reports, campaign, [variant], []);
    const history = JSON.parse(await readFile(historyPath, 'utf8')) as {
      variants: Array<{ questionResolutions: Record<string, unknown> }>;
    };
    const questionResolutions = history.variants[0]!.questionResolutions;
    assert.match(JSON.stringify(questionResolutions), /"resolution":"pm_simulation"/);
    assert.match(JSON.stringify(questionResolutions), /"pmSimulationAnswers":1/);
    assert.doesNotMatch(JSON.stringify(questionResolutions), /human_verified/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('target protocol reports and history distinguish dedicated control from standard-primary reuse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-reports-target-protocol-'));
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
    const createProtocolFixture = (
      protocol: 'dedicated-control-v1' | 'standard-primary-v2',
    ) => {
      const suffix = protocol === 'standard-primary-v2' ? 'v2' : 'v1';
      const config = CampaignConfigSchema.parse({
        id: `report-target-${suffix}`,
        goal: 'Keep target-excluded promotion evidence protocol-aware and non-duplicative.',
        plannerRepo: root,
        workflowsRepo: root,
        environmentFile: path.join(root, 'environment.env'),
        seedRevision: 'seed',
        workflowsRevision: 'workflows',
        evaluation:
          protocol === 'standard-primary-v2'
            ? { replicates: 2, replicateConcurrency: 2 }
            : { replicates: 3, replicateConcurrency: 2 },
        ...(protocol === 'standard-primary-v2'
          ? {
              targetExcluded: {
                protocol,
                targetImplementationWorkflow: 'generic/target',
              },
            }
          : {}),
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
      const variant = database.updateVariant(
        database.createVariant({
          id: `${campaign.id}-v000`,
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
        }).id,
        {
          status: 'review',
          facts: runFacts,
          replicateFacts:
            protocol === 'standard-primary-v2'
              ? [runFacts, runFacts]
              : [runFacts, runFacts, runFacts],
          artifactCollectionComplete: true,
        },
      );
      database.createTargetExcludedEvaluation(campaign.id, variant.id);
      const normalArmBinding: TargetNormalArmBinding | null =
        protocol === 'standard-primary-v2'
          ? {
              source: 'standard_primary',
              benchmark: 'primary-pack',
              resolvedArtifactSha: `sha256:${'d'.repeat(64)}`,
              replicates: [
                { replicate: 1, caseId: 'standard-case-1', runId: 'standard-run-1' },
                { replicate: 2, caseId: 'standard-case-2', runId: 'standard-run-2' },
              ],
            }
          : null;
      const score = {
        cohortMismatches: [],
        verified: { labeled: 1, correct: 1, errors: 0, accuracy: 1 },
        provisional: { labeled: 0, correct: 0, errors: 0, accuracy: null },
        decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
      };
      const gate = {
        status: 'passed' as const,
        baselineMeanBuildRate: 1,
        candidateMeanBuildRate: 1,
        buildDropRatio: 0,
        reasons: [],
      };
      const targetExcluded = database.updateTargetExcludedEvaluation(variant.id, {
        status: 'completed',
        controlFacts: protocol === 'dedicated-control-v1' ? runFacts : null,
        controlReplicateFacts:
          protocol === 'dedicated-control-v1' ? [runFacts, runFacts] : null,
        excludedFacts: runFacts,
        excludedReplicateFacts: [runFacts, runFacts],
        normalArmBinding,
        score,
        gate,
        comparisons: [
          {
            replicate: 1,
            normalCaseId: protocol === 'standard-primary-v2' ? `${suffix}-normal-case-1` : null,
            excludedCaseId:
              protocol === 'standard-primary-v2' ? `${suffix}-excluded-case-1` : null,
            normalRunId: protocol === 'standard-primary-v2' ? `${suffix}-normal-run-1` : null,
            excludedRunId:
              protocol === 'standard-primary-v2' ? `${suffix}-excluded-run-1` : null,
            valid: true,
            mismatches: [],
            leakagePaths: [],
            reportHash: `sha256:${'e'.repeat(64)}`,
          },
        ],
        artifactCollectionComplete: true,
      });
      return { campaign, variant, targetExcluded, normalArmBinding, score, gate };
    };

    const v1 = createProtocolFixture('dedicated-control-v1');
    const v2 = createProtocolFixture('standard-primary-v2');
    const v1Report = await readFile(
      await writeVariantReport(paths, v1.campaign, v1.variant, [], v1.targetExcluded),
      'utf8',
    );
    const v2Report = await readFile(
      await writeVariantReport(paths, v2.campaign, v2.variant, [], v2.targetExcluded),
      'utf8',
    );

    assert.match(v1Report, /\| Standard \| measured \|/);
    assert.match(v1Report, /\| Target-safe control \| measured \|/);
    assert.match(v1Report, /\| Target-excluded \| measured \|/);
    assert.match(v1Report, /Control decisions: build=1/);
    assert.match(v1Report, /The control and excluded arms use the same target-safe pack/);
    assert.match(
      v1Report,
      /Comparison lineage: replicate 1: normal case `unavailable` run `unavailable`, excluded case `unavailable` run `unavailable`/,
    );
    assert.doesNotMatch(v1Report, /undefined/);

    assert.match(
      v2Report,
      /\| Standard primary \(comparison control\) \| reference \(standard measurement\) \|/,
    );
    assert.match(v2Report, /\| Target-excluded \| measured \|/);
    assert.doesNotMatch(v2Report, /\| Target-safe control \|/);
    assert.doesNotMatch(v2Report, /Control decisions:/);
    assert.match(v2Report, /No additional control execution was run/);
    assert.match(v2Report, /Standard primary \(comparison control\) reference:/);
    assert.match(v2Report, new RegExp(v2.normalArmBinding!.resolvedArtifactSha));
    assert.match(v2Report, /v2-normal-case-1/);
    assert.match(v2Report, /v2-excluded-case-1/);
    assert.match(v2Report, /v2-normal-run-1/);
    assert.match(v2Report, /v2-excluded-run-1/);

    const v1HistoryPath = path.join(paths.campaigns, 'history-v1.json');
    const v2HistoryPath = path.join(paths.campaigns, 'history-v2.json');
    await writeAgentHistory(
      v1HistoryPath,
      paths.reports,
      v1.campaign,
      [v1.variant],
      [],
      [v1.targetExcluded],
    );
    await writeAgentHistory(
      v2HistoryPath,
      paths.reports,
      v2.campaign,
      [v2.variant],
      [],
      [v2.targetExcluded],
    );
    const v1History = JSON.parse(await readFile(v1HistoryPath, 'utf8')) as {
      variants: Array<{ targetExcluded: Record<string, unknown> }>;
    };
    const v2History = JSON.parse(await readFile(v2HistoryPath, 'utf8')) as {
      variants: Array<{ targetExcluded: Record<string, unknown> }>;
    };
    const v1Target = v1History.variants[0]!.targetExcluded;
    const v2Target = v2History.variants[0]!.targetExcluded;
    assert.deepEqual(v1Target.controlDecisions, runFacts.decisions);
    assert.equal(Object.hasOwn(v1Target, 'protocol'), false);
    assert.equal(Object.hasOwn(v2Target, 'controlDecisions'), false);
    assert.equal(v2Target.protocol, 'standard-primary-v2');
    assert.deepEqual(v2Target.normalArmBinding, v2.normalArmBinding);
    assert.deepEqual(v1Target.comparisons, v1.targetExcluded.comparisons);
    assert.deepEqual(v1Target.comparisons, [
      {
        replicate: 1,
        normalCaseId: null,
        excludedCaseId: null,
        normalRunId: null,
        excludedRunId: null,
        valid: true,
        mismatches: [],
        leakagePaths: [],
        reportHash: `sha256:${'e'.repeat(64)}`,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(v1Target), /undefined/);
    assert.deepEqual(v2Target.comparisons, v2.targetExcluded.comparisons);
    assert.deepEqual(v2Target.score, v2.score);
    assert.deepEqual(v2Target.gate, v2.gate);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
