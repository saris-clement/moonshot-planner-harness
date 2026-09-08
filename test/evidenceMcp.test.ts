import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { evidenceHelperEnvironment, evidenceToolSchemas, prepareEvidenceInvocation, readEvidenceLedger } from '../src/evidenceAccess.js';
import { digest, evidenceFixture, measuredFacts } from './evidenceFixtures.js';

function payload(result: CallToolResult): Record<string, any> {
  const text = result.content[0];
  assert.equal(text?.type, 'text');
  return JSON.parse((text as { text: string }).text);
}

test('SDK stdio handshake exposes exactly eight tools, scopes references, bounds JSON, and audits rejected calls', async (t) => {
  const f = await evidenceFixture(t);
  await f.put(path.join(f.current, 'mutation.patch'), '\\"\n'.repeat(30_000));
  const prepared = await prepareEvidenceInvocation(f.scope, 2);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
    fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url)), '--manifest', prepared.manifestPath, '--sha256', digest(await readFile(prepared.manifestPath))],
    env: evidenceHelperEnvironment(), stderr: 'pipe' });
  const client = new Client({ name: 'harness-integration-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'harness_evidence');
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), Object.keys(evidenceToolSchemas).sort());
  assert.equal(tools.tools.find((tool) => tool.name === 'research_shell')!.inputSchema.additionalProperties, false);
  let count = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    count++;
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: count, result })) <= 65_536);
    return result;
  };
  const listed = payload(await call('list_observations', { kind: 'observation' }));
  const observation = listed.items.find((row: any) => row.role === 'final');
  assert.ok(observation.snapshotRef);
  const compared = payload(await call('compare_trial', { snapshotRef: observation.snapshotRef }));
  assert.ok(compared.items[0].unitRef);
  assert.equal((await call('inspect_unit', { unitRef: compared.items[0].unitRef })).isError, undefined);
  const searched = payload(await call('search_source', { query: 'needle' }));
  assert.ok(searched.items[0].evidenceRef);
  assert.match(JSON.stringify(payload(await call('read_evidence', { evidenceRef: searched.items[0].evidenceRef }))), /needle/);
  const patch = payload(await call('list_observations', { kind: 'evidence', evidenceKind: 'patch' })).items[0];
  const large = await call('read_evidence', { evidenceRef: patch.evidenceRef, limit: 65_536, maxBytes: 65_536 });
  assert.equal(large.isError, undefined);
  assert.ok(payload(large).nextOffset > 0);
  const other = await evidenceFixture(t, 'campaign-b');
  const foreign = (await (await prepareEvidenceInvocation(other.scope, 1)).store.listObservations({ kind: 'observation' })).items[0]!;
  for (const [name, args] of [
    ['compare_trial', { snapshotRef: foreign.snapshotRef }],
    ['research_shell', { observationRef: foreign.snapshotRef, command: 'true' }],
    ['list_observations', { campaignId: 'campaign-b' }],
    ['read_evidence', { evidenceRef: '/etc/passwd' }],
    ['research_output', { observationRef: observation.snapshotRef, invocationId: 'research-00000000-0000-0000-0000-000000000000', stream: 'stdout' }],
    ['research_http', { observationRef: observation.snapshotRef, url: 'http://127.0.0.1:4173/api/campaigns' }],
    ['unknown_tool', {}],
  ] as Array<[string, Record<string, unknown>]>) assert.equal((await call(name, args)).isError, true, name);
  const ledger = await readEvidenceLedger(f.scope, { limit: 100 });
  assert.equal(ledger.items.length, count);
  assert.equal(ledger.items.filter((item) => item.status === 'error').length, 7);
  await client.close();
});

test('stdio rejects an unbound manifest before advertising any tools', async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
    fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url)), '--manifest', prepared.manifestPath, '--sha256', '0'.repeat(64)],
    env: evidenceHelperEnvironment(), stderr: 'pipe' });
  const client = new Client({ name: 'invalid-manifest-test', version: '1' });
  t.after(() => client.close());
  await assert.rejects(client.connect(transport), /closed|SHA256|connection/i);
});

