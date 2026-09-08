import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRunner } from '../src/agents.js';
import { HarnessDatabase } from '../src/db.js';
import {
  InvestigatorActionSchema,
  InvestigatorEventParser,
  parseInvestigatorResponse,
  type InvestigationState,
} from '../src/investigator.js';
import { CampaignConfigSchema, HypothesisSchema } from '../src/types.js';

const hypothesis = HypothesisSchema.parse({
  title: 'Retain qualified evidence',
  rationale: 'Test whether evidence loss explains the observed error.',
  instructions: 'Inspect evidence hydration and add a generic boundary regression.',
  expectedImpact: 'May reduce missed evidence; improvement is not assured.',
  risk: 'The diagnosed mechanism may be wrong.',
});
const action = { action: 'test', rationale: 'Check the regression before evaluation.', hypothesis };
const event = (type: string, part: unknown, sessionID = 'ses_investigation') =>
  JSON.stringify({ type, sessionID, part });
const text = (value: unknown, messageID = 'msg_final') =>
  event('text', { type: 'text', messageID, text: JSON.stringify(value) });
const finish = (reason = 'stop') =>
  event('step_finish', {
    type: 'step-finish', reason, cost: 0.25,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
  });
const state = (): InvestigationState => ({
  schemaVersion: 1, sessionId: null, status: 'running',
  startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  turnCount: 0, agentTokens: null, agentCostUsd: null, reason: null, actions: [],
});

test('investigator actions freeze a full compatible hypothesis for every action kind', () => {
  for (const kind of ['test', 'evaluate_primary', 'finalize', 'abandon']) {
    const parsed = InvestigatorActionSchema.parse({ ...action, action: kind });
    assert.deepEqual(HypothesisSchema.parse(parsed.hypothesis), hypothesis);
    assert.equal(InvestigatorActionSchema.safeParse({ action: kind, rationale: 'Reason' }).success, false);
  }
  assert.deepEqual(
    InvestigatorActionSchema.parse({ ...action, testFiles: ['server/test/evidence.test.ts'] }),
    { ...action, testFiles: ['server/test/evidence.test.ts'] },
  );
  for (const invalid of [
    { ...action, action: 'shell' }, { ...action, rationale: '' },
    { ...action, command: 'npm test' }, { ...action, testFiles: [42] },
    { ...action, action: 'finalize', testFiles: ['server/test/evidence.test.ts'] },
  ]) assert.equal(InvestigatorActionSchema.safeParse(invalid).success, false);
});

test('event parser ignores progress and tool text, selecting the final assistant text', () => {
  const output = [
    event('step_start', { type: 'step-start' }),
    text({ ...action, action: 'evaluate_primary' }, 'msg_progress'),
    event('tool_use', { type: 'tool', text: JSON.stringify({ ...action, action: 'abandon' }) }),
    finish('tool-calls'),
    event('step_start', { type: 'step-start' }),
    text(action),
    finish(),
  ].join('\n');
  assert.deepEqual(parseInvestigatorResponse(output), {
    sessionId: 'ses_investigation', action, usage: { tokens: 330, costUsd: 0.5 },
  });
});

