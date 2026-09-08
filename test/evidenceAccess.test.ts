import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { evidenceScopeFromContext, prepareEvidenceInvocation, loadEvidenceInvocation, evidenceHelperEnvironment, readEvidenceLedger } from '../src/evidenceAccess.js';

import { digest, evidenceFixture, measuredFacts } from './evidenceFixtures.js';

test('scope authority is canonical, same-campaign, and explicit about excluded sources', async (t) => {
  const f = await evidenceFixture(t);
  const excluded = path.join(f.current, 'target-excluded/excluded');
  await f.put(path.join(excluded, 'primary/replicate-1/facts.json'), measuredFacts);
  let scope = evidenceScopeFromContext(f.campaign, f.variant, f.worktree, f.current, f.context);
  assert.equal(scope.artifactRoot, path.dirname(path.dirname(scope.currentArtifactDirectory)));
  assert.equal(scope.allowedObservations?.find((item) => item.arm === 'excluded')?.sourceRoot, undefined);
  const filtered = path.join(path.dirname(f.worktree), 'target-excluded-workflows');
  await mkdir(filtered);
  scope = evidenceScopeFromContext(f.campaign, f.variant, f.worktree, f.current, f.context);
  assert.equal(path.basename(scope.allowedObservations!.find((item) => item.arm === 'excluded')!.sourceRoot!), 'target-excluded-workflows');
  assert.throws(() => evidenceScopeFromContext({ id: 'campaign-b' }, f.variant, f.worktree, f.current, f.context), /campaign/i);
  assert.throws(() => evidenceScopeFromContext(f.campaign, f.variant, f.worktree, f.current, { artifacts: { ...f.context.artifacts, workflowsSource: f.worktree } }), /frozen|source|scope/i);
  const escape = path.join(f.data, 'artifacts', 'campaign-b', 'other');
  await mkdir(escape, { recursive: true });
  await symlink(escape, path.join(path.dirname(f.current), 'linked'));
  assert.throws(() => evidenceScopeFromContext(f.campaign, f.variant, f.worktree, f.current, {
    artifacts: { ...f.context.artifacts, priorExperiments: [{ id: 'linked', directory: path.join(path.dirname(f.current), 'linked') }] },
  }), /scope|campaign|symlink/i);
});

test('per-turn manifests bind runtime sources and HTTP policy; helper env excludes keys', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 3);
  const bytes = await readFile(prepared.manifestPath);
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.turn, 3);
  assert.equal(manifest.scope.campaignId, f.campaign.id);
  assert.ok(manifest.allowedHttpHosts.includes('nodejs.org'));
  assert.ok(Object.keys(manifest.runtimeSourceHashes).includes('evidence.ts'));
  assert.match(prepared.manifestPath, /turn-003/);
  await loadEvidenceInvocation(prepared.manifestPath, digest(bytes));
  await loadEvidenceInvocation(prepared.manifestPath, `sha256:${digest(bytes)}`);
  await assert.rejects(loadEvidenceInvocation(prepared.manifestPath, '0'.repeat(64)), /hash|sha256/i);
  const second = await prepareEvidenceInvocation(f.scope, 3);
  assert.notEqual(second.manifestPath, prepared.manifestPath);
  assert.deepEqual(await readFile(prepared.manifestPath), bytes);
  const env = evidenceHelperEnvironment({ PATH: '/bin', HOME: '/home/test', DOCKER_CONTEXT: 'desktop-linux', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require evil', HARNESS_RESEARCH_HTTP_HOSTS: 'localhost' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HARNESS_RESEARCH_HTTP_HOSTS, undefined);
  assert.equal(env.DOCKER_CONTEXT, 'desktop-linux');
});

test('audit receipts contain exact requests and responses with hashes, ledger only returns bounded summaries', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const access = await loadEvidenceInvocation(prepared.manifestPath, digest(await readFile(prepared.manifestPath)));
  const response = await access.callTool('list_observations', { kind: 'observation' });
  assert.equal(response.isError, undefined);
  await access.callTool('read_evidence', { evidenceRef: '/etc/passwd' });
  await access.callTool('research_shell', { observationRef: 'snapshot_' + '0'.repeat(64), command: 'true' });
  const ledger = await readEvidenceLedger(f.scope, { limit: 2 });
  assert.equal(ledger.items.length, 2);
  assert.ok(ledger.nextCursor);
  assert.deepEqual(Object.keys(ledger.items[0]!).sort(), ['id', 'tool', 'scope', 'createdAt', 'bytes', 'status', 'requestRef', 'responseRef'].sort());
  const next = await readEvidenceLedger(f.scope, { limit: 2, cursor: ledger.nextCursor! });
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);
  const calls = await readdir(path.join(prepared.auditDirectory, 'calls'));
  for (const id of calls) {
    const directory = path.join(prepared.auditDirectory, 'calls', id);
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.manifestSha256, digest(await readFile(prepared.manifestPath)));
    assert.equal(receipt.requestSha256, digest(await readFile(path.join(directory, 'request.json'))));
    assert.equal(receipt.responseSha256, digest(await readFile(path.join(directory, 'response.json'))));
    const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
    if (request.name === 'list_observations') {
      assert.deepEqual(request.arguments, { kind: 'observation' });
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'response.json'), 'utf8')), response);
    }
  }
  const other = await evidenceFixture(t, 'campaign-b');
  await assert.rejects(readEvidenceLedger(other.scope, { cursor: ledger.nextCursor! }), /cursor/i);
});

