import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCohort,
  compareScores,
  computeReplicateMeanScore,
  computeTargetExcludedGate,
  computeScore,
  consensusRunFacts,
  extractRunFacts,
} from '../src/metrics.js';
import type { JudgeOutput, LabelRecord } from '../src/types.js';

const analysis = {
  analysis: {
    requirementUnits: [
      { id: 'unit-a', ref: { entity: 'workflow', anchor: 'a' }, kind: 'field', semantics: 'Capture A' },
      { id: 'unit-b', ref: { entity: 'workflow', anchor: 'b' }, kind: 'check', semantics: 'Check B' },
    ],
    adjudications: [
      {
        requirementUnitId: 'unit-a',
        result: 'build',
        confidence: 'high',
        rationale: 'No candidate',
        selectedCandidateIds: [],
        sourceRefs: [],
        discoveredEvidence: [],
        uncoveredSemantics: ['Capture A'],
        shortlist: { requirementUnitId: 'unit-a', candidates: [] },
      },
      {
        requirementUnitId: 'unit-b',
        result: 'extend',
        confidence: 'medium',
        rationale: 'Partial candidate',
        selectedCandidateIds: ['capability-b'],
        sourceRefs: [{ capabilityId: 'capability-b', path: 'src/shared/b.ts' }],
        discoveredEvidence: [{ id: 'discovered.abc' }],
        uncoveredSemantics: [],
        shortlist: { requirementUnitId: 'unit-b', candidates: [{ capabilityId: 'capability-b' }] },
      },
    ],
  },
};

const run = {
  kind: 'ainative-planner/analysis-run',
  status: 'completed',
  pins: { source: 'sha', model: 'gpt' },
  aggregateUsage: {
    calls: 2,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    costUsd: 0.5,
    durationMs: 1_000,
  },
};

function referenceLabel(
  unitKey: string,
  expectedDecision: LabelRecord['expectedDecision'],
  status: LabelRecord['status'] = 'verified',
): LabelRecord {
  return {
    campaignId: 'campaign',
    benchmark: 'primary',
    unitKey,
    expectedDecision,
    classification: 'system_error',
    rationale: 'Fixed reference expectation',
    status,
    updatedAt: '2026-09-07T00:00:00.000Z',
  };
}

test('extractRunFacts preserves unit-level evidence and measured totals', () => {
  const facts = extractRunFacts(analysis, run);
  assert.equal(facts.unitCount, 2);
  assert.deepEqual(facts.decisions, { build: 1, reuse: 0, extend: 1, defer: 0, question: 0 });
  assert.deepEqual(facts.shortlist, { empty: 1, nonempty: 1, candidates: 1 });
  assert.deepEqual(facts.evidence, { discovered: 1, selectedSourceRefs: 1 });
  assert.equal(facts.units[1]?.sourceRefs[0]?.path, 'src/shared/b.ts');
  assert.equal(facts.usage.totalTokens, 120);
});

test('verified labels outrank persisted suggestions and current judge output', () => {
  const facts = extractRunFacts(analysis, run);
  const labels: LabelRecord[] = [
    {
      campaignId: 'campaign',
      benchmark: 'primary',
      unitKey: 'unit-a',
      expectedDecision: 'reuse',
      classification: 'system_error',
      rationale: 'Implemented already',
      status: 'verified',
      updatedAt: new Date().toISOString(),
    },
    {
      campaignId: 'campaign',
      benchmark: 'primary',
      unitKey: 'unit-b',
      expectedDecision: 'extend',
      classification: 'real_gap',
      rationale: 'Partial behavior',
      status: 'suggested',
      updatedAt: new Date().toISOString(),
    },
  ];
  const judgment: JudgeOutput = {
    summary: 'Current judge disagrees with the frozen suggestion.',
    verdicts: [
      {
        unitKey: 'unit-a',
        expectedDecision: 'build',
        classification: 'real_gap',
        confidence: 'high',
        rationale: 'ignored',
        evidence: ['fixture evidence'],
      },
      {
        unitKey: 'unit-b',
        expectedDecision: 'build',
        classification: 'real_gap',
        confidence: 'high',
        rationale: 'ignored in favor of persisted suggestion',
        evidence: ['fixture evidence'],
      },
    ],
  };
  const score = computeScore(facts, labels, judgment);
  assert.deepEqual(score.verified, { labeled: 1, correct: 0, errors: 1, accuracy: 0 });
  assert.deepEqual(score.provisional, { labeled: 1, correct: 1, errors: 0, accuracy: 1 });
});

