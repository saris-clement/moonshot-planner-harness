import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentRunner } from '../src/agents.js';
import { HarnessDatabase } from '../src/db.js';
import { evidenceHelperEnvironment, loadEvidenceInvocation } from '../src/evidenceAccess.js';
import type { InvestigationState } from '../src/investigator.js';
import type { InvestigatorBriefing } from '../src/investigatorBriefing.js';
import { CampaignConfigSchema, HypothesisSchema, type RunFacts, type Score } from '../src/types.js';

const toolNames = ['compare_trial', 'inspect_unit', 'list_observations', 'read_evidence', 'research_http', 'research_output', 'research_shell', 'search_source'];
const sessionId = 'ses_context_integration';
const rawMarker = 'ARCHIVED_RESULT_RATIONALE';
const failure = 'The previous agent turn returned incomplete output; inspect the archived trial.';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hypothesis = HypothesisSchema.parse({
  title: 'Retain qualified evidence', rationale: 'Investigate a generic evidence-loss mechanism.',
  instructions: 'Inspect hydration boundaries and preserve counterevidence.',
  expectedImpact: 'A falsifiable improvement in fixed-label agreement, not a promised outcome.',
  risk: 'The mechanism may not explain the observations.', findingIds: [], assumptions: [],
});
const requestedAction = { action: 'test', rationale: 'Test the next bounded revision.', hypothesis };

