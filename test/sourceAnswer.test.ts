import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { AgentRunner } from '../src/agents.js';
import { CampaignConfigSchema, type CampaignRecord } from '../src/types.js';
import { runCommand, type CommandResult } from '../src/process.js';

const input = { id: 'question-a', question: 'Which operating boundary?', type: 'free_text', options: [] };
const answer = { resolution: 'answered', answer: 'Use the source-proven boundary; the exact value is deployment-provided.', evidence: ['src/shared.ts:1'] };
const event = (type: string, part: Record<string, unknown> = {}, sessionID = 'ses_question_a') =>
  `${JSON.stringify({ type, sessionID, part })}\n`;
const result = (command: string, args: readonly string[], stdout: string): CommandResult =>
  ({ command, args: [...args], exitCode: 0, stdout, stderr: '', durationMs: 1 });

// Model output stays mocked; discovery has its own fixed command contract.
function sourceCommands(model: typeof runCommand): typeof runCommand {
  return async (command, args, options) => {
    if (command === 'git') return await runCommand(command, args, options);
    if (args.includes('debug')) {
      assert.equal(options?.logPath, undefined, 'resolved configuration must never be logged');
      assert.equal(args.includes('--pure'), true);
      if (args.includes('paths')) return result(command, args, `data       ${path.join(os.homedir(), '.local/share/opencode')}\n`);
      assert.equal(args.includes('config'), true);
      try {
        const configuration = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
        if (!configuration || Array.isArray(configuration)) throw new Error();
        return result(command, args, JSON.stringify(configuration));
      } catch { return { ...result(command, args, ''), exitCode: 1 }; }
    }
    return await model(command, args, options);
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-answer-'));
  const source = path.join(root, '.data', 'frozen-source');
  const artifacts = path.join(root, '.data', 'artifacts');
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(source, 'src/shared.ts'), 'export const fixture = true;');
  await runCommand('git', ['init', '--quiet'], { cwd: source });
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const config = CampaignConfigSchema.parse({ id: 'source-answer', goal: 'Test scoped source answers.',
    plannerRepo: source, workflowsRepo: source, environmentFile: path.join(root, 'private.env'),
    seedRevision: 'seed', workflowsRevision: 'source', agent: { autoApprove: true },
    benchmarks: [{ name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
      { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' }] });
  const campaign = { id: config.id, config, seedSha: 'a'.repeat(40), workflowsSha: 'b'.repeat(40) } as CampaignRecord;
  return { root, source, artifacts, campaign, directory: path.join(artifacts, `source-answer-${input.id}`) };
}

function inheritedConfig(t: TestContext, value: unknown) {
  const previous = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = typeof value === 'string' ? value : JSON.stringify(value);
  t.after(() => { if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = previous; });
}

type Policy = Record<string, string | Record<string, string>>;
function decision(policy: Policy, tool: string, resource: string): string {
  const rules = policy[tool] ?? policy['*'] ?? 'ask';
  if (typeof rules === 'string') return rules;
  return Object.entries(rules).filter(([pattern]) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(resource)).at(-1)?.[1] ?? 'ask';
}

test('denied tool-end output repairs once in the same scoped question session and archives diagnostics', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const request = { ...input, rationale: 'Need the boundary, not deployment credentials.', coverageIds: ['coverage-a'],
    requirementRefs: [{ entity: 'requirement', anchor: 'boundary' }], context: { ownerRole: 'PM', selected: { text: 'Read-only access.' } } };
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args, options) => {
    calls.push([...args]); envs.push(options!.env!);
    const stdout = calls.length === 1
      ? event('text', { text: 'Inspecting source.' }) + event('tool_use', { tool: 'read', state: { status: 'error', error: 'Denied parent directory', output: JSON.stringify(answer) } }) + event('step_finish', { reason: 'tool-calls' })
      : event('text', { text: 'I have enough evidence.' }) + event('text', { text: JSON.stringify(answer) }) + event('step_finish', { reason: 'stop' });
    options!.onStdout!(Buffer.from(stdout.slice(0, 51)));
    options!.onStdout!(Buffer.from(stdout.slice(51)));
    return result(command, args, 'truncated capture must not be parsed');
  }));
  assert.deepEqual(await runner.answerUpstreamQuestion(request, f.source, f.artifacts, { mode: 'pm-simulation' }), answer);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.includes('--session'), false);
  assert.equal(calls[1]![calls[1]!.indexOf('--session') + 1], 'ses_question_a');
  assert.equal(calls[0]![calls[0]!.indexOf('--agent') + 1], calls[1]![calls[1]!.indexOf('--agent') + 1]);
  assert.deepEqual(envs[0], envs[1]);
  assert.match(calls[1]!.join(' '), /no final JSON answer.*tool/i);
  assert.doesNotMatch(calls[1]!.join(' '), /Denied parent directory/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'request.json'), 'utf8')), request);
  const policy = JSON.parse(await readFile(path.join(f.directory, 'policy.json'), 'utf8'));
  assert.equal(policy.policyVersion, 'scoped-source-answer-v1');
  assert.equal(policy.maxAttempts, 2);
  assert.equal(policy.timeoutMs, 1_800_000);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'result.json'), 'utf8')), answer);
  const first = JSON.parse(await readFile(path.join(f.directory, 'attempt-01-status.json'), 'utf8'));
  assert.equal(first.status, 'source_answer_no_output');
  assert.equal(first.sessionId, 'ses_question_a');
  assert.equal(first.finishReason, 'tool-calls');
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'attempt-02-status.json'), 'utf8')).status, 'completed');
});