test('cohort comparison detects pin and unit drift', () => {
  const reference = extractRunFacts(analysis, run);
  assert.deepEqual(compareCohort(reference, structuredClone(reference)), []);
  const changed = structuredClone(reference);
  changed.pins = { source: 'other' };
  changed.units[0]!.key = 'different-unit';
  assert.deepEqual(compareCohort(reference, changed), ['analysis pins', 'requirement units']);
  const semanticDrift = structuredClone(reference);
  semanticDrift.units[0]!.semantics = 'Different meaning with the same planner ID';
  assert.deepEqual(compareCohort(reference, semanticDrift), ['requirement units']);
  const firstQuestionSet = structuredClone(reference);
  firstQuestionSet.pins = { inputSetHash: 'same', decisionSetVersion: 1, decisionSetHash: 'a' };
  const secondQuestionSet = structuredClone(reference);
  secondQuestionSet.pins = { inputSetHash: 'same', decisionSetVersion: 7, decisionSetHash: 'b' };
  assert.deepEqual(compareCohort(firstQuestionSet, secondQuestionSet), []);
});

test('consensus uses majority decisions and retains replicate cost', () => {
  const first = extractRunFacts(analysis, run);
  const second = structuredClone(first);
  const third = structuredClone(first);
  second.units[0]!.decision = 'reuse';
  second.units[0]!.sourceRefs = [{ capabilityId: 'capability-a', path: 'src/shared/a.ts' }];
  second.decisions = { build: 0, reuse: 1, extend: 1, defer: 0, question: 0 };
  third.units[0]!.decision = 'reuse';
  third.units[0]!.sourceRefs = [{ capabilityId: 'capability-a', path: 'src/shared/a.ts' }];
  third.decisions = { build: 0, reuse: 1, extend: 1, defer: 0, question: 0 };
  const consensus = consensusRunFacts([first, second, third]);
  assert.equal(consensus.sampleSize, 3);
  assert.equal(consensus.units[0]?.decision, 'reuse');
  assert.equal(consensus.decisions.reuse, 1);
  assert.equal(consensus.decisionAgreement, 0.5);
  assert.equal(consensus.usage.totalTokens, 360);
});

test('replicate mean avoids pessimistic and optimistic two-replica consensus tie bias', () => {
  const first = extractRunFacts(analysis, run);
  const second = structuredClone(first);
  second.units[0]!.decision = 'reuse';
  second.units[0]!.sourceRefs = [{ path: 'src/shared/a.ts' }];
  second.decisions = { build: 0, reuse: 1, extend: 1, defer: 0, question: 0 };
  const runs = [first, second];
  const before = structuredClone(runs);
  const labels = [referenceLabel('unit-a', 'reuse')];
  const consensus = consensusRunFacts(runs);
  assert.equal(computeScore(consensus, labels, null).verified.accuracy, 0);
  const mean = computeReplicateMeanScore(runs, labels, null);
  assert.deepEqual(mean.verified, { labeled: 1, correct: 0.5, errors: 0.5, accuracy: 0.5 });
  assert.deepEqual(mean.decisionErrors, { build: 0.5, reuse: 0, extend: 0, defer: 0, question: 0 });
  assert.deepEqual(mean, computeReplicateMeanScore([second, first], labels, null));
  const threeReplicates = computeReplicateMeanScore([first, second, second], labels, null);
  assert.deepEqual(threeReplicates.verified, {
    labeled: 1, correct: 2 / 3, errors: 1 / 3, accuracy: 2 / 3,
  });
  assert.equal(threeReplicates.decisionErrors.build, 1 / 3);

  const buildLabels = [referenceLabel('unit-a', 'build')];
  assert.equal(computeScore(consensus, buildLabels, null).verified.accuracy, 1);
  assert.equal(computeReplicateMeanScore(runs, buildLabels, null).verified.accuracy, 0.5);
  assert.deepEqual(runs, before);
});

