import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { HarnessDatabase } from './db.js';
import { canonicalHash } from './metrics.js';
import type { Phase2QuestionAnswer, PlannerQuestionRecord } from './plannerClient.js';
import { containsTargetIdentityLeak } from './targetExcludedSource.js';
import type { Benchmark, CampaignRecord } from './types.js';
import { SOURCE_ANSWER_POLICY_VERSION } from './sourceAnswer.js';

// Bump when the runtime answer prompt, resolution order, or source-answer policy changes.
export const ANSWER_POLICY_VERSION = 'requirements-agent-then-scoped-pm-v2';
const COMMIT_EVENT = 'runtime_answer_ledger.committed';
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const answerSchema = z.object({
  answer: z.string().refine((value) => value.trim().length > 0),
  selectedOptionId: z.string().min(1).optional(),
  resolution: z.enum(['requirements_agent', 'source_fallback', 'pm_simulation', 'human_answer']),
  evidence: z.array(z.string()),
  requirementsAgentRequests: z.number().int().nonnegative(),
}).strict();
const runSchema = z.object({
  variantId: z.string(), benchmark: z.string(), replicate: z.number().int().positive(),
  runId: z.string(), questionId: z.string(), artifactDirectory: z.string(),
}).strict();
const entrySchema = z.object({
  schemaVersion: z.literal(1), key: hashSchema, input: z.record(z.string(), z.unknown()),
  inputHash: hashSchema, answer: answerSchema, answerHash: hashSchema,
  selectedOptionIndex: z.number().int().nonnegative().nullable(),
  origin: runSchema, createdAt: z.string(),
}).strict();
const bindingSchema = z.object({
  key: hashSchema, inputHash: hashSchema, answerHash: hashSchema, fileSha256: hashSchema,
}).strict();
type LedgerEntry = z.infer<typeof entrySchema>;
type BoundEntry = { entry: LedgerEntry; fileSha256: string; created: boolean };

// The campaign lease supplies single-process ownership; wx also refuses competing writers.
// Keep only in-flight work here so every subsequent reuse checks disk against the DB event.
const pending = new Map<string, Promise<BoundEntry>>();

export function runtimeQuestionCacheKey(question: PlannerQuestionRecord): string {
  return JSON.stringify({
    responseKind: question.responseKind,
    prompt: question.prompt,
    rationale: question.rationale,
    requirementRefs: (question.requirementRefs ?? []).map(({ entity, anchor }) => ({ entity, anchor }))
      .sort((left, right) => left.entity.localeCompare(right.entity) || left.anchor.localeCompare(right.anchor)),
    sourceContext: question.sourceContext ?? {},
    type: question.type,
    ownerRole: question.ownerRole,
    coverageIds: question.coverageIds,
    options: question.options?.map(({ label, description, consequences }) => ({
      label,
      description: description ?? null,
      consequences: consequences ?? null,
    })),
  });
}

