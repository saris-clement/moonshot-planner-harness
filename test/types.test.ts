import assert from 'node:assert/strict';
import test from 'node:test';
import { CampaignConfigSchema } from '../src/types.js';

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
