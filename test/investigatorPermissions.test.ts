import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRunner, inheritedEvidencePermission } from '../src/agents.js';

test('evidence tools preserve inherited wildcard denials and confirmation rules', () => {
  const name = 'harness_evidence_research_shell';
  assert.equal(inheritedEvidencePermission(undefined, name), 'allow');
  assert.equal(inheritedEvidencePermission('ask', name), 'ask');
  assert.equal(inheritedEvidencePermission({ '*': 'ask', 'harness_evidence_research_*': 'deny' }, name), 'deny');
  assert.equal(inheritedEvidencePermission({ 'harness_evidence_*': 'deny', [name]: 'ask' }, name), 'ask');
  assert.equal(inheritedEvidencePermission({ 'harness_evidence_research_?????': 'deny' }, name), 'deny');
  assert.deepEqual(inheritedEvidencePermission({ [name]: { '*': 'deny' } }, name), { '*': 'deny' });
  assert.equal(inheritedEvidencePermission({ 'harness_evidence_research_*': 'deny' }, 'harness_evidence_read_evidence'), 'allow');
});
import { HarnessDatabase } from '../src/db.js';
import { runCommand } from '../src/process.js';
import { CampaignConfigSchema, HypothesisSchema } from '../src/types.js';
import type { InvestigationState } from '../src/investigator.js';