test('source boundary permits native inspection only, preserves inherited denies and canonical aliases in both modes', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'source-alias');
  await symlink(f.source, alias);
  await symlink(f.root, path.join(f.source, 'escape'));
  await symlink(path.join(f.source, 'src/shared.ts'), path.join(f.source, 'linked.ts'));
  const previous = { experimental: { continue_loop_on_deny: false }, provider: { fixture: { options: { apiKey: 'PRIVATE_CONFIG_VALUE' } } },
    permission: { read: { 'src/private.ts': 'deny' }, 'glo?': { '*blocked*': 'deny' }, list: { '*/private-dir': 'deny' } } };
  inheritedConfig(t, previous);
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args, options) => {
    assert.equal(args.includes('--pure'), true);
    assert.equal(args.includes('--auto'), false);
    assert.equal(args.includes('--file'), false);
    assert.equal(options!.cwd, alias);
    assert.equal(options!.env!.OPENCODE_EXPERIMENTAL_CODE_MODE, 'false');
    const configuration = JSON.parse(options!.env!.OPENCODE_CONFIG_CONTENT!);
    assert.equal(configuration.experimental.continue_loop_on_deny, true);
    assert.equal(configuration.formatter, false);
    assert.equal(configuration.lsp, false);
    assert.equal(configuration.snapshot, false);
    assert.equal(configuration.share, 'disabled');
    const agent = configuration.agent[args[args.indexOf('--agent') + 1]!];
    assert.equal(agent.mode, 'primary');
    const policy: Policy = agent.permission;
    for (const tool of ['glob', 'list', 'bash', 'grep', 'edit', 'write', 'apply_patch', 'task', 'webfetch', 'websearch', 'network', 'skill', 'todowrite', 'external_tool', 'harness_evidence_read_evidence']) {
      assert.equal(decision(policy, tool, path.join(alias, 'src/shared.ts')), 'deny', tool);
    }
    assert.equal(decision(policy, 'glob', '**/*.ts'), 'deny');
    assert.equal(decision(policy, 'glob', '**/*blocked*'), 'deny');
    for (const base of ['', alias, await realpath(f.source)]) {
      assert.equal(decision(policy, 'read', path.join(base, 'src/shared.ts')), 'allow');
      assert.equal(decision(policy, 'read', path.join(base, 'src/private.ts')), 'deny');
      for (const name of ['generated.env', '.env.local', 'nested/private.key', '.npmrc', 'auth.json', 'credentials.json', '.git/config', '.ssh/id_rsa', '.aws/config', '.opencode/opencode.json', 'node_modules/private.json', 'escape/private.json', 'linked.ts']) {
        assert.equal(decision(policy, 'read', path.join(base, name)), 'deny', path.join(base, name));
      }
    }
    for (const base of [alias, await realpath(f.source)]) {
      assert.equal(decision(policy, 'external_directory', `${base}/*`), 'allow');
      assert.equal(decision(policy, 'list', `${base}/src`), 'deny');
      assert.equal(decision(policy, 'list', `${base}/private-dir`), 'deny');
      assert.equal(decision(policy, 'external_directory', `${base}/escape/*`), 'deny');
    }
    for (const outside of [path.dirname(alias), path.dirname(f.source), f.artifacts, '/etc', '/']) {
      assert.equal(decision(policy, 'external_directory', `${outside}/*`), 'deny', outside);
      assert.equal(decision(policy, 'read', `${outside}/file.ts`), 'deny', outside);
    }
    assert.equal(decision(policy, 'read', '../sibling.ts'), 'deny');
    assert.match(args.join(' '), /Do not inspect parent, sibling, or external paths/);
    return result(command, args, JSON.stringify(answer));
  }));
  for (const mode of ['source-grounded', 'pm-simulation'] as const) {
    await runner.answerUpstreamQuestion({ ...input, id: mode }, alias, f.artifacts, { mode });
    const archived = await readFile(path.join(f.artifacts, `source-answer-${mode}`, 'policy.json'), 'utf8');
    assert.doesNotMatch(archived, /PRIVATE_CONFIG_VALUE|apiKey|provider/);
  }
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, JSON.stringify(previous));
});

