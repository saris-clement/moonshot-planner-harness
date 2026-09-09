import assert from 'node:assert/strict';
import test from 'node:test';
import { runEvidenceSmoke } from '../scripts/evidence-smoke.js';

test('paid evidence smoke requires explicit --live and is disabled in ordinary checks', async () => {
  assert.equal(await runEvidenceSmoke([]), 2);
  assert.equal(await runEvidenceSmoke(['--model', 'openai/gpt-5.6-sol']), 2);
  assert.equal(await runEvidenceSmoke(['--help']), 0);
});
