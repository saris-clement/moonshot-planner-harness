import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardDefaults } from '../src/server.js';

test('dashboard defaults honor explicit repository and revision overrides', () => {
  assert.deepEqual(
    dashboardDefaults('/tmp/harness', {
      HARNESS_PLANNER_REPO: '/workspace/planner',
      HARNESS_WORKFLOWS_REPO: '/workspace/workflows',
      HARNESS_PLANNER_ENV_FILE: '/workspace/planner/eval.env',
      HARNESS_DEFAULT_PLANNER_REVISION: 'planner-sha',
      HARNESS_DEFAULT_WORKFLOWS_REVISION: 'workflows-sha',
    }),
    {
      plannerRepo: '/workspace/planner',
      workflowsRepo: '/workspace/workflows',
      environmentFile: '/workspace/planner/eval.env',
      seedRevision: 'planner-sha',
      workflowsRevision: 'workflows-sha',
    },
  );
});