test('two tool-only turns fail safely without inventing an unresolved answer', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  let calls = 0;
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args) => {
    calls++;
    return result(command, args, event('tool_use', { text: JSON.stringify(answer) }) + event('step_finish', { reason: 'tool-calls' }));
  }));
  await assert.rejects(runner.answerUpstreamQuestion(input, f.source, f.artifacts), (error: any) => {
    assert.equal(error instanceof Error, true);
    assert.deepEqual(error.failure, { origin: 'harness', code: 'source_answer_no_output', message: 'Source answer agent returned no final JSON answer.' });
    assert.equal(error.message, error.failure.message);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal((await readdir(f.directory)).includes('result.json'), false);
});

test('malformed output and execution exceptions expose only coded safe errors and private cause hashes', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  for (const kind of ['invalid', 'throw', 'exit', 'event-error'] as const) {
    let calls = 0;
    const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args) => {
      calls++;
      if (kind === 'throw') throw new Error('PRIVATE_PROVIDER_SECRET in prompt and stderr');
      if (kind === 'exit') return { ...result(command, args, ''), exitCode: 1, stderr: 'PRIVATE_PROVIDER_SECRET' };
      if (kind === 'event-error') return result(command, args, event('error', { message: 'PRIVATE_PROVIDER_SECRET' }));
      return result(command, args, event('text', { text: '{"resolution":"answered","answer":"PRIVATE_PROVIDER_SECRET"}' }));
    }));
    await assert.rejects(runner.answerUpstreamQuestion({ ...input, id: kind }, f.source, f.artifacts), (error: any) => {
      assert.equal(error.failure.origin, 'harness');
      assert.equal(error.failure.code, kind === 'invalid' ? 'source_answer_invalid_output' : 'source_answer_execution_failed');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /PRIVATE_PROVIDER_SECRET/);
      return true;
    });
    assert.equal(calls, kind === 'invalid' ? 2 : 1);
    const directory = path.join(f.artifacts, `source-answer-${kind}`);
    for (const name of await readdir(directory)) {
      assert.doesNotMatch(await readFile(path.join(directory, name), 'utf8'), /PRIVATE_PROVIDER_SECRET/);
    }
    if (kind === 'throw') {
      const cause = JSON.parse(await readFile(path.join(directory, 'attempt-01-cause.json'), 'utf8'));
      assert.equal(cause.errorName, 'Error');
      assert.match(cause.sha256, /^sha256:[a-f0-9]{64}$/);
    }
  }
});

test('valid unresolved output remains a model answer and questions do not share sessions', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  const unresolved = { resolution: 'unresolved', reason: 'Source does not establish a safe boundary.', evidence: [] };
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args) => {
    assert.equal(args.includes('--session'), false);
    return result(command, args, JSON.stringify(unresolved, null, 2));
  }));
  for (const id of ['question-a', 'question-b']) {
    assert.deepEqual(await runner.answerUpstreamQuestion({ ...input, id }, f.source, f.artifacts), unresolved);
  }
});

test('streaming retains the final UTF-8 answer after more than 5 MiB of tool output', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  const unicodeAnswer = { ...answer, answer: 'La valeur exacte est fournie au d\u00e9ploiement.' };
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args, options) => {
    const tool = Buffer.from(event('tool_use', { state: { output: 'x'.repeat(128 * 1024) } }));
    for (let i = 0; i < 45; i++) options!.onStdout!(tool);
    const bytes = Buffer.from(event('text', { text: JSON.stringify(unicodeAnswer) }) + event('step_finish', { reason: 'stop' }));
    for (let i = 0; i < bytes.length; i++) options!.onStdout!(bytes.subarray(i, i + 1));
    return result(command, args, tool.toString());
  }));
  assert.deepEqual(await runner.answerUpstreamQuestion(input, f.source, f.artifacts), unicodeAnswer);
});

