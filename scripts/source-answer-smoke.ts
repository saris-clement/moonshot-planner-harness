/** Explicitly opt-in, one-question PM integration smoke. GET-only archive access; never submit an answer or open a ledger. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentRunner, type SourceQuestionAnswer } from '../src/agents.js';
import { matchQuestionConsultations, withRuntimeSourceContext } from '../src/orchestrator.js';
import type { PlannerQuestionRecord } from '../src/plannerClient.js';
import { runCommand } from '../src/process.js';
import { SOURCE_ANSWER_POLICY_VERSION, type SourceAnswerQuestionInput } from '../src/sourceAnswer.js';
import { containsTargetIdentityLeak } from '../src/targetExcludedSource.js';
import type { CampaignRecord } from '../src/types.js';

const usage = 'node --import tsx scripts/source-answer-smoke.ts --live --campaign-url http://127.0.0.1:4177 --question-id <id> [--artifacts .data/source-answer-smoke] [--source-root <existing-frozen-workflows>]';
const sha256 = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function main(): Promise<number> {
  const options = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' },
    'campaign-url': { type: 'string' }, 'question-id': { type: 'string' }, artifacts: { type: 'string' }, 'source-root': { type: 'string' } } }).values;
  if (!options.live || options.help) {
    console.log(usage);
    console.log('Disabled without --live. One real PM question, existing two-attempt policy; no planner or ledger submission.');
    return options.help ? 0 : 2;
  }
  const questionId = options['question-id'];
  assert.ok(questionId && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(questionId), 'A safe question ID is required');
  const base = new URL(options['campaign-url'] ?? 'http://127.0.0.1:4177');
  assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password && !base.search && !base.hash, 'Only an unauthenticated loopback dashboard URL is supported');
  const workspace = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const allowed = path.join(workspace, '.data/source-answer-smoke');
  const parent = path.resolve(options.artifacts ?? allowed);
  assert.ok(parent === allowed || parent.startsWith(`${allowed}/`), 'Smoke artifacts must stay under this worktree .data/source-answer-smoke');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assert.ok((await realpath(parent)) === parent, 'Symlinked artifact directories are not supported');
  const root = await mkdtemp(path.join(parent, `${questionId}-${Date.now()}-`));
  const put = async (name: string, value: unknown) => await writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const started = Date.now();
  const report: Record<string, unknown> = { schemaVersion: 1, status: 'failed', interpretation: 'provisional_model_output_not_human_truth',
    questionId, root, startedAt: new Date(started).toISOString(), policyVersion: SOURCE_ANSWER_POLICY_VERSION,
    submittedToPlanner: false, submittedToLedger: false, modelAttempts: [], stage: 'archive_input' };
  console.log(`Private smoke artifacts: ${root}`);
  let output: SourceQuestionAnswer | undefined;
  const get = async (urlPath: string) => {
    const response = await fetch(new URL(urlPath, base.origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, 'Read-only dashboard request failed');
    return await response.json();
  };
  try {
    const requestedCampaign = /\/(?:api\/)?campaigns\/([^/]+)\/?$/.exec(base.pathname)?.[1];
    const campaigns = requestedCampaign ? [{ id: requestedCampaign }] : await get('/api/campaigns') as Array<{ id: string }>;
    assert.equal(campaigns.length, 1, 'Specify a campaign URL when more than one campaign exists');
    const campaignId = campaigns[0]!.id;
    const campaignPath = `/api/campaigns/${encodeURIComponent(campaignId)}`;
    const details = await get(campaignPath) as { campaign: CampaignRecord; variants: Array<{ id: string }>; targetExcludedConfig?: { targetImplementationWorkflow: string } };
    const campaign = details.campaign;
    let selected: { question: PlannerQuestionRecord; consultations: unknown[]; questionPath: string; consultationPath: string; variantId: string } | undefined;
    for (const variant of details.variants) {
      const artifactUrl = `${campaignPath}/variants/${encodeURIComponent(variant.id)}/artifacts`;
      const { files } = await get(artifactUrl) as { files: Array<{ path: string }> };
      for (const file of files.filter(({ path: name }) => /(?:^|\/)planner-questions-\d+\.json$/.test(name)).reverse()) {
        const { questions } = await get(`${artifactUrl}?path=${encodeURIComponent(file.path)}`) as { questions: PlannerQuestionRecord[] };
        const question = questions.find((value) => value.id === questionId && value.status === 'open');
        if (!question) continue;
        const consultationPath = file.path.replace('planner-questions-', 'requirements-consultations-');
        const { consultations } = await get(`${artifactUrl}?path=${encodeURIComponent(consultationPath)}`) as { consultations: unknown[] };
        selected = { question, consultations, questionPath: file.path, consultationPath, variantId: variant.id };
        break;
      }
      if (selected) break;
    }
    assert.ok(selected, 'Original open question and consultation archive not found');
    const matched = matchQuestionConsultations(selected.consultations, selected.question);
    const question = withRuntimeSourceContext(selected.question, selected.consultations);
    assert.ok(matched.length > 0 && question.sourceContext?.workflow, 'Matching workflow context is required for this smoke');
    const sourceRoot = await realpath(options['source-root'] ?? path.join(workspace, '.data/live', campaignId, 'worktrees', campaignId, 'frozen-workflows'));
    const git = async (...args: string[]) => (await runCommand('git', args, { cwd: sourceRoot, timeoutMs: 60_000 })).stdout;
    assert.equal((await git('rev-parse', 'HEAD')).trim(), campaign.workflowsSha, 'Frozen source does not match the campaign pin');
    const before = await git('status', '--porcelain=v1', '-z');
    const targetWorkflow = campaign.config.targetExcluded?.targetImplementationWorkflow ?? details.targetExcludedConfig?.targetImplementationWorkflow;
    assert.ok(targetWorkflow, 'The smoke requires the campaign target-identity guard');
    const input: SourceAnswerQuestionInput = {
      id: question.id, question: question.prompt, rationale: question.rationale, coverageIds: question.coverageIds,
      requirementRefs: question.requirementRefs, entity: question.requirementRefs?.[0]?.entity, anchor: question.requirementRefs?.[0]?.anchor,
      context: question.sourceContext ?? {}, type: question.responseKind,
      options: (question.options ?? []).map((option) => ({ id: option.id, label: option.label, description: option.description ?? option.consequences ?? '' })),
    };
    Object.assign(report, { campaignId, sourceRoot, workflowsSha: campaign.workflowsSha, model: campaign.config.agent.model,
      modelVariant: campaign.config.agent.variant ?? null, matchedConsultations: matched.length, inputSha256: sha256(JSON.stringify(input)),
      questionPath: selected.questionPath, consultationPath: selected.consultationPath, variantId: selected.variantId,
      codePins: Object.fromEntries(await Promise.all(['src/agents.ts', 'src/sourceAnswer.ts', 'src/orchestrator.ts'].map(async (name) => [name, sha256(await readFile(path.join(workspace, name)))]))) });
    await put('original-question.json', selected.question);
    await put('matching-consultations.json', matched);
    await put('smoke-input.json', input);
    report.stage = 'source_answer';
    const attempts = report.modelAttempts as Array<Record<string, unknown>>;
    const runner = new AgentRunner(campaign, async (command, args, invocation) => {
      if (args[0] !== 'run') return await runCommand(command, args, invocation);
      assert.ok(attempts.length < 2, 'Only the existing two attempts are authorized');
      assert.equal(invocation?.timeoutMs, 1_800_000, 'Do not change the source-answer budget');
      const attempt: Record<string, unknown> = { attempt: attempts.length + 1, startedAt: new Date().toISOString(), logPath: invocation?.logPath,
        sessionArgument: args.includes('--session') ? args[args.indexOf('--session') + 1] : null };
      attempts.push(attempt);
      console.log(`PM attempt ${attempts.length} started with the unchanged policy.`);
      const time = Date.now();
      try {
        const value = await runCommand(command, args, invocation);
        attempt.exitCode = value.exitCode;
        return value;
      } finally { attempt.durationMs = Date.now() - time; }
    });
    try { output = await runner.answerUpstreamQuestion(input, sourceRoot, root, { mode: 'pm-simulation' }); }
    finally {
      const statuses = await readdir(path.join(root, `source-answer-${questionId}`)).catch(() => []);
      report.attemptStatuses = await Promise.all(statuses.filter((name) => /^attempt-\d+-status\.json$/.test(name)).sort().map(async (name) =>
        JSON.parse(await readFile(path.join(root, `source-answer-${questionId}`, name), 'utf8'))));
      report.sourceUnchanged = before === await git('status', '--porcelain=v1', '-z') && (await git('rev-parse', 'HEAD')).trim() === campaign.workflowsSha;
    }
    report.stage = 'verification';
    const visible = output.resolution === 'answered' ? output.answer : output.reason;
    report.answerClassification = output.resolution;
    report.targetIdentityLeak = containsTargetIdentityLeak({ answer: visible }, targetWorkflow);
    report.sourcePathLeak = /(?:\b(?:src|server|packages)\/|\/Users\/|\/private\/|\/var\/)/.test(visible);
    report.sentenceCount = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(visible)].filter(({ segment }) => segment.trim()).length;
    const verifiedPath = async (name: string) => {
      const absolute = path.resolve(sourceRoot, name);
      if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}/`)) return false;
      const parts = path.relative(sourceRoot, absolute).split(path.sep).filter(Boolean);
      if (parts.some((part) => /^(?:\.git|\.ssh|\.aws|\.opencode|node_modules|\.npmrc|\.netrc|auth\.json|credentials.*)$|(?:^|\.)env(?:\.|$)|\.(?:pem|key)$|id_(?:rsa|ed25519)/.test(part))) return false;
      let current = sourceRoot;
      for (const part of parts) { current = path.join(current, part); if ((await lstat(current).catch(() => null))?.isSymbolicLink()) return false; }
      const actual = await realpath(absolute).catch(() => null);
      return actual !== null && (actual === sourceRoot || actual.startsWith(`${sourceRoot}/`));
    };
    const toolCalls: Array<Record<string, unknown>> = [];
    for (const attempt of attempts) {
      for await (const line of createInterface({ input: createReadStream(String(attempt.logPath)), crlfDelay: Infinity })) {
        let event: Record<string, unknown>;
        try { event = record(JSON.parse(line)); } catch { continue; }
        if (event.type !== 'tool_use') continue;
        const part = record(event.part); const state = record(part.state); const params = record(state.input);
        const filePath = typeof params.filePath === 'string' ? params.filePath : null;
        toolCalls.push({ attempt: attempt.attempt, sessionId: event.sessionID ?? part.sessionID ?? null, tool: part.tool,
          status: state.status, path: filePath, inAllowedSource: filePath !== null && await verifiedPath(filePath),
          permissionDenied: typeof state.error === 'string' && /permission|denied|rule which prevents/i.test(state.error) });
      }
    }
    const citationChecks = [];
    for (const citation of output.evidence) {
      const references = [];
      for (const match of citation.matchAll(/(\/?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?/g)) {
        const name = match[1]!; const exists = await verifiedPath(name);
        const start = Number(match[2] ?? match[4] ?? 0); const end = Number(match[3] ?? match[5] ?? start);
        const lines = exists && (await lstat(path.resolve(sourceRoot, name))).isFile() ? (await readFile(path.resolve(sourceRoot, name), 'utf8')).split('\n').length : 0;
        references.push({ path: name, exists, start, end, linesValid: exists && lines > 0 && (start === 0 || start >= 1 && end >= start && end <= lines) });
      }
      citationChecks.push({ citation, references, status: references.length ? 'path_checked_not_semantics' : 'no_path_reference_to_check' });
    }
    Object.assign(report, { toolCalls, citationChecks, successfulReadCalls: toolCalls.filter((call) => call.tool === 'read' && call.status === 'completed').length,
      allReadCallsConfined: toolCalls.length > 0 && toolCalls.every((call) => call.tool === 'read' && call.inAllowedSource),
      permissionDeniedCalls: toolCalls.filter((call) => call.permissionDenied).length });
    assert.equal(report.sourceUnchanged, true, 'Frozen source changed');
    assert.equal(report.targetIdentityLeak, false, 'Target identity guard rejected the answer');
    assert.equal(report.sourcePathLeak, false, 'Answer exposed source paths');
    assert.ok(Number(report.sentenceCount) <= 3, 'PM answer exceeded three sentences');
    assert.ok(report.allReadCallsConfined && Number(report.successfulReadCalls) > 0, 'Expected actual read-only source inspection');
    assert.equal(report.permissionDeniedCalls, 0, 'The smoke encountered a permission denial');
    assert.ok(citationChecks.every((citation) => citation.references.every((reference) => reference.linesValid)), 'A cited relative path or line range could not be verified');
    report.status = 'passed';
  } catch (error) {
    const failure = record(record(error).failure);
    report.failure = ['source_answer_no_output', 'source_answer_invalid_output', 'source_answer_execution_failed'].includes(String(failure.code))
      ? { origin: 'harness', code: failure.code, message: failure.message }
      : { origin: 'harness', code: 'source_answer_smoke_failed', message: 'Source answer smoke failed its setup or verification checks.' };
    await put('smoke-cause.json', { errorName: error instanceof Error ? 'Error' : 'UnknownError', sha256: sha256(error instanceof Error ? error.message : typeof error) });
  }
  report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - started;
  await put('receipt.json', report);
  console.log(JSON.stringify({ status: report.status, answerClassification: report.answerClassification ?? null, stage: report.stage,
    durationMs: report.durationMs, attempts: (report.modelAttempts as unknown[]).length, successfulReadCalls: report.successfulReadCalls ?? null,
    failure: report.failure ?? null, receiptPath: path.join(root, 'receipt.json'), resultPath: output ? path.join(root, `source-answer-${questionId}/result.json`) : null }));
  return report.status === 'passed' ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch(() => { console.error('Source answer smoke could not initialize. No answer was submitted.'); process.exitCode = 2; });