test('real MCP research runs only in Docker, publishes exact arm bundles, paginates output and handles timeout', {
  skip: process.env.RESEARCH_DOCKER_SMOKE !== '1', timeout: 180_000,
}, async (t) => {
  const f = await evidenceFixture(t);
  await f.put(path.join(f.current, 'target-excluded/excluded/primary/replicate-1/facts.json'), measuredFacts);
  await f.put(path.join(path.dirname(f.worktree), 'target-excluded-workflows/filtered.ts'), 'FILTERED_ONLY');
  await f.put(path.join(f.source, 'normal.ts'), 'NORMAL_ONLY');
  await f.put(path.join(f.worktree, '.env'), 'OPENAI_API_KEY=must-not-leak');
  const { evidenceScopeFromContext } = await import('../src/evidenceAccess.js');
  const scope = evidenceScopeFromContext(f.campaign, f.variant, f.worktree, f.current, f.context);
  const prepared = await prepareEvidenceInvocation(scope, 4);
  const client = new Client({ name: 'real-research-integration', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
    fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url)), '--manifest', prepared.manifestPath, '--sha256', digest(await readFile(prepared.manifestPath))],
    env: { ...evidenceHelperEnvironment(), OPENAI_API_KEY: 'must-not-leak' }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as CallToolResult;
    assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result })) <= 65_536);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return payload(result);
  };
  const observations = (await call('list_observations', { kind: 'observation' })).items;
  const excluded = observations.find((item: any) => item.arm === 'excluded');
  const standard = observations.find((item: any) => item.arm === 'standard' && item.role === 'final');
  const result = await call('research_shell', { observationRef: excluded.snapshotRef, command: [
    'set -eu', 'test ! -f /candidate/.env', 'test -z "${OPENAI_API_KEY:-}"', 'test ! -e /var/run/docker.sock',
    'test "$(jq -r .observation.arm /artifacts/data.json)" = excluded',
    'test "$(ls /artifacts)" = data.json', 'rg FILTERED_ONLY /sources',
    'if rg NORMAL_ONLY /sources; then exit 99; fi',
    'node -e \'process.stdout.write("abc\\\\\\\"\\n".repeat(6000))\'',
  ].join('\n') });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.snapshotSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.truncated, true);
  let content = result.stdout;
  let offset: number | null = result.pagination.find((page: any) => page.stream === 'stdout').nextOffset;
  while (offset !== null) {
    const page = await call('research_output', { observationRef: excluded.snapshotRef, invocationId: result.invocationId, stream: 'stdout', offset });
    content += page.content;
    offset = page.nextOffset;
  }
  assert.equal(content, await readFile(path.join(scope.currentArtifactDirectory, result.artifacts.stdout), 'utf8'));
  const denied = await client.callTool({ name: 'research_output', arguments: { observationRef: standard.snapshotRef, invocationId: result.invocationId, stream: 'stdout' } }) as CallToolResult;
  assert.equal(denied.isError, true);
  const timed = await call('research_shell', { observationRef: standard.snapshotRef, command: 'sleep 30', timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  const docs = await call('research_http', { observationRef: standard.snapshotRef, url: 'https://nodejs.org/api/fs.html', method: 'HEAD' });
  assert.equal(docs.exitCode, 0, docs.stderr);
  assert.match(docs.stdout, /HTTP\/1.1 200/);
  const concurrent = await Promise.all(['one', 'two'].map((value) => call('research_shell', {
    observationRef: standard.snapshotRef, command: `printf ${value} > /scratch/shared-name; sleep 0.1; cat /scratch/shared-name`,
  })));
  assert.deepEqual(concurrent.map((item) => item.stdout), ['one', 'two']);
  assert.notEqual(concurrent[0]!.artifacts.stdout, concurrent[1]!.artifacts.stdout);
  assert.equal(concurrent[0]!.snapshotSha256, concurrent[1]!.snapshotSha256);
  const bundles = await readdir(path.join(prepared.auditDirectory, 'bundles'));
  for (const bundle of bundles) {
    const bytes = await readFile(path.join(prepared.auditDirectory, 'bundles', bundle, 'data.json'));
    assert.equal(digest(bytes), bundle);
    assert.deepEqual(await readdir(path.join(prepared.auditDirectory, 'bundles', bundle)), ['data.json']);
    assert.equal(bytes.includes('must-not-leak'), false);
  }
});