test('event parser handles split chunks, UTF-8, fences, and missing final newline', () => {
  const parser = new InvestigatorEventParser();
  const expected = { ...action, rationale: 'Investigate \u00e9vidence.' };
  const bytes = Buffer.from(event('text', {
    type: 'text', text: `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``,
  }));
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  assert.deepEqual(parser.finish(), {
    sessionId: 'ses_investigation', action: expected, usage: { tokens: null, costUsd: null },
  });
});

test('event parser rejects missing, mixed, nested conflicting, and unexpected session IDs', () => {
  for (const output of [
    JSON.stringify({ type: 'text', part: { text: JSON.stringify(action) } }),
    [text(action), event('step_finish', {}, 'ses_other')].join('\n'),
    event('text', { sessionID: 'ses_other', text: JSON.stringify(action) }),
  ]) assert.throws(() => parseInvestigatorResponse(output), /session/i);
  assert.throws(() => parseInvestigatorResponse(text(action), 'ses_expected'), /session/i);
  assert.throws(() => parseInvestigatorResponse(JSON.stringify(action), 'ses_expected'), /session/i);
});

test('event parser exposes the session immediately even if the eventual action is invalid', () => {
  const sessions: string[] = [];
  const parser = new InvestigatorEventParser(null, (id) => { sessions.push(id); });
  parser.write(`${event('step_start', { type: 'step-start' })}\n`);
  assert.deepEqual(sessions, ['ses_investigation']);
  parser.write(`${event('text', { text: 'Not an action' })}\n`);
  assert.throws(() => parser.finish(), /invalid structured/);
  assert.deepEqual(sessions, ['ses_investigation']);
});

test('event parser never falls back to stale valid JSON after incomplete or invalid final output', () => {
  for (const output of [
    [text(action), event('text', { text: 'I could not finish.' })].join('\n'),
    [text(action), finish('tool-calls'), event('step_start', { type: 'step-start' })].join('\n'),
    [text(action), event('error', { message: 'provider failure' })].join('\n'),
    [text(action), finish('length')].join('\n'),
    [text(action), '{"type":"text",'].join('\n'),
  ]) assert.throws(() => parseInvestigatorResponse(output), /output|error|incomplete/i);
});

test('event parser uses reported token totals and preserves unknown or partial usage as null', () => {
  const total = event('step_finish', { reason: 'stop', tokens: { total: 99, input: 999 }, cost: 0 });
  assert.deepEqual(parseInvestigatorResponse(`${text(action)}\n${total}`).usage, { tokens: 99, costUsd: 0 });
  const partial = [text(action), finish('tool-calls'), text(action), event('step_finish', { reason: 'stop' })].join('\n');
  assert.deepEqual(parseInvestigatorResponse(partial).usage, { tokens: null, costUsd: null });
});

test('investigator runner resumes the explicit session, attaches feedback, and streams beyond capture', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-investigator-'));
  const worktree = path.join(root, 'worktree');
  const artifacts = path.join(root, '.data');
  await mkdir(worktree);
  await mkdir(artifacts);
  const workflowsSource = path.join(root, 'frozen-workflows');
  await mkdir(workflowsSource);
  const contextPath = path.join(artifacts, 'context.json');
  await writeFile(contextPath, JSON.stringify({ primaryRawArtifactIndex: ['primary/raw/analysis.json'],
    artifacts: { current: artifacts, workflowsSource, priorExperiments: [] } }));
  const database = new HarnessDatabase(':memory:');
  try {
    const config = CampaignConfigSchema.parse({
      id: 'investigation', goal: 'Investigate failures without promising improvements.',
      plannerRepo: worktree, workflowsRepo: '/tmp/workflows', environmentFile: '/tmp/environment.env',
      seedRevision: 'seed', workflowsRevision: 'workflows', investigator: { enabled: true },
      benchmarks: [
        { name: 'primary', role: 'primary', zipPath: '/tmp/primary.zip' },
        { name: 'holdout', role: 'holdout', zipPath: '/tmp/holdout.zip' },
      ],
    });
    const campaign = database.createCampaign(config, 'seed', 'workflows', 'environment', 'remote');
    const variant = database.createVariant({
      id: 'investigation-v001', campaignId: campaign.id, parentVariantId: null,
      round: 1, ordinal: 1, hypothesis,
    });
    const calls: string[][] = [];
    const sessions: string[] = [];
    const feedback = { status: 'failed', error: 'Boundary regression failed.', artifactDirectory: 'test-01' };
    const runner = new AgentRunner(campaign, async (command, args, options) => {
      calls.push([...args]);
      const attachments = args.flatMap((arg, index) => arg === '--file' ? [args[index + 1]!] : []);
      const contents = await Promise.all(attachments.map((file) => readFile(file, 'utf8')));
      assert.ok(contents.some((content) => content.includes('primary/raw/analysis.json')));
      assert.ok(contents.some((content) => content.includes('Boundary regression failed.')));
      const prompt = args.find((arg) => arg.includes('Campaign goal:'))!;
      assert.match(prompt, /challenge.*diagnosis/i);
      assert.match(prompt, /revise.*hypothesis/i);
      assert.match(prompt, /inspect.*failures/i);
      assert.match(prompt, /Do not run host tests/i);
      assert.match(prompt, /Do not.*Docker/i);
      assert.match(prompt, /Do not.*harness/i);
      assert.match(prompt, /do not.*Git index/i);
      assert.match(prompt, /targeted tests.*passed.*before.*evaluate_primary/i);
      assert.match(prompt, /freeze.*hypothesis.*before.*evaluation/i);
      assert.match(prompt, /full.*suite.*review.*coordinator|coordinator.*full.*suite.*review/i);
      assert.match(prompt, /abandon/);
      assert.match(prompt, /Configured investigation limits/);
      assert.match(prompt, /"maxPrimaryEvaluations": 3/);
      assert.match(prompt, /Unknown usage is not zero/);
      assert.doesNotMatch(prompt, /holdout.*secret|cannot see.*holdout/i);
      assert.ok((options?.timeoutMs ?? Infinity) <= campaign.config.investigator!.maxWallTimeMs);
      const stdout = `${text(action)}\n${finish()}`;
      if (calls.length === 1) {
        options?.onStdout?.(Buffer.from(`${event('tool_use', { text: 'x'.repeat(5 * 1024 * 1024) })}\n`));
        assert.deepEqual(sessions, ['ses_investigation'], 'the coordinator can persist the session before final output');
        options?.onStdout?.(Buffer.from(stdout));
      }
      return { command, args: [...args], exitCode: 0, stdout: calls.length === 1 ? 'truncated' : stdout, stderr: '', durationMs: 1 };
    });
    const current = state();
    const first = await runner.investigate(variant, worktree, artifacts, contextPath, current, feedback,
      (id) => { sessions.push(id); });
    assert.deepEqual(first.action, action);
    assert.equal(first.usage.tokens, 165);
    assert.equal(calls[0]!.includes('--session'), false);
    current.sessionId = first.sessionId;
    current.turnCount = 1;
    const second = await runner.investigate(variant, worktree, artifacts, contextPath, current, feedback);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(calls[1]![calls[1]!.indexOf('--session') + 1], first.sessionId);
    assert.equal(calls[1]!.includes('--continue'), false);
    assert.deepEqual(await readdir(worktree), []);
    assert.equal(current.turnCount, 1, 'the coordinator owns state transitions');
    assert.deepEqual(JSON.parse(await readFile(path.join(artifacts, 'investigator-turn-001-result.json'), 'utf8')), first);
    await assert.rejects(runner.investigate(variant, worktree, artifacts, contextPath,
      { ...current, startedAt: '2000-01-01T00:00:00.000Z' }, feedback), /wall-time budget/);
    assert.equal(calls.length, 2);

    const tamperingRunner = new AgentRunner(campaign, async (command, args) => {
      const attachment = args[args.indexOf('--file') + 1]!;
      await writeFile(attachment, 'changed context');
      return { command, args: [...args], exitCode: 0, stdout: text(action), stderr: '', durationMs: 1 };
    });
    await assert.rejects(tamperingRunner.investigate(variant, worktree, artifacts, contextPath,
      { ...current, turnCount: 2 }, feedback), /modified a local immutable attachment/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
