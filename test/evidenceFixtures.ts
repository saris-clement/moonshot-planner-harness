import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type test from 'node:test';
import { evidenceScopeFromContext } from '../src/evidenceAccess.js';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const measuredFacts = {
  status: 'completed', sampleSize: 1, decisionAgreement: 1, unitCount: 1,
  decisions: { reuse: 1, build: 0, extend: 0, defer: 0, question: 0 },
  shortlist: { empty: 0, nonempty: 1, candidates: 1 }, evidence: { discovered: 1, selectedSourceRefs: 1 },
  usage: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0, durationMs: 1 }, pins: {},
  units: [{ id: 'one', key: 'unit-one', ref: { entity: 'requirement', anchor: 'one' }, kind: 'behavior', semantics: 'a capability',
    decision: 'reuse', confidence: 'high', rationale: 'unverified interpretation', selectedCandidateIds: ['candidate'],
    discoveredEvidenceCount: 1, shortlistCandidateCount: 1, uncoveredSemantics: [], sourceRefs: [{ path: 'selected.ts' }] }],
};

export async function evidenceFixture(t: test.TestContext, campaignId = 'campaign-a') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evidence-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, '.data');
  const current = path.join(data, 'artifacts', campaignId, 'variant-a');
  const parent = path.join(data, 'artifacts', campaignId, 'parent-a');
  const worktree = path.join(data, 'worktrees', campaignId, 'variant-a');
  const source = path.join(path.dirname(worktree), 'frozen-workflows');
  const put = async (filename: string, value: unknown) => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put(path.join(current, 'primary/replicate-1/facts.json'), measuredFacts);
  await put(path.join(parent, 'primary/replicate-1/facts.json'), measuredFacts);
  await put(path.join(source, 'selected.ts'), 'export const needle = true;');
  await put(path.join(worktree, 'planner.ts'), 'export const planner = true;');
  const campaign = { id: campaignId };
  const variant = { id: 'variant-a', campaignId, parentVariantId: 'parent-a' };
  const context = { artifacts: { current, parent, workflowsSource: source, priorExperiments: [{ id: 'parent-a', directory: parent }] } };
  const scope = evidenceScopeFromContext(campaign, variant, worktree, current, context);
  return { root, data, current, parent, source, worktree, campaign, variant, context, scope, put };
}