export async function answerWithRuntimeLedger(options: {
  campaign: CampaignRecord;
  benchmark: Benchmark;
  database: Pick<HarnessDatabase, 'addEvent' | 'listEvents'>;
  campaignDirectory: string;
  artifactDirectory: string;
  variantId: string;
  executionBenchmark: string;
  replicate: number;
  question: PlannerQuestionRecord;
  requirementsAgentRequests: number;
  targetWorkflow?: string | undefined;
  selectOption: (question: PlannerQuestionRecord, answer: string, previousOptionId?: string) => string | undefined;
  resolve: () => Promise<Phase2QuestionAnswer>;
}): Promise<Phase2QuestionAnswer> {
  const { campaign, benchmark, database, question, targetWorkflow } = options;
  if (!campaign.config.investigator?.enabled) return await options.resolve();
  if (!benchmark.sha256?.match(/^sha256:[a-f0-9]{64}$/)) {
    throw new Error('runtime answer ledger requires the execution benchmark resolved pack SHA');
  }
  const input = {
    campaignId: campaign.id,
    benchmark: benchmark.name,
    resolvedPackSha: benchmark.sha256,
    workflowsSha: campaign.workflowsSha,
    environmentSha: campaign.environmentSha,
    model: campaign.config.agent.model,
    modelVariant: campaign.config.agent.variant ?? null,
    policyVersion: ANSWER_POLICY_VERSION,
    sourceAnswerPolicyVersion: SOURCE_ANSWER_POLICY_VERSION,
    answerSourcePolicy: 'full-workflows-product-answers',
    targetWorkflow: targetWorkflow ?? null,
    questionKey: runtimeQuestionCacheKey(question),
  };
  const key = canonicalHash(input);
  const ledgerDirectory = path.resolve(options.campaignDirectory, 'runtime-answer-ledger');
  const file = path.join(ledgerDirectory, `${key.slice('sha256:'.length)}.json`);
  const run = {
    variantId: options.variantId, benchmark: options.executionBenchmark, replicate: options.replicate,
    runId: question.createdByRunId, questionId: question.id, artifactDirectory: options.artifactDirectory,
  };
  let task = pending.get(file);
  const coalesced = Boolean(task);
  if (!task) {
    task = (async (): Promise<BoundEntry> => {
      const bindings = database.listEvents(campaign.id).filter((event) =>
        event.type === COMMIT_EVENT && (event.payload as { key?: unknown } | null)?.key === key);
      if (bindings.length > 1) throw new Error(`runtime answer ledger has conflicting bindings: ${key}`);
      const binding = bindings.length ? bindingSchema.parse(bindings[0]!.payload) : null;
      const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (binding) {
        if (bytes === null) throw new Error(`runtime answer ledger bound entry is missing: ${key}`);
        const fileSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        if (fileSha256 !== binding.fileSha256) throw new Error(`runtime answer ledger integrity hash mismatch: ${key}`);
        const entry = entrySchema.parse(JSON.parse(bytes.toString('utf8')));
        if (entry.key !== key || entry.inputHash !== key || binding.inputHash !== key ||
          canonicalHash(entry.input) !== key || !isDeepStrictEqual(entry.input, input)) {
          throw new Error(`runtime answer ledger input collision or mismatch: ${key}`);
        }
        if (canonicalHash(entry.answer) !== entry.answerHash || binding.answerHash !== entry.answerHash) {
          throw new Error(`runtime answer ledger answer hash mismatch: ${key}`);
        }
        return { entry, fileSha256, created: false };
      }
      // Do not adopt self-authenticated files, including a write interrupted before DB binding.
      if (bytes !== null) throw new Error(`runtime answer ledger has an unbound entry: ${key}`);
      const value = answerSchema.parse(await options.resolve());
      const selectedOptionId = options.selectOption(question, value.answer, value.selectedOptionId);
      if (question.responseKind === 'single_select' && !selectedOptionId) {
        throw new Error(`runtime answer ledger answer did not select an option for ${question.id}`);
      }
      if (targetWorkflow && containsTargetIdentityLeak(value, targetWorkflow)) {
        throw new Error(`runtime answer ledger answer violates target-safe policy for ${question.id}`);
      }
      const selectedOptionIndex = selectedOptionId
        ? question.options?.findIndex(({ id }) => id === selectedOptionId) ?? -1 : -1;
      const entry: LedgerEntry = {
        schemaVersion: 1, key, input, inputHash: key, answer: value, answerHash: canonicalHash(value),
        selectedOptionIndex: selectedOptionIndex >= 0 ? selectedOptionIndex : null,
        origin: run, createdAt: new Date().toISOString(),
      };
      const serialized = `${JSON.stringify(entry, null, 2)}\n`;
      const fileSha256 = `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
      await mkdir(ledgerDirectory, { recursive: true });
      await writeFile(file, serialized, { flag: 'wx' });
      database.addEvent(campaign.id, options.variantId, COMMIT_EVENT, {
        key, inputHash: key, answerHash: entry.answerHash, fileSha256,
      });
      return { entry, fileSha256, created: true };
    })();
    pending.set(file, task);
  }
  try {
    const { entry, fileSha256, created } = await task;
    if (!isDeepStrictEqual(entry.input, input)) throw new Error(`runtime answer ledger input collision: ${key}`);
    const currentOption = entry.selectedOptionIndex === null ? undefined : question.options?.[entry.selectedOptionIndex];
    const selectedOptionId = currentOption
      ? options.selectOption(question, currentOption.label, currentOption.id) : undefined;
    if (question.responseKind === 'single_select' && !selectedOptionId) {
      throw new Error(`runtime answer ledger cannot remap the selected option for ${question.id}`);
    }
    if (targetWorkflow && containsTargetIdentityLeak(entry.answer, targetWorkflow)) {
      throw new Error(`runtime answer ledger answer violates target-safe policy for ${question.id}`);
    }
    const isNew = created && !coalesced;
    const receipt = {
      schemaVersion: 1, key, inputHash: key, answerHash: entry.answerHash, fileSha256,
      status: isNew ? 'new_ledger_entry' : 'reused_ledger_entry', origin: entry.origin, run,
      selectedOptionId: selectedOptionId ?? null,
      comparisonNote: `${isNew ? 'New ledger entry: this run resolved a previously unseen semantic question/context; compare with earlier runs accordingly. ' : ''}` +
        'Only repeated semantic answers are frozen; this does not freeze all decision sets and is not verified product truth.',
    };
    const receiptDirectory = path.join(options.artifactDirectory, 'runtime-answer-ledger');
    const receiptPath = path.join(receiptDirectory, `${key.slice('sha256:'.length)}-${randomUUID()}.json`);
    const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
    await mkdir(receiptDirectory, { recursive: true });
    await writeFile(receiptPath, receiptBytes, { flag: 'wx' });
    database.addEvent(campaign.id, options.variantId, 'runtime_answer_ledger.used', {
      ...receipt, receiptPath, receiptSha256: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}`,
    });
    return {
      answer: entry.answer.answer,
      evidence: [...entry.answer.evidence],
      ...(selectedOptionId ? { selectedOptionId } : {}),
      resolution: isNew ? entry.answer.resolution : 'reused_source_answer',
      requirementsAgentRequests: options.requirementsAgentRequests,
    };
  } finally {
    if (pending.get(file) === task) pending.delete(file);
  }
}
