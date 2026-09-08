import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { HarnessDatabase } from '../src/db.js';
import { canonicalHash } from '../src/metrics.js';
import { CampaignOrchestrator, selectedOptionIdForAnswer } from '../src/orchestrator.js';
import { harnessPaths } from '../src/paths.js';
import { PlannerClient, type Phase2QuestionAnswer, type Phase2Result, type PlannerQuestionRecord } from '../src/plannerClient.js';
import { answerWithRuntimeLedger, runtimeQuestionCacheKey } from '../src/runtimeAnswerLedger.js';
import { CampaignConfigSchema, type Benchmark, type CampaignRecord, type VariantRecord } from '../src/types.js';

const question: PlannerQuestionRecord = {
  id: 'question-original', createdByRunId: 'run-original', responseKind: 'single_select',
  prompt: 'Which validation applies?', rationale: 'Clarify validation.', context: {}, status: 'open',
  type: 'product', ownerRole: 'pm', coverageIds: ['unit-a'],
  options: [
    { id: 'old-a', label: 'Strict', description: 'Validate before submission', consequences: 'Reject invalid input' },
    { id: 'old-b', label: 'Permissive', description: 'Accept submission', consequences: 'Validate later' },
  ],
};
const answer: Phase2QuestionAnswer = {
  answer: 'Use strict validation for submitted fields.', selectedOptionId: 'old-a',
  resolution: 'pm_simulation', evidence: ['original product rationale'], requirementsAgentRequests: 2,
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-answer-ledger-'));
  const database = new HarnessDatabase(path.join(root, 'harness.sqlite'));
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const config = CampaignConfigSchema.parse({
    id: 'ledger-test', goal: 'Freeze repeated product answers without claiming verified truth.',
    plannerRepo: root, workflowsRepo: root, environmentFile: path.join(root, 'environment.env'),
    seedRevision: 'seed', workflowsRevision: 'workflows', investigator: { enabled: true },
    benchmarks: [
      { name: 'primary', role: 'primary', zipPath: path.join(root, 'original.zip'), sha256: `sha256:${'a'.repeat(64)}` },
      { name: 'holdout', role: 'holdout', zipPath: path.join(root, 'holdout.zip') },
    ],
  });
  const campaign = database.createCampaign(config, 's'.repeat(40), 'w'.repeat(40), `sha256:${'e'.repeat(64)}`, 'fixture');
  const variant = database.createVariant({ id: 'ledger-test-v000', campaignId: campaign.id,
    parentVariantId: null, round: 0, ordinal: 0, hypothesis: {
      title: 'Fixture', rationale: 'Test answer reuse', instructions: 'No live runs', expectedImpact: 'Stable answers', risk: 'Not truth',
    } });
  const input: Parameters<typeof answerWithRuntimeLedger>[0] = {
    campaign, database, campaignDirectory: path.join(root, 'campaign'),
    benchmark: { ...config.benchmarks[0]!, zipPath: path.join(root, 'resolved.zip'), sha256: `sha256:${'b'.repeat(64)}` },
    artifactDirectory: path.join(root, 'baseline'), variantId: variant.id,
    executionBenchmark: 'primary', replicate: 1, question, requirementsAgentRequests: 2,
    selectOption: selectedOptionIdForAnswer, resolve: async () => structuredClone(answer),
  };
  const entries = async () => await readdir(path.join(input.campaignDirectory, 'runtime-answer-ledger'));
  const receipts = async (directory = input.artifactDirectory) => await Promise.all(
    (await readdir(path.join(directory, 'runtime-answer-ledger'))).map(async (file) =>
      JSON.parse(await readFile(path.join(directory, 'runtime-answer-ledger', file), 'utf8'))),
  );
  return { root, database, input, entries, receipts, variant };
}