test('audit publication never indexes its own requests, receipts, or sandbox input copies as planner evidence', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const before = await prepared.store.listObservations({});
  const access = await loadEvidenceInvocation(prepared.manifestPath, digest(await readFile(prepared.manifestPath)));
  await access.callTool('list_observations', {});
  const after = await prepared.store.listObservations({});
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(after).includes('evidence-access'), false);
});

test('coordinator HTTP policy is captured once and rejects nonpublic host lists before publication', async (t) => {
  const f = await evidenceFixture(t);
  const previous = process.env.HARNESS_RESEARCH_HTTP_HOSTS;
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_RESEARCH_HTTP_HOSTS; else process.env.HARNESS_RESEARCH_HTTP_HOSTS = previous; });
  process.env.HARNESS_RESEARCH_HTTP_HOSTS = 'docs.python.org, docs.rs';
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const bytes = await readFile(prepared.manifestPath);
  const manifest = JSON.parse(bytes.toString());
  assert.ok(manifest.allowedHttpHosts.includes('docs.python.org'));
  assert.ok(manifest.allowedHttpHosts.includes('docs.rs'));
  for (const hosts of ['localhost', '127.0.0.1', '*.example.com', 'https://example.com', 'example.com,']) {
    process.env.HARNESS_RESEARCH_HTTP_HOSTS = hosts;
    await assert.rejects(prepareEvidenceInvocation(f.scope, 2), /hostnames/i);
  }
  await loadEvidenceInvocation(prepared.manifestPath, digest(bytes));
});

test('manifest, runtime pin and audit symlink tampering fail closed', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const original = await readFile(prepared.manifestPath);
  const access = await loadEvidenceInvocation(prepared.manifestPath, digest(original));
  const manifest = JSON.parse(original.toString());
  manifest.runtimeSourceHashes['evidence.ts'] = '0'.repeat(64);
  await chmod(prepared.manifestPath, 0o600);
  await writeFile(prepared.manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadEvidenceInvocation(prepared.manifestPath, digest(await readFile(prepared.manifestPath))), /runtime source hash mismatch/);
  assert.equal((await access.callTool('list_observations', {})).isError, true);
  await writeFile(prepared.manifestPath, original);
  const linked = path.join(f.root, 'linked-manifest');
  await symlink(prepared.manifestPath, linked);
  await assert.rejects(loadEvidenceInvocation(linked, digest(original)), /symlink/i);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await rm(path.join(prepared.auditDirectory, 'calls'), { recursive: true });
  await symlink(outside, path.join(prepared.auditDirectory, 'calls'));
  await assert.rejects(access.callTool('list_observations', {}), /symlink/i);
  assert.deepEqual(await readdir(outside), []);
});

test('ledger pagination is byte-bounded and does not read archived response bodies', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const access = await loadEvidenceInvocation(prepared.manifestPath, digest(await readFile(prepared.manifestPath)));
  await access.callTool('list_observations', {});
  const first = (await readEvidenceLedger(f.scope)).items[0]!;
  await rm(path.join(f.scope.currentArtifactDirectory, first.responseRef));
  assert.deepEqual((await readEvidenceLedger(f.scope)).items[0], first);
  await assert.rejects(readEvidenceLedger(f.scope, { cursor: 'not-a-cursor' }), /cursor/i);
  await assert.rejects(readEvidenceLedger(f.scope, { limit: -1 }));
  const index = path.join(prepared.auditDirectory, 'index', `${first.id}.json`);
  await chmod(index, 0o600);
  await writeFile(index, JSON.stringify({ ...first, scope: { ...first.scope, campaignId: 'campaign-b' } }));
  await assert.rejects(readEvidenceLedger(f.scope), /scope/i);
});

test('reference bytes remain bound even when modified before the helper first reads its catalog', async (t) => {
  const f = await evidenceFixture(t);
  await f.put(f.scope.referencePath, { labels: [] });
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const access = await loadEvidenceInvocation(prepared.manifestPath, digest(await readFile(prepared.manifestPath)));
  await f.put(f.scope.referencePath, { labels: [], changed: true });
  const response = await access.callTool('list_observations', {});
  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response), /reference hash changed/);
});
