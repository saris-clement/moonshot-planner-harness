import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvestigatorBriefing } from '../src/investigatorBriefing.js';
import type { InvestigationState } from '../src/investigator.js';

const state = (): InvestigationState => ({
  schemaVersion: 1, sessionId: null, status: 'running', startedAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:10Z', turnCount: 25, agentTokens: null, agentCostUsd: null, reason: null,
  actions: Array.from({ length: 25 }, (_, index) => ({
    id: `action-${String(index + 1).padStart(3, '0')}`, kind: 'evaluate_primary', status: 'completed',
    rationale: 'R'.repeat(100_000), startedAt: '2026-09-08T00:00:00Z', completedAt: null,
    patchHash: `sha256:${'a'.repeat(64)}`, artifactDirectory: `investigation/action-${String(index + 1).padStart(3, '0')}`,
    result: { facts: { units: ['DO NOT DUPLICATE'.repeat(20_000)] }, replicateFacts: ['HUGE'.repeat(100_000)],
      score: { provisional: { accuracy: 0.8, labeled: 30, correct: 24, errors: 6 } }, passed: true }, error: null,
  })),
});

test('initial briefing preserves a historical 4k goal, compact latest 20 headers, and actual byte accounting', () => {
  const current = state();
  const context = { goal: 'objective '.repeat(400), baseline: { score: { provisional: { accuracy: 0.5 } }, decisions: { reuse: 15, build: 15 } }, budget: { maxTurns: 30, maxAgentTokens: 200_000 }, referenceHandles: { context: 'ev_context', state: 'ev_state', feedback: 'ev_feedback' } };
  const before = JSON.stringify(current);
  const briefing = buildInvestigatorBriefing(context, current, current.actions.at(-1));
  assert.equal(briefing.mode, 'initial');
  assert.equal(briefing.objective, context.goal);
  assert.equal(briefing.recentActions.length, 20);
  assert.equal(briefing.recentActions[0]!.id, 'action-006');
  assert.equal(briefing.byteLength, Buffer.byteLength(JSON.stringify(briefing)));
  assert.ok(briefing.byteLength <= 16_384);
  assert.equal(JSON.stringify(briefing).includes('DO NOT DUPLICATE'), false);
  assert.equal(JSON.stringify(briefing).includes('replicateFacts'), false);
  assert.equal(JSON.stringify(current), before);
  assert.equal(briefing.budget.agentTokens, null);
});

test('delta and oversized fields use explicit handles rather than slicing text or IDs', () => {
  const current = state();
  current.sessionId = 'session-1';
  current.reason = 'failure '.repeat(10_000);
  current.actions.at(-1)!.id = 'long-id-'.repeat(3_000);
  const briefing = buildInvestigatorBriefing({ goal: '\u00e9'.repeat(100_000), currentHypothesis: { title: 'large'.repeat(40_000) }, referenceHandles: { context: 'ev_context', state: 'ev_state', feedback: 'ev_feedback' } }, current, { error: current.reason, result: current.actions.at(-1)!.result });
  assert.equal(briefing.mode, 'delta');
  assert.ok(briefing.byteLength <= 8_192);
  assert.equal(briefing.byteLength, Buffer.byteLength(JSON.stringify(briefing)));
  assert.ok(briefing.omissions.length > 0);
  for (const omission of briefing.omissions) assert.ok(omission.handle);
  assert.equal(JSON.stringify(briefing).includes('long-id-long-id-'), false);
  assert.equal(JSON.stringify(briefing).includes('HUGE'), false);
});

test('pathological headers and missing registered handles still produce a complete bounded delta', () => {
  const current = state();
  current.sessionId = 'session-1';
  for (const [index, action] of current.actions.entries()) {
    action.id = `${index}-${'very-long-id'.repeat(500)}`;
    action.patchHash = 'patch'.repeat(1_000);
  }
  const briefing = buildInvestigatorBriefing({ goal: 'goal'.repeat(100_000) }, current, null);
  assert.ok(briefing.byteLength <= 8_192);
  assert.equal(briefing.byteLength, Buffer.byteLength(JSON.stringify(briefing)));
  assert.ok(briefing.omissions.some((item) => item.handleAvailability === 'not_registered'));
});

test('initial briefing accepts bounded coordinator comparison samples without rationales or invented handles', () => {
  const current = state();
  const samples = Array.from({ length: 10 }, (_, index) => ({
    unitRef: `unit_${String(index).padStart(64, '0')}`, unitKey: `unit-${index}`,
    baselineAgreement: 0.5, trialAgreement: index % 2 ? 0 : 1, changed: true, labelStatus: 'suggested',
    rationale: 'DO NOT INCLUDE RAW RATIONALE'.repeat(1_000),
  }));
  const initial = buildInvestigatorBriefing({ unitSamples: samples, referenceHandles: { context: `evidence_${'c'.repeat(64)}` } }, current, null);
  assert.equal((initial.unitSamples as unknown[]).length, 6);
  assert.equal(JSON.stringify(initial).includes('DO NOT INCLUDE'), false);
  assert.ok(initial.omissions.some((item) => item.field === 'unitSamples'));
  assert.equal(initial.byteLength, Buffer.byteLength(JSON.stringify(initial)));
  current.sessionId = 'session-1';
  assert.equal(buildInvestigatorBriefing({ unitSamples: samples }, current, null).unitSamples, undefined);
  assert.deepEqual(buildInvestigatorBriefing({ unitSamples: [{ unitRef: '/arbitrary/path' }] }, state(), null).unitSamples, []);
  const sparse = buildInvestigatorBriefing({ unitSamples: [{ unitRef: samples[0]!.unitRef, trialAgreement: NaN, labelStatus: 'verified' }] }, state(), null);
  assert.deepEqual(sparse.unitSamples, [{ unitRef: samples[0]!.unitRef, unitKey: null, baselineAgreement: null, trialAgreement: null, changed: null, labelStatus: 'verified' }]);
});