test('unsafe IDs, oversized or unbounded inputs and invalid inherited configuration fail before dispatch', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  let calls = 0;
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args) => { calls++; return result(command, args, JSON.stringify(answer)); }));
  for (const request of [
    { ...input, id: '../outside' }, { ...input, id: '-option' }, { ...input, id: 'a'.repeat(129) },
    { ...input, question: 'x'.repeat(16_385) }, { ...input, rationale: 'x'.repeat(4_001) },
    { ...input, coverageIds: Array(33).fill('a') }, { ...input, requirementRefs: [{ entity: 'a' }] },
    { ...input, context: { nested: { a: { b: { c: { d: 'too deep' } } } } } },
    { ...input, context: { a: 'x'.repeat(4_000), b: 'x'.repeat(4_000), c: 'x'.repeat(4_000), d: 'x'.repeat(4_000), e: 'x'.repeat(4_000) } },
  ]) {
    await assert.rejects(runner.answerUpstreamQuestion(request as typeof input, f.source, f.artifacts), (error: any) => error.failure?.code === 'source_answer_execution_failed');
  }
  assert.deepEqual(await readdir(f.artifacts), []);
  for (const configuration of ['{not valid', 'null', JSON.stringify({ permission: 'deny' }), JSON.stringify({ permission: { '*': 'deny' } })]) {
    process.env.OPENCODE_CONFIG_CONTENT = configuration;
    await assert.rejects(runner.answerUpstreamQuestion(input, f.source, f.artifacts), (error: any) => error.failure?.code === 'source_answer_execution_failed');
  }
  assert.equal(calls, 0);
});

test('non-Git source has no relative wildcard grant and explicitly denies shared tool-output exceptions', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.source, '.git'), { recursive: true });
  inheritedConfig(t, {});
  let permission: Policy = {};
  const runner = new AgentRunner(f.campaign, sourceCommands(async (command, args, options) => {
    const configuration = JSON.parse(options!.env!.OPENCODE_CONFIG_CONTENT!);
    permission = configuration.agent[args[args.indexOf('--agent') + 1]!].permission;
    return result(command, args, JSON.stringify(answer));
  }));
  await runner.answerUpstreamQuestion(input, f.source, f.artifacts);
  assert.equal((permission.read as Record<string, string>)['*'], 'deny');
  for (const source of [f.source, await realpath(f.source)]) {
    assert.equal(decision(permission, 'read', path.relative('/', path.join(source, 'src/shared.ts'))), 'allow');
  }
  for (const outside of [f.root, '/', path.join(os.homedir(), '.local/share/opencode/tool-output')]) {
    assert.equal(decision(permission, 'read', path.relative('/', outside)), 'deny');
    assert.equal(decision(permission, 'read', path.relative('/', path.join(outside, 'file.txt'))), 'deny');
  }
  assert.equal((permission.external_directory as Record<string, string>)[`${os.homedir()}/.local/share/opencode/tool-output/*`], 'deny');
});

test('discovery fails closed without logging configuration, accepting a parent Git root, or starting a model', async (t) => {
  const f = await fixture(t);
  inheritedConfig(t, {});
  for (const failure of ['config-error', 'config-limit', 'parent-git'] as const) {
    let modelCalls = 0;
    const runner = new AgentRunner(f.campaign, async (command, args, options) => {
      if (args[0] === 'run') { modelCalls++; return result(command, args, JSON.stringify(answer)); }
      assert.equal(options?.logPath, undefined);
      if (command === 'git') return failure === 'parent-git'
        ? result(command, args, f.root) : await runCommand(command, args, options);
      if (failure === 'config-limit') {
        options!.onStdout!(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
        return result(command, args, '{}');
      }
      return { ...result(command, args, ''), exitCode: 1, stderr: 'PRIVATE_CONFIG_CONTENT' };
    });
    await assert.rejects(runner.answerUpstreamQuestion(input, f.source, f.artifacts), (error: any) => {
      assert.equal(error.failure?.code, 'source_answer_execution_failed');
      assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /PRIVATE_CONFIG_CONTENT/);
      return true;
    });
    assert.equal(modelCalls, 0);
    assert.deepEqual(await readdir(f.artifacts), []);
  }
});