test('freezes answers across baseline, primary trials and final runs with original provenance and run receipts', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.input.resolve = async () => { calls += 1; return structuredClone(answer); };
  assert.deepEqual(await answerWithRuntimeLedger(f.input), answer);
  for (const run of ['primary-trial-1', 'primary-trial-2', 'final']) {
    const directory = path.join(f.root, run);
    const reused = await answerWithRuntimeLedger({ ...f.input, artifactDirectory: directory,
      question: { ...question, id: run, createdByRunId: run }, requirementsAgentRequests: 0 });
    assert.deepEqual(reused, { ...answer, resolution: 'reused_source_answer', requirementsAgentRequests: 0 });
    const [receipt] = await f.receipts(directory);
    assert.equal(receipt.status, 'reused_ledger_entry');
    assert.equal(receipt.origin.runId, question.createdByRunId);
    assert.equal(receipt.run.runId, run);
    assert.match(receipt.comparisonNote, /not.*decision sets/i);
  }
  assert.equal(calls, 1);
  const [filename] = await f.entries();
  const entry = JSON.parse(await readFile(path.join(f.input.campaignDirectory, 'runtime-answer-ledger', filename!), 'utf8'));
  assert.deepEqual(entry.answer, answer);
  assert.equal(entry.input.resolvedPackSha, f.input.benchmark.sha256);
  assert.notEqual(entry.input.resolvedPackSha, f.input.campaign.config.benchmarks[0]!.sha256);
  const [receipt] = await f.receipts();
  assert.equal(receipt.status, 'new_ledger_entry');
  assert.match(receipt.comparisonNote, /new ledger entr/i);
  assert.match(receipt.comparisonNote, /not.*verified/i);
});

test('coalesces concurrent callers and remaps IDs by option semantics, even when old IDs now mean something else', async (t) => {
  const f = await fixture(t);
  let release!: (value: Phase2QuestionAnswer) => void;
  const pending = new Promise<Phase2QuestionAnswer>((resolve) => { release = resolve; });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let calls = 0;
  f.input.resolve = async () => { calls += 1; signalStarted(); return await pending; };
  const first = answerWithRuntimeLedger(f.input);
  await started;
  const changedIds = { ...question, id: 'second', createdByRunId: 'second-run', options: [
    { ...question.options![0]!, id: 'new-a' }, { ...question.options![1]!, id: 'old-a' },
  ] };
  const second = answerWithRuntimeLedger({ ...f.input, question: changedIds, artifactDirectory: path.join(f.root, 'second') });
  release(structuredClone(answer));
  const [original, reused] = await Promise.all([first, second]);
  assert.equal(original.selectedOptionId, 'old-a');
  assert.equal(reused.selectedOptionId, 'new-a');
  assert.equal(reused.resolution, 'reused_source_answer');
  assert.equal(calls, 1);
  assert.equal((await f.entries()).length, 1);
});

test('question and option meaning changes do not collide; incidental IDs do not change the semantic key', async (t) => {
  const f = await fixture(t);
  assert.equal(runtimeQuestionCacheKey(question), runtimeQuestionCacheKey({ ...question, id: 'other', createdByRunId: 'other',
    options: question.options!.map((option) => ({ ...option, id: `other-${option.id}` })) }));
  for (const changed of [question, { ...question, prompt: 'Which validation applies on import?' },
    { ...question, coverageIds: ['unit-b'] },
    { ...question, options: [{ ...question.options![0]!, consequences: 'Block all submissions' }, question.options![1]!] },
    { ...question, options: [{ ...question.options![0]!, description: 'Validate on export' }, question.options![1]!] },
  ]) await answerWithRuntimeLedger({ ...f.input, question: changed });
  assert.equal((await f.entries()).length, 5);
});

test('separates resolved pack, benchmark, workflows, model, model variant and target policy contexts but shares V2 arms', async (t) => {
  const f = await fixture(t);
  await answerWithRuntimeLedger(f.input);
  for (const changes of [
    { benchmark: { ...f.input.benchmark, sha256: `sha256:${'c'.repeat(64)}` } },
    { benchmark: { ...f.input.benchmark, name: 'holdout' } },
    { campaign: { ...f.input.campaign, workflowsSha: 'z'.repeat(40) } },
    { campaign: { ...f.input.campaign, config: { ...f.input.campaign.config,
      agent: { ...f.input.campaign.config.agent, model: 'other-model' } } } },
    { campaign: { ...f.input.campaign, config: { ...f.input.campaign.config,
      agent: { ...f.input.campaign.config.agent, variant: 'high' } } } },
    { targetWorkflow: 'product/target-a' }, { targetWorkflow: 'product/target-b' },
  ]) await answerWithRuntimeLedger({ ...f.input, ...changes });
  assert.equal((await f.entries()).length, 8);
  const reused = await answerWithRuntimeLedger({ ...f.input, targetWorkflow: 'product/target-a',
    executionBenchmark: 'primary:excluded', artifactDirectory: path.join(f.root, 'excluded'),
    resolve: async () => { throw new Error('must share V2 product answers'); } });
  assert.equal(reused.resolution, 'reused_source_answer');
});