test('replicate mean uses a fixed label denominator instead of averaging shrinking labeled sets', () => {
  const complete = extractRunFacts(analysis, run);
  const incomplete = structuredClone(complete);
  incomplete.units.pop();
  incomplete.unitCount = 1;
  incomplete.decisions.extend = 0;

  for (const status of ['verified', 'suggested'] as const) {
    const labels = [referenceLabel('unit-a', 'build', status), referenceLabel('unit-b', 'reuse', status)];
    const category = status === 'verified' ? 'verified' : 'provisional';
    const naiveMean = (
      computeScore(complete, labels, null)[category].accuracy! +
      computeScore(incomplete, labels, null)[category].accuracy!
    ) / 2;
    assert.equal(naiveMean, 0.75);
    const mean = computeReplicateMeanScore([complete, incomplete], labels, null);
    assert.deepEqual(mean[category], { labeled: 2, correct: 1, errors: 1, accuracy: 0.5 });
    assert.deepEqual(mean.cohortMismatches, ['requirement units']);
    // Missing units count as errors, but do not invent a measured planner decision.
    assert.deepEqual(mean.decisionErrors, { build: 0, reuse: 0, extend: 0.5, defer: 0, question: 0 });
    assert.deepEqual(mean, computeReplicateMeanScore([incomplete, complete], labels, null));
  }
});

test('replicate mean retains labels absent from every run and includes completely missing labeled sets', () => {
  const complete = extractRunFacts(analysis, run);
  const empty = structuredClone(complete);
  empty.units = [];
  empty.unitCount = 0;
  empty.decisions = { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 };
  const labels = [referenceLabel('unit-a', 'build'), referenceLabel('unit-b', 'extend')];
  const mean = computeReplicateMeanScore([complete, empty], labels, null);
  assert.deepEqual(mean.verified, { labeled: 2, correct: 1, errors: 1, accuracy: 0.5 });
  assert.deepEqual(mean.cohortMismatches, ['requirement units']);
  assert.deepEqual(computeReplicateMeanScore([empty, empty], labels, null).verified, {
    labeled: 2, correct: 0, errors: 2, accuracy: 0,
  });
  assert.deepEqual(
    computeReplicateMeanScore([complete, complete], [referenceLabel('missing', 'reuse')], null).verified,
    { labeled: 1, correct: 0, errors: 1, accuracy: 0 },
  );
});

test('replicate mean preserves verified, persisted suggestion, then judge precedence', () => {
  const first = extractRunFacts(analysis, run);
  const second = structuredClone(first);
  second.units[0]!.decision = 'reuse';
  second.units[1]!.decision = 'build';
  const labels = [
    referenceLabel('unit-a', 'build', 'suggested'),
    referenceLabel('unit-a', 'reuse'),
    referenceLabel('unit-b', 'extend', 'suggested'),
  ];
  const judgment: JudgeOutput = {
    summary: 'Unverified judge suggestions must not override reference labels.',
    verdicts: ['unit-a', 'unit-b'].map((unitKey) => ({
      unitKey,
      expectedDecision: 'build',
      classification: 'real_gap',
      confidence: 'high',
      rationale: 'Judge suggestion',
      evidence: ['fixture evidence'],
    })),
  };
  const before = structuredClone({ labels, judgment });
  const mean = computeReplicateMeanScore([first, second], labels, judgment);
  assert.deepEqual(mean.verified, { labeled: 1, correct: 0.5, errors: 0.5, accuracy: 0.5 });
  assert.deepEqual(mean.provisional, { labeled: 1, correct: 0.5, errors: 0.5, accuracy: 0.5 });
  assert.deepEqual(mean.decisionErrors, { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 });
  assert.deepEqual({ labels, judgment }, before);

  const judgeOnly = computeReplicateMeanScore([first, second], [], judgment);
  assert.deepEqual(judgeOnly.verified, { labeled: 0, correct: 0, errors: 0, accuracy: null });
  assert.deepEqual(judgeOnly.provisional, { labeled: 2, correct: 1, errors: 1, accuracy: 0.5 });
  const missingVerdict = structuredClone(judgment);
  missingVerdict.verdicts[1]!.unitKey = 'missing';
  assert.deepEqual(computeReplicateMeanScore([first, second], [], missingVerdict).provisional, {
    labeled: 2, correct: 0.5, errors: 1.5, accuracy: 0.25,
  });
});