function payload(result: CallToolResult): Record<string, any> {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return JSON.parse((content as { text: string }).text);
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'investigator-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignId = 'context-integration';
  const variantId = `${campaignId}-v001`;
  const parentId = `${campaignId}-v000`;
  const artifacts = path.join(root, '.data', 'artifacts', campaignId, variantId);
  const parent = path.join(root, '.data', 'artifacts', campaignId, parentId);
  const worktree = path.join(root, '.data', 'worktrees', campaignId, variantId);
  const source = path.join(path.dirname(worktree), 'frozen-workflows');
  const put = async (filename: string, value: unknown) => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value));
  };
  await mkdir(worktree, { recursive: true });
  await put(path.join(source, 'policy.ts'), 'export const policy = "source evidence";');
  const facts = (rationale: string, changed: boolean): RunFacts => ({
    status: 'completed', sampleSize: 1, decisionAgreement: 1, unitCount: 125,
    decisions: { build: changed ? 1 : 0, reuse: changed ? 124 : 125, extend: 0, defer: 0, question: 0 },
    shortlist: { empty: 0, nonempty: 125, candidates: 125 }, evidence: { discovered: 125, selectedSourceRefs: 125 },
    usage: { calls: 125, inputTokens: 1_000, outputTokens: 1_000, totalTokens: 2_000, costUsd: 1, durationMs: 100 },
    pins: { inputSetHash: 'fixed-inputs', decisionSetHash: 'fixed-decisions' },
    units: Array.from({ length: 125 }, (_, index) => ({
      id: `unit-${String(index).padStart(3, '0')}`, key: `unit-${String(index).padStart(3, '0')}`,
      ref: { entity: 'requirement', anchor: String(index) }, kind: 'behavior', semantics: `Requirement ${index}`,
      decision: changed && index === 0 ? 'build' : 'reuse', confidence: 'high', rationale,
      selectedCandidateIds: ['candidate'], sourceRefs: [{ path: 'policy.ts' }], discoveredEvidenceCount: 1,
      shortlistCandidateCount: 1, uncoveredSemantics: [],
    })),
  });
  const baseline = facts('Baseline interpretation, not verified correctness.', false);
  const trial = facts(`${rawMarker} `.repeat(350), true);
  const score: Score = { verified: { labeled: 0, correct: 0, errors: 0, accuracy: null },
    provisional: { labeled: 125, correct: 124, errors: 1, accuracy: 124 / 125 },
    decisionErrors: { build: 1, reuse: 0, extend: 0, defer: 0, question: 0 }, cohortMismatches: [] };
  const baselineScore: Score = { ...score, provisional: { labeled: 125, correct: 125, errors: 0, accuracy: 1 },
    decisionErrors: { build: 0, reuse: 0, extend: 0, defer: 0, question: 0 } };
  const result = { facts: trial, replicateFacts: [trial, trial], score, baselineScore, labelSetHash: 'fixed-labels' };
  const receiptPath = path.join(artifacts, 'investigation', 'action-002', 'receipt.json');
  await put(receiptPath, { patchHash: `sha256:${'a'.repeat(64)}`, artifactDirectory: 'investigation/action-002', result });
  await put(path.join(parent, 'primary/replicate-1/facts.json'), baseline);
  await put(path.join(artifacts, 'investigator-reference.json'), { labelSetHash: 'fixed-labels',
    labels: baseline.units.map((unit) => ({ campaignId, benchmark: 'primary', unitKey: unit.key,
      expectedDecision: unit.decision, status: 'suggested', rationale: 'Frozen provisional label.' })),
    baseline: { id: parentId, facts: baseline, replicateFacts: [baseline] },
  });
  const goal = 'Evaluate generic evidence decisions while retaining failures and successful controls. '.repeat(45);
  const contextPath = path.join(artifacts, 'investigator-context.json');
  const context = { goal, baseline: { score: baselineScore, decisions: baseline.decisions, evidence: baseline.evidence },
    primaryRawArtifactIndex: ['primary/replicate-1/analysis.json'],
    artifacts: { current: artifacts, parent, workflowsSource: source, priorExperiments: [{ id: parentId, directory: parent }] } };
  await put(contextPath, context);
  const database = new HarnessDatabase(':memory:');
  t.after(() => database.close());
  const config = CampaignConfigSchema.parse({ id: campaignId, goal, plannerRepo: worktree, workflowsRepo: source,
    environmentFile: path.join(root, '.env'), seedRevision: 'seed', workflowsRevision: 'workflows', investigator: { enabled: true },
    benchmarks: [{ name: 'primary', role: 'primary', zipPath: path.join(root, 'primary.zip') },
      { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') }],
  });
  const campaign = database.createCampaign(config, 'seed', 'workflows', 'environment', 'remote');
  database.createVariant({ id: parentId, campaignId, parentVariantId: null, round: 0, ordinal: 0, hypothesis });
  const variant = database.createVariant({ id: variantId, campaignId, parentVariantId: parentId, round: 1, ordinal: 1, hypothesis });
  const now = new Date().toISOString();
  const state: InvestigationState = { schemaVersion: 1, sessionId: null, status: 'running', startedAt: now, updatedAt: now,
    turnCount: 3, agentTokens: null, agentCostUsd: null, reason: failure,
    actions: [
      { id: 'action-001', kind: 'test', status: 'completed', hypothesis, rationale: 'Check the initial patch.', startedAt: now, completedAt: now,
        patchHash: `sha256:${'a'.repeat(64)}`, artifactDirectory: 'investigation/action-001', result: { passed: true }, error: null },
      { id: 'action-002', kind: 'evaluate_primary', status: 'completed', hypothesis, rationale: 'Measure the unchanged tested patch.', startedAt: now, completedAt: now,
        patchHash: `sha256:${'a'.repeat(64)}`, artifactDirectory: 'investigation/action-002', result, error: null },
    ] };
  const inherited = { config: process.env.OPENCODE_CONFIG_CONTENT, codeMode: process.env.OPENCODE_EXPERIMENTAL_CODE_MODE };
  process.env.OPENCODE_CONFIG_CONTENT = '{}';
  process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = 'true';
  t.after(async () => {
    if (inherited.config === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = inherited.config;
    if (inherited.codeMode === undefined) delete process.env.OPENCODE_EXPERIMENTAL_CODE_MODE; else process.env.OPENCODE_EXPERIMENTAL_CODE_MODE = inherited.codeMode;
  });
  return { artifacts, worktree, source, contextPath, receiptPath, campaign, variant, database, state, score };
}

for (const mode of ['initial', 'delta'] as const) {
  test(`real AgentRunner ${mode} briefing stays bounded while fresh configured MCP reads archived megabyte results`, async (t) => {
    const f = await fixture(t);
    f.state.sessionId = mode === 'delta' ? sessionId : null;
    f.database.updateVariant(f.variant.id, { investigation: f.state });
    const originalState = JSON.stringify(f.state);
    const persistedState = JSON.stringify(f.database.getVariant(f.variant.id).investigation);
    assert.ok(Buffer.byteLength(originalState) > 1_700_000, 'the stress input must exceed the old attachment scale');
    const originalContext = await readFile(f.contextPath);
    const receiptHash = digest(await readFile(f.receiptPath));
    let calls = 0;
    let attachmentBytes = 0;
    const sessions: string[] = [];
    const runner = new AgentRunner(f.campaign, async (command, args, options) => {
      calls++;
      assert.equal(command, f.campaign.config.agent.command);
      assert.equal(options?.cwd, f.worktree);
      assert.equal(options?.env?.OPENCODE_EXPERIMENTAL_CODE_MODE, 'false');
      const attachments = args.flatMap((arg, index) => arg === '--file' ? [args[index + 1]!] : []);
      assert.equal(attachments.length, 1);
      const attachment = await readFile(attachments[0]!, 'utf8');
      const briefing = JSON.parse(attachment) as InvestigatorBriefing;
      attachmentBytes = Buffer.byteLength(attachment);
      assert.equal(briefing.mode, mode);
      assert.equal(briefing.byteLength, Buffer.byteLength(attachment));
      assert.ok(briefing.byteLength <= (mode === 'delta' ? 8_192 : 16_384));
      assert.equal(attachment.includes(rawMarker), false);
      assert.equal(attachment.includes('replicateFacts'), false);
      assert.deepEqual(briefing.currentHypothesis, hypothesis);
      assert.equal(briefing.failureSummary, failure);
      assert.equal(briefing.referenceHandles.context, briefing.referenceHandles.currentHypothesis);
      assert.match(String(briefing.referenceHandles.context), /^evidence_[a-f0-9]{64}$/);
      assert.match(String(briefing.referenceHandles.feedback), /^evidence_[a-f0-9]{64}$/);
      if (mode === 'initial') assert.equal(briefing.objective, f.campaign.config.goal);
      else assert.ok(briefing.omissions.some((omission) => omission.field === 'objective' && omission.handleAvailability === 'registered'));
      assert.equal(args.includes('--continue'), false);
      assert.equal(args.includes('--session'), mode === 'delta');
      if (mode === 'delta') assert.equal(args[args.indexOf('--session') + 1], sessionId);

      const configuration = JSON.parse(options!.env!.OPENCODE_CONFIG_CONTENT!) as {
        mcp: { harness_evidence: { type: string; enabled: boolean; cwd: string; command: string[] } };
        agent: Record<string, { mode: string; permission: Record<string, unknown> }>;
      };
      const builder = configuration.agent[args[args.indexOf('--agent') + 1]!]!;
      assert.equal(builder.mode, 'primary');
      assert.equal(builder.permission.bash, 'deny');
      assert.equal(builder.permission.grep, 'deny');
      assert.equal(builder.permission['*'], 'deny');
      assert.deepEqual(Object.keys(builder.permission).filter((name) => name.startsWith('harness_evidence_')).sort(), toolNames.map((name) => `harness_evidence_${name}`));
      for (const name of toolNames) assert.equal(builder.permission[`harness_evidence_${name}`], 'allow');
      for (const agent of Object.values(configuration.agent).filter((agent) => agent.mode === 'subagent')) {
        assert.equal(agent.permission.bash, 'deny');
        assert.equal(agent.permission.grep, 'deny');
        assert.equal(agent.permission.edit, 'deny');
      }
      const mcp = configuration.mcp.harness_evidence;
      assert.equal(mcp.type, 'local');
      assert.equal(mcp.enabled, true);
      assert.deepEqual(mcp.command.slice(0, 4), [process.execPath, '--import', 'tsx', fileURLToPath(new URL('../src/evidenceMcp.ts', import.meta.url))]);
      assert.equal(mcp.command.length, 8);
      assert.equal(mcp.command[4], '--manifest');
      assert.equal(mcp.command[6], '--sha256');
      const manifestPath = mcp.command[5]!;
      const manifestSha = mcp.command[7]!;
      assert.equal(digest(await readFile(manifestPath)), manifestSha.replace(/^sha256:/, ''));
      const access = await loadEvidenceInvocation(manifestPath, manifestSha);
      assert.equal(access.manifest.scope.currentArtifactDirectory, await realpath(f.artifacts));
      assert.equal(access.manifest.scope.plannerSource, await realpath(f.worktree));
      assert.equal(access.manifest.turn, f.state.turnCount + 1);

      const client = new Client({ name: 'investigator-context-integration', version: '1' });
      const transport = new StdioClientTransport({ command: mcp.command[0]!, args: mcp.command.slice(1), cwd: mcp.cwd,
        env: evidenceHelperEnvironment(), stderr: 'pipe' });
      try {
        await client.connect(transport);
        assert.equal(client.getServerVersion()?.name, 'harness_evidence');
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), toolNames);
        for (const tool of tools.tools) assert.equal(tool.inputSchema.additionalProperties, false);
        const call = async (name: string, query: Record<string, unknown>) => payload(await client.callTool({ name, arguments: query }) as CallToolResult);
        const context = await call('read_evidence', { evidenceRef: briefing.referenceHandles.context, limit: 65_536 });
        assert.equal(context.nextOffset, null);
        const contextDocument = JSON.parse(context.items.map((item: { text: string }) => item.text).join(''));
        assert.deepEqual(contextDocument.currentHypothesis, hypothesis);
        assert.equal(contextDocument.goal, f.campaign.config.goal);
        assert.deepEqual(contextDocument.primaryRawArtifactIndex, ['primary/replicate-1/analysis.json']);
        assert.ok(contextDocument.actions.every((action: Record<string, unknown>) => !Object.hasOwn(action, 'result')));
        assert.equal(JSON.stringify(contextDocument).includes(rawMarker), false);
        const receipt = await call('read_evidence', { evidenceRef: briefing.referenceHandles.feedback, offset: 0, limit: 4_096 });
        assert.ok(receipt.nextOffset > 0);
        assert.equal(receipt.evidenceKind, 'receipt');
        assert.match(receipt.items[0].text, /ARCHIVED_RESULT_RATIONALE/);
        const listed = await call('list_observations', { kind: 'observation' });
        const trial = listed.items.find((row: Record<string, unknown>) => row.actionId === 'action-002');
        assert.ok(trial?.snapshotRef);
        assert.equal(trial.evidenceRef, briefing.referenceHandles.feedback);
        const comparison = await call('compare_trial', { snapshotRef: trial.snapshotRef });
        assert.equal(comparison.totalMatched, 125);
        assert.equal(comparison.summary.changedUnitCount, 1);
        assert.deepEqual(comparison.recordedScores.trial, f.score);
        const inspected = await call('inspect_unit', { unitRef: comparison.items[0].unitRef });
        assert.equal(inspected.returnedCount, 2);
        assert.ok(inspected.items.every((item: Record<string, unknown>) => item.decision === 'build'));
        const denied = await client.callTool({ name: 'read_evidence', arguments: { evidenceRef: f.receiptPath } }) as CallToolResult;
        assert.equal(denied.isError, true);
      } finally { await client.close(); }
      const stdout = [
        { type: 'text', sessionID: sessionId, part: { text: JSON.stringify(requestedAction) } },
        { type: 'step_finish', sessionID: sessionId, part: { reason: 'stop', tokens: { total: 17 }, cost: 0 } },
      ].map((event) => JSON.stringify(event)).join('\n');
      return { command, args: [...args], exitCode: 0, stdout, stderr: '', durationMs: 1 };
    });
    const response = await runner.investigate(f.variant, f.worktree, f.artifacts, f.contextPath, f.state, { error: failure }, (id) => sessions.push(id));
    assert.equal(calls, 1);
    assert.deepEqual(response.action, requestedAction);
    assert.deepEqual(response.usage, { tokens: 17, costUsd: 0 });
    assert.deepEqual(sessions, [sessionId]);
    assert.equal(JSON.stringify(f.state), originalState);
    assert.equal(JSON.stringify(f.database.getVariant(f.variant.id).investigation), persistedState);
    assert.deepEqual(await readFile(f.contextPath), originalContext);
    assert.equal(digest(await readFile(f.receiptPath)), receiptHash);
    assert.deepEqual(await readdir(f.worktree), [], 'temporary briefing attachments are removed');
    t.diagnostic(JSON.stringify({ mode, stateBytes: Buffer.byteLength(originalState), attachmentBytes }));
  });
}

test('invalid inherited authorization fails before creating any turn or evidence artifacts', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const runner = new AgentRunner(f.campaign, async () => { calls++; throw new Error('must not dispatch a model'); });
  const before = (await readdir(f.artifacts, { recursive: true })).sort();
  for (const [configuration, expected] of [
    ['{invalid', /invalid inherited OPENCODE_CONFIG_CONTENT/i],
    [JSON.stringify({ permission: 'deny' }), /denies tool access/i],
    [JSON.stringify({ permission: { '*': 'deny' } }), /denies tool access/i],
  ] as const) {
    process.env.OPENCODE_CONFIG_CONTENT = configuration;
    await assert.rejects(runner.investigate(f.variant, f.worktree, f.artifacts, f.contextPath, f.state, { error: failure }), expected);
    assert.equal(calls, 0);
    assert.deepEqual((await readdir(f.artifacts, { recursive: true })).sort(), before, 'authorization failure must not leave turn context or manifests');
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(f.worktree), []);
});
