import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCohort,
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
