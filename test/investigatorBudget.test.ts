import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveInvestigatorLimits, type InvestigatorTokenGrant } from '../src/investigatorBudget.js';
import type { InvestigationState } from '../src/investigator.js';
import { CampaignConfigSchema } from '../src/types.js';

const base = CampaignConfigSchema.shape.investigator.unwrap().parse({ enabled: true, primaryReplicates: 2 });
const grant: InvestigatorTokenGrant = { id: 'operator-4m', grantedAt: new Date().toISOString(),
  additionalTokens: 4_000_000, tokensAtGrant: 4_092_956, previousLimit: 2_000_000,
  effectiveLimit: 8_092_956, reason: 'Explicit operator authorization' };
const state = (tokenGrants: InvestigatorTokenGrant[]) => ({ tokenGrants }) as InvestigationState;

test('effective investigator limits preserve frozen policy and provide the full grant after overshoot', () => {
  const frozen = structuredClone(base);
  assert.deepEqual(effectiveInvestigatorLimits(base, null), base);
  assert.deepEqual(effectiveInvestigatorLimits(base, state([])), base);
  assert.deepEqual(effectiveInvestigatorLimits(base, state([grant])), { ...base, maxAgentTokens: 8_092_956 });
  const next = { ...grant, id: 'second', tokensAtGrant: 8_500_000, previousLimit: grant.effectiveLimit,
    additionalTokens: 100, effectiveLimit: 8_500_100 };
  assert.equal(effectiveInvestigatorLimits(base, state([grant, next])).maxAgentTokens, 8_500_100);
  assert.deepEqual(base, frozen);
});

test('invalid persisted grants fail closed instead of silently changing the effective cap', () => {
  for (const changes of [
    { additionalTokens: 0 }, { additionalTokens: -1 }, { additionalTokens: 1.5 },
    { additionalTokens: Infinity }, { additionalTokens: NaN }, { additionalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { tokensAtGrant: 0 }, { tokensAtGrant: 1_999_999 }, { tokensAtGrant: Infinity },
    { previousLimit: 2_000_001 }, { effectiveLimit: 6_000_000 }, { effectiveLimit: Number.MAX_SAFE_INTEGER + 1 },
    { id: '' }, { id: '../escape' }, { reason: '  ' }, { grantedAt: 'invalid' },
  ]) assert.throws(() => effectiveInvestigatorLimits(base, state([{ ...grant, ...changes }])), /grant/i);
  assert.throws(() => effectiveInvestigatorLimits(base, state([grant, grant])), /grant/i);
  assert.throws(() => effectiveInvestigatorLimits(base, state([grant, { ...grant, id: 'second' }])), /grant/i);
  assert.throws(() => effectiveInvestigatorLimits(base, state(null as unknown as InvestigatorTokenGrant[])), /grant/i);
});