test('actual OpenCode read-only permissions protect Git and non-Git roots with effective config inheritance', {
  skip: process.env.OPENCODE_PERMISSION_SMOKE !== '1', timeout: 180_000,
}, async (t) => {
  const f = await fixture(t);
  const overrides: NodeJS.ProcessEnv = {
    HOME: path.join(f.root, 'home'), XDG_CONFIG_HOME: path.join(f.root, 'config'),
    XDG_DATA_HOME: path.join(f.root, 'data'), XDG_CACHE_HOME: path.join(f.root, 'cache'),
    XDG_STATE_HOME: path.join(f.root, 'state'), OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'false', OPENCODE_CONFIG: undefined, OPENCODE_CONFIG_DIR: undefined,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { read: { '*inline-private*': 'deny' } } }),
    OPENCODE_PERMISSION: JSON.stringify({ read: { '*env-private*': 'deny' } }),
  };
  const original = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const globalDirectory = path.join(overrides.XDG_CONFIG_HOME!, 'opencode');
  const toolOutput = path.join(overrides.XDG_DATA_HOME!, 'opencode/tool-output');
  const privateDirectory = path.join(f.source, 'private-dir');
  await Promise.all([globalDirectory, toolOutput, privateDirectory].map(async (directory) => await mkdir(directory, { recursive: true })));
  await writeFile(path.join(globalDirectory, 'opencode.json'), JSON.stringify({ permission: { read: { '*global-private*': 'deny', '*private-dir*': 'deny' } } }));
  await writeFile(path.join(f.source, 'opencode.json'), JSON.stringify({ permission: { read: { '*project-private*': 'deny' } } }));
  const privateFiles = [path.join(f.root, 'outside.txt'), path.join(toolOutput, 'shared.txt'), path.join(privateDirectory, 'hidden.txt'),
    ...['.env', 'global-private.txt', 'project-private.txt', 'inline-private.txt', 'env-private.txt'].map((name) => path.join(f.source, name))];
  await Promise.all(privateFiles.map(async (file) => await writeFile(file, 'PRIVATE_FIXTURE_DO_NOT_READ')));
  await symlink(f.root, path.join(f.source, 'escape'));
  await symlink(path.join(f.source, 'src/shared.ts'), path.join(f.source, 'linked.ts'));
  let invocation: { args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
  const runner = new AgentRunner(f.campaign, async (command, args, options) => {
    if (args[0] !== 'run') {
      assert.equal(options?.logPath, undefined);
      return await runCommand(command, args, options);
    }
    invocation = { args, env: options!.env! };
    return result(command, args, JSON.stringify(answer));
  });
  for (const mode of ['git', 'non-git', 'ancestor-git']) {
    if (mode === 'non-git') await rm(path.join(f.source, '.git'), { recursive: true });
    if (mode === 'ancestor-git') await runCommand('git', ['init', '--quiet'], { cwd: f.root });
    await runner.answerUpstreamQuestion({ ...input, id: mode }, f.source, f.artifacts);
    assert.ok(invocation);
    const selected = invocation.args[invocation.args.indexOf('--agent') + 1]!;
    const debug = async (tool?: string, params?: unknown) => await runCommand(f.campaign.config.agent.command,
      ['--pure', '--log-level', 'ERROR', 'debug', 'agent', selected, ...(tool ? ['--tool', tool, '--params', JSON.stringify(params)] : [])],
      { cwd: f.source, env: invocation!.env, timeoutMs: 20_000, allowFailure: true });
    const resolved = await debug();
    assert.equal(resolved.exitCode, 0, 'agent must resolve');
    const tools = JSON.parse(resolved.stdout).tools as Record<string, boolean>;
    assert.deepEqual(Object.entries(tools).filter(([, enabled]) => enabled).map(([name]) => name), ['read']);
    for (const filePath of [f.source, path.join(f.source, 'src'), path.join(f.source, 'src/shared.ts'), path.join(await realpath(f.source), 'src/shared.ts')]) {
      const allowed = await debug('read', { filePath });
      assert.equal(allowed.exitCode, 0, `source read allowed: ${filePath} (${mode})`);
      assert.match(allowed.stdout, /shared\.ts|fixture|src/);
    }
    for (const filePath of [...privateFiles, privateDirectory, f.root, '/', toolOutput, path.join(f.source, 'escape'), path.join(f.source, 'escape/outside.txt'), path.join(f.source, 'linked.ts')]) {
      const denied = await debug('read', { filePath });
      assert.notEqual(denied.exitCode, 0, `read denied: ${filePath} (${mode})`);
      assert.doesNotMatch(denied.stdout + denied.stderr, /PRIVATE_FIXTURE_DO_NOT_READ/);
    }
    for (const tool of ['glob', 'list', 'grep', 'bash', 'apply_patch', 'webfetch', 'task']) {
      const denied = await debug(tool, tool === 'glob' ? { pattern: '**/*', path: f.root } : { path: f.root });
      assert.notEqual(denied.exitCode, 0, `${tool} is disabled`);
    }
    t.diagnostic(`${mode} CLI read boundary and effective global/project/inline/environment denies verified`);
  }
});