test('real MCP research cancellation and stdin EOF clean children and persist completed audit receipts', {
  skip: process.env.RESEARCH_DOCKER_SMOKE !== '1', timeout: 180_000,
}, async (t) => {
  const exec = promisify(execFile);
  for (const stop of ['cancel', 'eof'] as const) {
    const f = await evidenceFixture(t);
    const prepared = await prepareEvidenceInvocation(f.scope, 1);
    const client = new Client({ name: `research-${stop}-test`, version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
      fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url)), '--manifest', prepared.manifestPath, '--sha256', `sha256:${digest(await readFile(prepared.manifestPath))}`],
      env: evidenceHelperEnvironment(), stderr: 'pipe' });
    t.after(() => client.close());
    await client.connect(transport);
    const observations = payload(await client.callTool({ name: 'list_observations', arguments: { kind: 'observation' } }) as CallToolResult);
    const observationRef = observations.items[0].snapshotRef;
    const controller = new AbortController();
    const pending = client.callTool({ name: 'research_shell', arguments: { observationRef, command: 'sleep 120' } }, undefined,
      { timeout: 150_000, signal: controller.signal }).catch((error: unknown) => error);
    let invocation = '';
    let running = false;
    for (let attempt = 0; attempt < 150 && !running; attempt++) {
      for (const call of await readdir(path.join(prepared.auditDirectory, 'scratch'))) {
        const names = await readdir(path.join(prepared.auditDirectory, 'scratch', call));
        invocation = names.find((name) => name.startsWith('research-')) ?? '';
      }
      if (invocation) running = (await exec('docker', ['inspect', '--format={{.State.Running}}', `${invocation}-worker`]).catch(() => ({ stdout: '' }))).stdout.trim() === 'true';
      if (!running) await delay(100);
    }
    assert.equal(running, true, 'the test must cancel a running container, not merely skip dispatch');
    if (stop === 'cancel') controller.abort();
    else await client.close();
    await pending;
    let receipt;
    for (let attempt = 0; attempt < 150; attempt++) {
      receipt = (await readEvidenceLedger(f.scope)).items.find((item) => item.tool === 'research_shell');
      if (receipt) break;
      await delay(100);
    }
    assert.ok(receipt, 'aborted calls retain request and response receipts');
    const response = JSON.parse(await readFile(path.join(f.scope.currentArtifactDirectory, receipt.responseRef), 'utf8')) as CallToolResult;
    assert.equal(payload(response).aborted, true);
    for (const resource of [`${invocation}-worker`, `${invocation}-broker`]) {
      await assert.rejects(exec('docker', ['inspect', resource]), /No such|not found/i);
    }
    await assert.rejects(exec('docker', ['volume', 'inspect', `${invocation}-socket`]), /No such|no such|not found/i);
    await client.close();
  }
});

test('missing research image returns an actionable prerequisite without building or pulling', {
  skip: process.env.RESEARCH_DOCKER_SMOKE !== '1', timeout: 30_000,
}, async (t) => {
  const f = await evidenceFixture(t);
  const prepared = await prepareEvidenceInvocation(f.scope, 1);
  const client = new Client({ name: 'research-prerequisite-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx',
    fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url)), '--manifest', prepared.manifestPath, '--sha256', digest(await readFile(prepared.manifestPath))],
    env: { ...evidenceHelperEnvironment(), HARNESS_RESEARCH_IMAGE: `ainative-planner-research:absent-${Date.now()}` }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const observations = payload(await client.callTool({ name: 'list_observations', arguments: { kind: 'observation' } }) as CallToolResult);
  const result = await client.callTool({ name: 'research_shell', arguments: { observationRef: observations.items[0].snapshotRef, command: 'true' } }) as CallToolResult;
  assert.equal(result.isError, true);
  assert.match(payload(result).error, /prerequisite.*operator-built.*No image is built or pulled automatically/);
  assert.equal((await readEvidenceLedger(f.scope)).items.find((item) => item.tool === 'research_shell')?.status, 'error');
});