test('replicate mean returns null accuracy without labels and rejects an empty replicate collection', () => {
  const facts = extractRunFacts(analysis, run);
  for (const judgment of [null, { summary: 'No suggestions', verdicts: [] }]) {
    assert.deepEqual(computeReplicateMeanScore([facts, facts], [], judgment), {
      cohortMismatches: [],
      verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
      provisional: { labeled: 0, correct: 0, errors: 0, accuracy: null },
      decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 },
    });
  }
  assert.throws(() => computeReplicateMeanScore([], [], null), /without replicate facts/);
});

test('replicate mean attaches deduplicated pin and semantic mismatches across all runs', () => {
  const first = extractRunFacts(analysis, run);
  const second = structuredClone(first);
  second.pins = { source: 'other' };
  const third = structuredClone(second);
  third.units[0]!.semantics = 'Different meaning';
  assert.deepEqual(computeReplicateMeanScore([first, second, third], [], null).cohortMismatches, [
    'analysis pins', 'requirement units',
  ]);

  first.pins = { inputSetHash: 'same', decisionSetVersion: 1, decisionSetHash: 'a' };
  second.pins = { inputSetHash: 'same', decisionSetVersion: 7, decisionSetHash: 'b' };
  second.units.reverse();
  assert.deepEqual(computeReplicateMeanScore([first, second], [], null).cohortMismatches, []);
});

test('replicate mean matches single-run scoring for a complete labeled cohort', () => {
  const facts = extractRunFacts(analysis, run);
  const labels = [referenceLabel('unit-a', 'reuse'), referenceLabel('unit-b', 'extend', 'suggested')];
  assert.deepEqual(computeReplicateMeanScore([facts], labels, null), computeScore(facts, labels, null));
});

test('score comparison still prioritizes verified mean accuracy over provisional accuracy', () => {
  const first = extractRunFacts(analysis, run);
  const second = structuredClone(first);
  second.units[0]!.decision = 'reuse';
  second.units[1]!.decision = 'build';
  const labels = [referenceLabel('unit-a', 'reuse'), referenceLabel('unit-b', 'extend', 'suggested')];
  const betterVerified = computeReplicateMeanScore([first, second], labels, null);
  const betterProvisional = computeReplicateMeanScore([first, first], labels, null);
  assert.ok(compareScores(betterVerified, betterProvisional) < 0);
  assert.ok(compareScores(betterProvisional, betterVerified) > 0);
  assert.equal(compareScores(betterVerified, betterVerified), 0);
});

test('target-excluded gate compares mean raw build rates without rewarding increases', () => {
  const facts = extractRunFacts(analysis, run);
  const baseline = [structuredClone(facts), structuredClone(facts)];
  baseline[0]!.decisions.build = 100;
  baseline[0]!.unitCount = 125;
  baseline[1]!.decisions.build = 100;
  baseline[1]!.unitCount = 125;

  const warning = baseline.map((value) => structuredClone(value));
  warning[0]!.decisions.build = 92;
  warning[1]!.decisions.build = 92;
  assert.equal(computeTargetExcludedGate(baseline, warning, true, false).status, 'warning');

  const blocked = baseline.map((value) => structuredClone(value));
  blocked[0]!.decisions.build = 85;
  blocked[1]!.decisions.build = 85;
  assert.equal(computeTargetExcludedGate(baseline, blocked, true, false).status, 'blocked');

  const increase = baseline.map((value) => structuredClone(value));
  increase[0]!.decisions.build = 110;
  increase[1]!.decisions.build = 110;
  assert.equal(computeTargetExcludedGate(baseline, increase, true, false).status, 'passed');
  assert.equal(computeTargetExcludedGate(baseline, increase, false, false).status, 'blocked');
  assert.equal(computeTargetExcludedGate(baseline, increase, true, true).status, 'blocked');
});