type Rules = string | Record<string, string>;
type Policy = Record<string, Rules>;
function decision(policy: Policy, tool: string, resource: string): string {
  const rules = policy[tool] ?? policy['*'] ?? 'ask';
  if (typeof rules === 'string') return rules;
  return Object.entries(rules).filter(([pattern]) => new RegExp(`^${pattern.split('*').map((part) =>
    part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(resource)).at(-1)?.[1] ?? 'ask';
}

test('invocation scopes evidence reads, denies secrets and host execution, and cannot broaden through context paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'investigator-permissions-'));
  const data = path.join(root, '.data');
  const worktree = path.join(data, 'worktrees', 'scoped', 'scoped-v001');
  const workflowsSource = path.join(path.dirname(worktree), 'frozen-workflows');
  const artifacts = path.join(data, 'artifacts', 'scoped', 'scoped-v001');
  const parent = path.join(path.dirname(artifacts), 'scoped-v000');
  const prior = path.join(path.dirname(artifacts), 'scoped-v002');
  const outside = path.join(data, 'other-campaign');
  await Promise.all([worktree, workflowsSource, artifacts, parent, prior, outside,
    path.join(worktree, 'server/src'), path.join(worktree, 'server/test')].map((directory) => mkdir(directory, { recursive: true })));
  await runCommand('git', ['init', '--quiet'], { cwd: worktree });
  await symlink(outside, path.join(parent, 'escape'));
  const database = new HarnessDatabase(':memory:');
  const previous = JSON.stringify({ model: 'provider/existing', experimental: { openTelemetry: false },
    permission: { read: { 'server/src/private.ts': 'deny' } } });
  const originalConfig = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = previous;
  try {
    const config = CampaignConfigSchema.parse({ id: 'scoped', goal: 'Inspect only coordinator-approved source and evidence paths.',
      plannerRepo: worktree, workflowsRepo: workflowsSource, environmentFile: path.join(data, 'private.env'),
      seedRevision: 'seed', workflowsRevision: 'source', investigator: { enabled: true }, agent: { autoApprove: true },
      benchmarks: [{ name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
        { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' }] });
    const campaign = database.createCampaign(config, 'seed', 'source', 'env', 'remote');
    const hypothesis = HypothesisSchema.parse({ title: 'Scoped research', rationale: 'Inspect before editing',
      instructions: 'Read evidence', expectedImpact: 'Unknown', risk: 'Evidence incomplete' });
    const variant = database.createVariant({ id: 'scoped-v001', campaignId: 'scoped', parentVariantId: 'scoped-v000',
      round: 1, ordinal: 1, hypothesis });
    const state: InvestigationState = { schemaVersion: 1, status: 'running', sessionId: 'ses_scoped',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turnCount: 0,
      agentTokens: 0, agentCostUsd: 0, reason: null, actions: [] };
    const context = { artifacts: { current: artifacts, parent, workflowsSource,
      priorExperiments: [{ id: 'scoped-v002', directory: prior }] } };
    const contextPath = path.join(artifacts, 'context.json');
    await writeFile(contextPath, JSON.stringify(context));
    let calls = 0;
    const runner = new AgentRunner(campaign, async (command, args, options) => {
      calls += 1;
      assert.equal(args.includes('--auto'), false, 'never grant blanket automatic approvals');
      assert.equal(args.includes('--pure'), true);
      const injected = JSON.parse(options!.env!.OPENCODE_CONFIG_CONTENT!) as {
        model: string; experimental: Record<string, unknown>; formatter: boolean; lsp: boolean;
        agent: Record<string, { permission: Policy; mode: string }>;
      };
      assert.equal(injected.model, 'provider/existing');
      assert.equal(injected.experimental.openTelemetry, false);
      assert.equal(injected.experimental.continue_loop_on_deny, true);
      assert.equal(injected.formatter, false);
      assert.equal(injected.lsp, false);
      const builder = injected.agent[args[args.indexOf('--agent') + 1]!]!;
      const [readerName, reader] = Object.entries(injected.agent).find(([, agent]) => agent.mode === 'subagent')!;
      assert.equal(decision(builder.permission, 'task', readerName), 'allow');
      assert.equal(decision(builder.permission, 'task', 'general'), 'deny');
      for (const agent of [builder, reader]) {
        for (const cmd of ['npm test', 'docker ps', 'git add .', 'node -e anything', 'cat /etc/passwd']) {
          assert.equal(decision(agent.permission, 'bash', cmd), 'deny');
        }
        assert.equal(decision(agent.permission, 'grep', 'TOKEN'), 'deny', 'grep does not enforce file-read denies');
        assert.equal(decision(agent.permission, 'read', path.relative(worktree, config.environmentFile)), 'deny');
        assert.equal(decision(agent.permission, 'read', 'server/src/private.ts'), 'deny');
        for (const source of [worktree, artifacts, parent, prior, workflowsSource]) {
          for (const secret of ['generated.env', '.env.local', '.npmrc', 'credentials.json', 'private.pem', '.git/config']) {
            assert.equal(decision(agent.permission, 'read', path.relative(worktree, path.join(source, secret))), 'deny', secret);
          }
        }
      }
      for (const source of [artifacts, parent, prior, workflowsSource]) {
        assert.equal(decision(reader.permission, 'external_directory', `${await realpath(source)}/*`), 'allow');
        assert.equal(decision(reader.permission, 'read', path.relative(worktree, path.join(source, 'analysis.json'))), 'allow');
        assert.equal(decision(reader.permission, 'edit', path.relative(worktree, path.join(source, 'analysis.json'))), 'deny');
        assert.equal(decision(builder.permission, 'external_directory', `${source}/*`), 'deny', 'builder cannot move a patch into evidence');
      }
      assert.equal(decision(reader.permission, 'read', path.relative(worktree, path.join(parent, 'escape/private.json'))), 'deny');
      assert.equal(decision(reader.permission, 'external_directory', `${outside}/*`), 'deny');
      assert.equal(decision(reader.permission, 'external_directory', `${path.dirname(artifacts)}/*`), 'deny');
      assert.equal(decision(builder.permission, 'edit', 'server/src/evidence.ts'), 'allow');
      assert.equal(decision(builder.permission, 'edit', 'server/test/evidence.test.ts'), 'allow');
      assert.equal(decision(builder.permission, 'edit', '.git/config'), 'deny');
      if (process.env.OPENCODE_PERMISSION_SMOKE === '1') {
        const env: NodeJS.ProcessEnv = { ...options!.env,
          HOME: path.join(root, 'isolated-home'), XDG_CONFIG_HOME: path.join(root, 'isolated-config'),
          XDG_DATA_HOME: path.join(root, 'isolated-data'), XDG_CACHE_HOME: path.join(root, 'isolated-cache'),
          XDG_STATE_HOME: path.join(root, 'isolated-state'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' };
        delete env.OPENCODE_CONFIG; delete env.OPENCODE_CONFIG_DIR; delete env.OPENCODE_PERMISSION;
        const builderName = args[args.indexOf('--agent') + 1]!;
        const debug = async (name: string, tool?: string, params?: unknown) => await runCommand(command,
          ['debug', 'agent', name, '--pure', ...(tool ? ['--tool', tool, '--params', JSON.stringify(params)] : [])],
          { cwd: worktree, env, timeoutMs: 60_000, allowFailure: true });
        const resolved = await debug(builderName);
        assert.equal(resolved.exitCode, 0, resolved.stderr);
        const tools = (JSON.parse(resolved.stdout) as { tools: Record<string, boolean> }).tools;
        assert.equal(tools.bash, false);
        assert.equal(tools.grep, false);
        assert.equal(tools.apply_patch, true);
        const filePath = path.join(parent, 'analysis.json');
        await writeFile(filePath, '{"fixtureEvidence":true}');
        const approved = await debug(readerName, 'read', { filePath });
        assert.equal(approved.exitCode, 0, approved.stderr);
        assert.match(approved.stdout, /fixtureEvidence/);
        assert.notEqual((await debug(builderName, 'read', { filePath })).exitCode, 0);
        const secretPath = path.join(parent, 'generated.env');
        await writeFile(secretPath, 'SYNTHETIC_SECRET=never-print-this-fixture');
        const denied = await debug(readerName, 'read', { filePath: secretPath });
        assert.notEqual(denied.exitCode, 0);
        assert.doesNotMatch(denied.stdout + denied.stderr, /never-print-this-fixture/);
        const added = await debug(builderName, 'apply_patch', {
          patchText: '*** Begin Patch\n*** Add File: server/src/permission-smoke.ts\n+export const fixture = true;\n*** End Patch',
        });
        assert.equal(added.exitCode, 0, added.stderr);
        const escapedPath = path.join(parent, 'forbidden-move.ts');
        const moved = await debug(builderName, 'apply_patch', {
          patchText: `*** Begin Patch\n*** Update File: server/src/permission-smoke.ts\n*** Move to: ${escapedPath}\n@@\n-export const fixture = true;\n+export const fixture = false;\n*** End Patch`,
        });
        assert.notEqual(moved.exitCode, 0);
        assert.equal(await stat(escapedPath).catch(() => null), null);
        assert.match(await readFile(path.join(worktree, 'server/src/permission-smoke.ts'), 'utf8'), /fixture = true/);
      }
      return { command, args: [...args], exitCode: 0, stderr: '', durationMs: 1,
        stdout: JSON.stringify({ type: 'text', sessionID: 'ses_scoped', part: { text: JSON.stringify({ action: 'abandon', rationale: 'No measured improvement claimed', hypothesis }) } }) };
    });
    await runner.investigate(variant, worktree, artifacts, contextPath, state, null);
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, previous, 'parent environment stays untouched');
    for (const invalid of [
      { ...context.artifacts, parent: outside },
      { ...context.artifacts, current: parent },
      { ...context.artifacts, workflowsSource: outside },
      { ...context.artifacts, priorExperiments: [{ id: 'other-v001', directory: outside }] },
      { ...context.artifacts, priorExperiments: [{ id: 'scoped-v000', directory: path.join(parent, 'escape') }] },
    ]) {
      await writeFile(contextPath, JSON.stringify({ artifacts: invalid }));
      await assert.rejects(runner.investigate(variant, worktree, artifacts, contextPath, { ...state, turnCount: 1 }, null), /evidence|context|campaign|workflows/i);
    }
    assert.equal(calls, 1);
    await writeFile(contextPath, JSON.stringify(context));
    process.env.OPENCODE_CONFIG_CONTENT = '{ malformed inline config';
    await assert.rejects(runner.investigate(variant, worktree, artifacts, contextPath, { ...state, turnCount: 1 }, null), /invalid inherited OPENCODE_CONFIG_CONTENT/);
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: 'deny' });
    await assert.rejects(runner.investigate(variant, worktree, artifacts, contextPath, { ...state, turnCount: 1 }, null), /inherited.*denies/i);
    assert.equal(calls, 1);
  } finally {
    if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = originalConfig;
    database.close(); await rm(root, { recursive: true, force: true });
  }
});
