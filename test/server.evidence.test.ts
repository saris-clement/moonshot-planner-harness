import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { executionSnapshotFromRun, mergeExecutionSnapshot } from '../src/executionState.js';
import { startDashboard } from '../src/server.js';
import { harnessPaths } from '../src/paths.js';
import { CampaignConfigSchema } from '../src/types.js';
import type { CampaignOrchestrator } from '../src/orchestrator.js';
import { digest, evidenceFixture, measuredFacts } from './evidenceFixtures.js';

test('dashboard evidence and diagnostics use known variant scopes, preserve legacy DB rows, and expose only read tools', async (t) => {
  const f = await evidenceFixture(t);
  const database = new HarnessDatabase(path.join(f.data, 'harness.sqlite'));
  t.after(() => database.close());
  const config = CampaignConfigSchema.parse({ id: f.campaign.id, goal: 'Test read-only evidence integration',
    plannerRepo: f.worktree, workflowsRepo: f.source, environmentFile: '/unused.env', seedRevision: 'seed', workflowsRevision: 'workflows',
    benchmarks: [{ name: 'primary', role: 'primary', zipPath: '/unused.zip' }, { name: 'holdout', role: 'holdout', zipPath: '/holdout.zip' }] });
  database.createCampaign(config, 'seed', 'workflows', 'environment', 'remote');
  database.createCampaign({ ...config, id: 'campaign-b' }, 'seed', 'workflows', 'environment', 'remote');
  const hypothesis = { title: 'Test', rationale: 'Test', instructions: 'No mutation', expectedImpact: 'None', risk: 'None' };
  const parent = database.createVariant({ id: 'parent-a', campaignId: f.campaign.id, parentVariantId: null, round: 0, ordinal: 0, hypothesis });
  database.createVariant({ id: 'variant-a', campaignId: f.campaign.id, parentVariantId: parent.id, round: 1, ordinal: 1, hypothesis });
  database.createVariant({ id: 'foreign', campaignId: 'campaign-b', parentVariantId: null, round: 0, ordinal: 0, hypothesis });
  const before = JSON.stringify(database.listVariants(f.campaign.id));
  const archive = path.join(f.current, 'primary/replicate-1/facts.json');
  const archiveHash = digest(await readFile(archive));
  await f.put(path.join(f.current, 'target-excluded/excluded/primary/replicate-1/facts.json'), measuredFacts);
  await f.put(path.join(f.current, 'target-excluded/control/primary/replicate-1/facts.json'), measuredFacts);
  const paths = harnessPaths(f.root);
  const server = startDashboard({ port: 0, publicDirectory: path.resolve('public'), database, orchestrator: { paths } as CampaignOrchestrator });
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}/api/campaigns/${f.campaign.id}/variants/variant-a`;
  const evidence = (tool: string, query = {}, endpoint = root) => fetch(`${endpoint}/evidence?${new URLSearchParams({ tool, query: JSON.stringify(query) })}`);
  const listing = await evidence('list_observations', { kind: 'observation', limit: 100 });
  assert.equal(listing.status, 200);
  const observations = await listing.json() as { items: Array<Record<string, string>> };
  assert.deepEqual([...new Set(observations.items.map((row) => row.arm))].sort(), ['control', 'excluded', 'standard']);
  const observation = observations.items.find((row) => row.role === 'final' && row.arm === 'standard')!;
  const comparison = await evidence('compare_trial', { snapshotRef: observation.snapshotRef });
  assert.equal(comparison.status, 200);
  const compared = await comparison.json() as { items: Array<Record<string, string>> };
  assert.equal((await evidence('inspect_unit', { unitRef: compared.items[0]!.unitRef })).status, 200);
  const source = await (await evidence('search_source', { query: 'needle' })).json() as { items: Array<Record<string, string>> };
  assert.equal((await evidence('read_evidence', { evidenceRef: source.items[0]!.evidenceRef })).status, 200);
  const baselineRoot = root.replace('/variants/variant-a', '/variants/parent-a');
  const baseline = await evidence('list_observations', { kind: 'observation' }, baselineRoot);
  assert.equal(baseline.status, 200, 'baseline without investigator-reference.json remains readable');
  assert.equal((await evidence('compare_trial', { snapshotRef: observation.snapshotRef }, baselineRoot)).status, 400);
  assert.equal((await evidence('list_observations', {}, root.replace('variant-a', 'foreign'))).status, 400);
  assert.equal((await evidence('list_observations', { artifactRoot: f.data })).status, 400);
  assert.equal((await evidence('read_evidence', { evidenceRef: '/etc/passwd' })).status, 400);
  assert.equal((await evidence('research_shell', { command: 'touch /tmp/not-allowed' })).status, 400);
  assert.equal((await fetch(`${root}/evidence?tool=list_observations&path=/etc/passwd`)).status, 400);
  const diagnostics = await fetch(`${root}/diagnostics`);
  assert.equal(diagnostics.status, 200);
  assert.equal((await diagnostics.json() as { status: string }).status, 'unknown');
  assert.equal((await fetch(`${root.replace('variant-a', 'foreign')}/diagnostics`)).status, 400);
  const ledger = await fetch(`${root}/evidence-reads?limit=2`);
  assert.equal(ledger.status, 200);
  const page = await ledger.json() as { items: Array<Record<string, unknown>>; nextCursor: string };
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  assert.deepEqual(Object.keys(page.items[0]!).sort(), ['id', 'tool', 'scope', 'createdAt', 'bytes', 'status', 'requestRef', 'responseRef'].sort());
  assert.equal((await fetch(`${baselineRoot}/evidence-reads?cursor=${encodeURIComponent(page.nextCursor)}`)).status, 400);
  assert.equal((await fetch(`${root}/evidence-reads?limit=1000`)).status, 400);
  assert.equal((await fetch(`${root}/evidence-reads?path=/etc/passwd`)).status, 400);
  assert.equal(JSON.stringify(database.listVariants(f.campaign.id)), before);
  assert.equal(digest(await readFile(archive)), archiveHash);
  const failedRun = { run: { id: 'run-failed', caseId: 'case-failed', status: 'failed' }, runtime: {
    status: 'failed', failureCode: 'model_boundary_violation_candidate_outside_shortlist', failureMessage: 'SECRET raw model message',
  } };
  const { failure: _failure, ...legacy } = executionSnapshotFromRun(failedRun, { questions: [] });
  database.updateVariant(f.variant.id, { executionState: mergeExecutionSnapshot(null, {
    benchmark: 'primary', role: 'primary', replicate: 1, replicateCount: 2, snapshot: legacy,
  }) });
  await f.put(path.join(f.current, 'primary/replicate-1/analysis-run-latest.json'), failedRun);
  const beforeDiagnostics = JSON.stringify(database.getVariant(f.variant.id));
  const failed = await fetch(`${root}/diagnostics`);
  assert.equal(failed.status, 200);
  const projection = await failed.json() as { status: string; failures: Array<{ failure: { code: string; provenance: { source: string } } }> };
  assert.equal(projection.status, 'blocked');
  assert.equal(projection.failures[0]!.failure.code, failedRun.runtime.failureCode);
  assert.equal(projection.failures[0]!.failure.provenance.source, 'archive');
  assert.equal(JSON.stringify(projection).includes('SECRET'), false);
  assert.equal(JSON.stringify(database.getVariant(f.variant.id)), beforeDiagnostics);
  // Archived facts remain readable after optional worktrees have been cleaned up.
  await rm(f.worktree, { recursive: true });
  await rm(f.source, { recursive: true });
  assert.equal((await evidence('list_observations', { kind: 'observation' }, baselineRoot)).status, 200);
});

for (const initiallyAbsent of [true, false]) test(`dashboard reference cache ${initiallyAbsent ? 'refreshes only when a previously absent reference appears' : 'never refreshes an existing pinned reference'}`, async (t) => {
  const f = await evidenceFixture(t);
  const database = new HarnessDatabase(path.join(f.data, 'harness.sqlite'));
  t.after(() => database.close());
  const config = CampaignConfigSchema.parse({ id: f.campaign.id, goal: 'Test reference initialization after an early dashboard read',
    plannerRepo: f.worktree, workflowsRepo: f.source, environmentFile: '/unused.env', seedRevision: 'seed', workflowsRevision: 'workflows',
    benchmarks: [{ name: 'primary', role: 'primary', zipPath: '/unused.zip' }, { name: 'holdout', role: 'holdout', zipPath: '/holdout.zip' }] });
  database.createCampaign(config, 'seed', 'workflows', 'environment', 'remote');
  const hypothesis = { title: 'Test', rationale: 'Test', instructions: 'No mutation', expectedImpact: 'None', risk: 'None' };
  database.createVariant({ id: 'parent-a', campaignId: f.campaign.id, parentVariantId: null, round: 0, ordinal: 0, hypothesis });
  database.createVariant({ ...f.variant, round: 1, ordinal: 1, hypothesis });
  const labels = [{ campaignId: f.campaign.id, benchmark: 'primary', unitKey: 'unit-one', expectedDecision: 'reuse', status: 'suggested' }];
  const reference = { labels, labelSetHash: digest(JSON.stringify(labels)), baseline: { id: 'parent-a', facts: measuredFacts, replicateFacts: [measuredFacts] } };
  if (!initiallyAbsent) await f.put(f.scope.referencePath, reference);
  const server = startDashboard({ port: 0, publicDirectory: path.resolve('public'), database, orchestrator: { paths: harnessPaths(f.root) } as CampaignOrchestrator });
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/campaigns/${f.campaign.id}/variants/${f.variant.id}/evidence?tool=list_observations`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 200);
  const invocations = path.join(f.current, 'evidence-access/turn-000/.data');
  const initial = await readdir(invocations);
  assert.equal(initial.length, 1, 'unchanged reads reuse their invocation');
  const manifestPath = path.join(invocations, initial[0]!, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  assert.equal(JSON.parse(manifestBytes.toString()).referenceSha256, initiallyAbsent ? null : digest(JSON.stringify(reference)));
  if (initiallyAbsent) {
    await f.put(f.scope.referencePath, reference);
    const refreshed = await Promise.all([fetch(url), fetch(url)]);
    for (const response of refreshed) {
      assert.equal(response.status, 200, 'reference initialization must not poison the cached UI reader');
      assert.ok((await response.json() as { baselineSnapshotRef: string | null }).baselineSnapshotRef);
    }
    const updated = await readdir(invocations);
    assert.equal(updated.length, 2, 'concurrent reads share exactly one replacement invocation');
    assert.deepEqual(await readFile(manifestPath), manifestBytes, 'the unpinned invocation stays immutable');
    const replacement = updated.find((id) => id !== initial[0])!;
    assert.equal(JSON.parse(await readFile(path.join(invocations, replacement, 'manifest.json'), 'utf8')).referenceSha256, digest(JSON.stringify(reference)));
  }
  await f.put(f.scope.referencePath, { ...reference, labelSetHash: 'tampered' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url);
    assert.equal(response.status, 400, 'reload must not repin changed reference bytes');
    assert.match((await response.json() as { error: string }).error, /Evidence reference hash changed/);
  }
  await rm(f.scope.referencePath);
  assert.equal((await fetch(url)).status, 400, 'deleting a pinned reference must not reset the cache');
  await f.put(f.scope.referencePath, { ...reference, labelSetHash: 'tampered' });
  assert.equal((await fetch(url)).status, 400, 'recreating a deleted pinned reference must not reset the cache');
  assert.equal((await readdir(invocations)).length, initiallyAbsent ? 2 : 1);
});