test('failed, unresolved and invalid option answers are never committed and can be retried', async (t) => {
  const f = await fixture(t);
  const unresolved = { ...answer, resolution: 'unresolved' } as unknown as Phase2QuestionAnswer;
  for (const resolve of [
    async () => { throw new Error('source unavailable'); },
    async () => unresolved,
    async () => ({ ...answer, selectedOptionId: 'missing' }),
    async () => ({ ...answer, answer: '' }),
  ]) {
    await assert.rejects(answerWithRuntimeLedger({ ...f.input, resolve }));
    assert.equal(f.input.database.listEvents(f.input.campaign.id).filter((event) => event.type.startsWith('runtime_answer_ledger.')).length, 0);
  }
  assert.deepEqual(await answerWithRuntimeLedger(f.input), answer);
  assert.equal((await f.entries()).length, 1);
});

test('preserves requirements-agent, source fallback and human provenance without promoting them to verified truth', async (t) => {
  const f = await fixture(t);
  for (const resolution of ['requirements_agent', 'source_fallback', 'human_answer'] as const) {
    const original = { ...answer, resolution };
    assert.deepEqual(await answerWithRuntimeLedger({ ...f.input, question: { ...question, prompt: resolution }, resolve: async () => original }), original);
  }
  assert.equal((await f.entries()).length, 3);
});

test('rejects mutated or missing bound entries, even if an editor updates the self-declared answer hash', async (t) => {
  const f = await fixture(t);
  await answerWithRuntimeLedger(f.input);
  const [filename] = await f.entries();
  const file = path.join(f.input.campaignDirectory, 'runtime-answer-ledger', filename!);
  const bytes = await readFile(file, 'utf8');
  const entry = JSON.parse(bytes);
  entry.answer.answer = 'Changed answer';
  entry.answerHash = canonicalHash(entry.answer);
  await writeFile(file, JSON.stringify(entry));
  await assert.rejects(answerWithRuntimeLedger(f.input), /integrity|hash/i);
  await rm(file);
  await assert.rejects(answerWithRuntimeLedger(f.input), /missing|ENOENT/i);
});

test('rejects an unbound file and input collisions rather than overwriting or adopting it', async (t) => {
  const f = await fixture(t);
  await answerWithRuntimeLedger(f.input);
  const [filename] = await f.entries();
  const file = path.join(f.input.campaignDirectory, 'runtime-answer-ledger', filename!);
  const entry = JSON.parse(await readFile(file, 'utf8'));
  entry.input.questionKey = 'different semantic input';
  entry.inputHash = canonicalHash(entry.input);
  const bytes = JSON.stringify(entry);
  await writeFile(file, bytes);
  const event = f.input.database.listEvents(f.input.campaign.id).find((item) => item.type === 'runtime_answer_ledger.committed')!;
  f.database.database.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(JSON.stringify({
    ...(event.payload as object), fileSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }), event.id);
  await assert.rejects(answerWithRuntimeLedger(f.input), /input|collision/i);
  f.database.database.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  await assert.rejects(answerWithRuntimeLedger(f.input), /unbound/i);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('ordinary campaigns bypass the ledger, and investigator calls require the resolved pack SHA', async (t) => {
  const f = await fixture(t);
  const normal = { ...f.input.campaign, config: { ...f.input.campaign.config, investigator: undefined } };
  assert.deepEqual(await answerWithRuntimeLedger({ ...f.input, campaign: normal }), answer);
  await assert.rejects(f.entries(), /ENOENT/);
  await assert.rejects(answerWithRuntimeLedger({ ...f.input, benchmark: { ...f.input.benchmark, sha256: undefined } }), /resolved.*SHA/i);
});

test('free-text and value answers retain original whitespace and are independent of returned-object mutation', async (t) => {
  const f = await fixture(t);
  const original: Phase2QuestionAnswer = { answer: '  Exact source wording.\n', evidence: ['source'],
    resolution: 'requirements_agent', requirementsAgentRequests: 2 };
  for (const responseKind of ['free_text', 'value'] as const) {
    const input = { ...f.input, question: { ...question, responseKind, options: [] }, resolve: async () => original };
    const first = await answerWithRuntimeLedger(input);
    assert.deepEqual(first, original);
    first.evidence.push('caller mutation');
    const reused = await answerWithRuntimeLedger(input);
    assert.deepEqual(reused, { ...original, resolution: 'reused_source_answer' });
  }
});

test('runBenchmark routes investigator baseline, trial and final callbacks through the same ledger but bypasses ordinary campaigns', async (t) => {
  const f = await fixture(t);
  const orchestrator = new CampaignOrchestrator(harnessPaths(f.root), f.database);
  const internal = orchestrator as unknown as {
    answerRuntimeQuestion: (...args: unknown[]) => Promise<Phase2QuestionAnswer>;
    runBenchmark: (campaign: CampaignRecord, variant: VariantRecord,
      stack: { artifactDirectory: string; baseUrl: string }, benchmark: Benchmark,
      token: undefined, replicate: number, source: string, cache: Map<string, unknown>,
      options: { executionScope: string; answerSourceTargetWorkflow?: string; excludedTargetWorkflow?: string },
    ) => Promise<Phase2Result>;
  };
  const resolver = t.mock.method(internal, 'answerRuntimeQuestion', async () => structuredClone(answer));
  t.mock.method(PlannerClient.prototype, 'health', async () => ({}));
  const observed: Phase2QuestionAnswer[] = [];
  t.mock.method(PlannerClient.prototype, 'runPhase2', async (...args: Parameters<PlannerClient['runPhase2']>): Promise<Phase2Result> => {
    assert.equal(args[3], f.input.benchmark.sha256);
    const current = { ...question, id: `q-${observed.length}`, createdByRunId: `run-${observed.length}` };
    observed.push(await args[4]!({ question: current, consultations: [] }));
    return { caseId: 'case', runId: current.createdByRunId, status: 'completed', facts: null, questions: [] };
  });
  for (const scope of ['baseline', 'primary-trial', 'final', 'excluded']) {
    await internal.runBenchmark(f.input.campaign, f.variant,
      { artifactDirectory: path.join(f.root, scope), baseUrl: 'http://unused.invalid' },
      f.input.benchmark, undefined, 1, f.root, new Map(), { executionScope: scope,
        answerSourceTargetWorkflow: 'product/target',
        ...(scope === 'excluded' ? { excludedTargetWorkflow: 'product/target' } : {}) });
  }
  assert.equal(resolver.mock.callCount(), 1);
  assert.deepEqual(observed.map((item) => item.resolution), ['pm_simulation', 'reused_source_answer', 'reused_source_answer', 'reused_source_answer']);
  const events = f.database.listEvents(f.input.campaign.id);
  assert.equal(events.filter((event) => event.type === 'runtime_answer_ledger.committed').length, 1);
  assert.equal(events.filter((event) => event.type === 'runtime_answer_ledger.used').length, 4);
  const normal = { ...f.input.campaign, config: { ...f.input.campaign.config, investigator: { enabled: false,
    maxTurns: 1, maxPrimaryEvaluations: 1, maxWallTimeMs: 60_000, maxAgentTokens: 100 } } };
  await internal.runBenchmark(normal, f.variant,
    { artifactDirectory: path.join(f.root, 'ordinary'), baseUrl: 'http://unused.invalid' },
    f.input.benchmark, undefined, 1, f.root, new Map(), { executionScope: 'ordinary' });
  assert.equal(resolver.mock.callCount(), 2);
  assert.equal(observed.at(-1)!.resolution, 'pm_simulation');
  assert.equal(f.database.listEvents(f.input.campaign.id).filter((event) => event.type.startsWith('runtime_answer_ledger.')).length, 5);
});
