import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  HypothesisSchema,
  JudgeOutputSchema,
  type CampaignRecord,
  type Hypothesis,
  type JudgeOutput,
  type RunFacts,
  type VariantRecord,
} from './types.js';
import { runCommand } from './process.js';

const StrategyOutputSchema = z.object({
  hypotheses: z.array(HypothesisSchema).min(1).max(3),
});

const SourceQuestionAnswerSchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal('answered'),
    answer: z.string().min(1).max(4_000),
    selectedOptionId: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(10),
  }),
  z.object({
    resolution: z.literal('unresolved'),
    reason: z.string().min(1).max(2_000),
    evidence: z.array(z.string().min(1).max(1_000)).max(10),
  }),
]);
export type SourceQuestionAnswer = z.infer<typeof SourceQuestionAnswerSchema>;

function extractTextFromEvents(stdout: string): string {
  const values: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const part = event.part;
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        values.push((part as { text: string }).text);
      } else if (typeof event.text === 'string') {
        values.push(event.text);
      }
    } catch {
      // Preserve compatibility with default-formatted output if the CLI changes its event envelope.
    }
  }
  return values.length > 0 ? values.join('') : stdout;
}

function parseJsonResponse<T>(stdout: string, schema: z.ZodType<T>): T {
  const text = extractTextFromEvents(stdout).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim();
  const candidates = [fenced, text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      return schema.parse(JSON.parse(candidate) as unknown);
    } catch {
      // Try the next representation and report one stable error below.
    }
  }
  throw new Error(`agent returned invalid structured output: ${text.slice(0, 2_000)}`);
}

export class AgentRunner {
  constructor(private readonly campaign: CampaignRecord) {}

  private argumentsFor(
    prompt: string,
    title: string,
    attachments: readonly string[],
    directory: string,
    allowAutoApprove = false,
  ): string[] {
    const args = [
      'run',
      '--pure',
      '--model',
      this.campaign.config.agent.model,
      '--format',
      'json',
      '--title',
      title,
      '--dir',
      directory,
    ];
    if (this.campaign.config.agent.variant) {
      args.push('--variant', this.campaign.config.agent.variant);
    }
    if (allowAutoApprove && this.campaign.config.agent.autoApprove) args.push('--auto');
    args.push(prompt);
    for (const attachment of attachments) args.push('--file', attachment);
    return args;
  }

  async proposeHypotheses(
    contextDirectory: string,
    historyPath: string,
    count: number,
  ): Promise<Hypothesis[]> {
    const prompt = `You are the strategist for a generic requirements-to-builder planner evaluation.

Read the attached campaign history. Propose exactly ${count} independent, bounded hypotheses for the next round. Each hypothesis must address an observed, source-backed failure mechanism rather than optimize decision counts. Do not add customer names, workflow names, fixed source paths, capability IDs, aliases, or pack-specific rules to production code. Prefer one causal mechanism per hypothesis so the experiment remains attributable.

Return JSON only:
{"hypotheses":[{"title":"...","rationale":"...","instructions":"...","expectedImpact":"...","risk":"..."}]}`;
    const result = await runCommand(
      this.campaign.config.agent.command,
      this.argumentsFor(prompt, `${this.campaign.id} strategist`, [historyPath], contextDirectory),
      {
        cwd: contextDirectory,
        timeoutMs: 900_000,
        logPath: path.join(contextDirectory, 'strategist.jsonl'),
      },
    );
    const output = parseJsonResponse(result.stdout, StrategyOutputSchema);
    if (output.hypotheses.length !== count) {
      throw new Error(`strategist returned ${output.hypotheses.length} hypotheses; expected ${count}`);
    }
    return output.hypotheses;
  }

  async mutate(
    variant: VariantRecord,
    worktree: string,
    artifactDirectory: string,
  ): Promise<void> {
    const prompt = `Implement one bounded planner experiment in this disposable git worktree.

Campaign goal:
${this.campaign.config.goal}

Hypothesis:
${JSON.stringify(variant.hypothesis, null, 2)}

Rules:
- Investigate the current code before editing.
- Implement only this hypothesis using a generic mechanism.
- Never hard-code customer names, workflow names, source paths, aliases, requirement text, or capability IDs.
- Add or update a regression test before fixing the behavior when feasible.
- Do not edit the evaluation harness, campaign data, or experiment reports.
- Do not commit, push, create branches, alter git configuration, or start Docker.
- Do not run host tests; the coordinator runs trusted tests in a networkless builder container.
- Leave all intended changes in the worktree when done.`;
    await writeFile(path.join(artifactDirectory, 'mutator-prompt.txt'), `${prompt}\n`);
    await runCommand(
      this.campaign.config.agent.command,
      this.argumentsFor(prompt, `${variant.id} mutator`, [], worktree, true),
      {
        cwd: worktree,
        timeoutMs: 1_800_000,
        logPath: path.join(artifactDirectory, 'mutator.jsonl'),
      },
    );
  }

  async judge(
    variant: VariantRecord,
    workflowsSource: string,
    factsPath: string,
    artifactDirectory: string,
  ): Promise<JudgeOutput> {
    const facts = JSON.parse(await readFile(factsPath, 'utf8')) as RunFacts;
    const chunks = Array.from({ length: Math.ceil(facts.units.length / 20) }, (_, index) =>
      facts.units.slice(index * 20, (index + 1) * 20),
    );
    if (chunks.length === 0) throw new Error('blind judge received no requirement units');
    const results: Array<JudgeOutput | undefined> = new Array(chunks.length);
    let nextChunk = 0;
    const worker = async (): Promise<void> => {
      while (nextChunk < chunks.length) {
        const index = nextChunk;
        nextChunk += 1;
        const chunkPath = path.join(artifactDirectory, `judge-input-${index + 1}.json`);
        await writeFile(
          chunkPath,
          `${JSON.stringify(
            {
              status: facts.status,
              sampleSize: facts.sampleSize,
              decisionAgreement: facts.decisionAgreement,
              pins: facts.pins,
              units: chunks[index],
            },
            null,
            2,
          )}\n`,
        );
        const chunkPayload = JSON.stringify({
          status: facts.status,
          sampleSize: facts.sampleSize,
          decisionAgreement: facts.decisionAgreement,
          pins: facts.pins,
          units: chunks[index],
        });
        const prompt = `Act as a blind Phase 2 evaluation judge.

The attached chunk contains requirement units and the planner's decisions. Independently inspect this exact frozen workflows source checkout when evidence is needed. You must not infer expected decisions from aggregate counts. For each unit, suggest the expected decision and classify the observed result as a system_error, real_gap, or uncertain. A real_gap means implementation genuinely does not already satisfy the requirement. A system_error means the planner missed, misread, or overclaimed existing capability. Be conservative about reuse: private or partial implementation generally supports extend, not reuse.

You cannot see the experiment hypothesis or planner diff. Do not modify files. Return every input unit exactly once as JSON only:
{"summary":"...","verdicts":[{"unitKey":"...","expectedDecision":"build|reuse|extend|defer|question","classification":"system_error|real_gap|uncertain","confidence":"low|medium|high","rationale":"...","evidence":["path or fact"]}]}

CHUNK INPUT JSON:
${chunkPayload}`;
        await writeFile(path.join(artifactDirectory, `judge-prompt-${index + 1}.txt`), `${prompt}\n`);
        const logPath = path.join(artifactDirectory, `judge-${index + 1}.jsonl`);
        if ((await stat(logPath).catch(() => null))?.isFile()) {
          try {
            results[index] = parseJsonResponse(await readFile(logPath, 'utf8'), JudgeOutputSchema);
            continue;
          } catch {
            // Preserve the original log and repair its structured result below.
          }
        }
        const result = await runCommand(
          this.campaign.config.agent.command,
          this.argumentsFor(
            prompt,
            `${variant.id} blind judge ${index + 1}/${chunks.length}`,
            [],
            workflowsSource,
          ),
          {
            cwd: workflowsSource,
            timeoutMs: 1_800_000,
            logPath,
          },
        );
        results[index] = parseJsonResponse(result.stdout, JudgeOutputSchema);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, worker));
    for (const [index, units] of chunks.entries()) {
      const result = results[index];
      if (!result) throw new Error(`blind judge chunk ${index + 1} returned no result`);
      const expected = new Set(units.map((unit) => unit.key));
      const counts = new Map<string, number>();
      for (const verdict of result.verdicts) {
        counts.set(verdict.unitKey, (counts.get(verdict.unitKey) ?? 0) + 1);
      }
      const repairKeys = new Set([
        ...[...expected].filter((key) => (counts.get(key) ?? 0) !== 1),
        ...[...counts].filter(([key, count]) => expected.has(key) && count > 1).map(([key]) => key),
      ]);
      const valid = result.verdicts.filter(
        (verdict) => expected.has(verdict.unitKey) && !repairKeys.has(verdict.unitKey),
      );
      if (repairKeys.size > 0) {
        const repairUnits = units.filter((unit) => repairKeys.has(unit.key));
        const repairPath = path.join(artifactDirectory, `judge-repair-input-${index + 1}.json`);
        await writeFile(repairPath, `${JSON.stringify({ units: repairUnits }, null, 2)}\n`);
        const repairPrompt = `Repair one blind-judge chunk. Return exactly one verdict object for each input unit key, with no duplicates and no other keys. Independently verify the expected decision against this frozen workflows source. Do not return a map or shorthand. Every verdict must contain unitKey, expectedDecision, classification, confidence, rationale, and a non-empty evidence array.

Return JSON only in this exact shape:
{"summary":"concise repair summary","verdicts":[{"unitKey":"exact input key","expectedDecision":"build|reuse|extend|defer|question","classification":"system_error|real_gap|uncertain","confidence":"low|medium|high","rationale":"source-grounded reason","evidence":["path:line or exact source fact"]}]}

REPAIR INPUT JSON:
${JSON.stringify({ units: repairUnits })}`;
        const repaired = await runCommand(
          this.campaign.config.agent.command,
          this.argumentsFor(
            repairPrompt,
            `${variant.id} blind judge repair ${index + 1}`,
            [],
            workflowsSource,
          ),
          {
            cwd: workflowsSource,
            timeoutMs: 1_800_000,
            logPath: path.join(artifactDirectory, `judge-repair-${index + 1}.jsonl`),
          },
        );
        const repair = parseJsonResponse(repaired.stdout, JudgeOutputSchema);
        const repairCounts = new Map<string, number>();
        for (const verdict of repair.verdicts) {
          repairCounts.set(verdict.unitKey, (repairCounts.get(verdict.unitKey) ?? 0) + 1);
        }
        if (
          repair.verdicts.length !== repairUnits.length ||
          repairUnits.some((unit) => repairCounts.get(unit.key) !== 1)
        ) {
          throw new Error(`blind judge repair ${index + 1} did not return the exact unit set`);
        }
        results[index] = {
          summary: `${result.summary} Repair: ${repair.summary}`.slice(0, 8_000),
          verdicts: [...valid, ...repair.verdicts],
        };
      } else if (valid.length !== expected.size) {
        throw new Error(`blind judge chunk ${index + 1} returned unexpected unit keys`);
      } else {
        results[index] = { ...result, verdicts: valid };
      }
      await writeFile(
        path.join(artifactDirectory, `judge-result-${index + 1}.json`),
        `${JSON.stringify(results[index], null, 2)}\n`,
      );
    }
    return JudgeOutputSchema.parse({
      summary: results
        .map((result, index) => `Chunk ${index + 1}: ${result?.summary ?? 'missing'}`)
        .join('\n')
        .slice(0, 8_000),
      verdicts: results.flatMap((result) => result?.verdicts ?? []),
    });
  }

  async answerUpstreamQuestion(
    input: {
      id: string;
      question: string;
      entity?: string;
      anchor?: string;
      type: string;
      options: Array<{ id: string; label: string; description: string; outcome?: string }>;
    },
    workflowsSource: string,
    artifactDirectory: string,
  ): Promise<SourceQuestionAnswer> {
    const prompt = `Answer one blocking requirements question for an evaluation run by inspecting the exact frozen workflows source.

Question:
${JSON.stringify(input, null, 2)}

Use only behavior and deployment facts proven by source. Keep the answer concise and directly usable as a requirements answer. Do not invent endpoint URLs, credentials, customer policy, or production configuration absent from source. If source proves the environment, access surface, and read/write boundary but leaves an exact endpoint or secret to deployment configuration, return answered with those proven facts and explicitly say the remaining value is deployment-provided. Return unresolved only when source cannot establish the implementation's operational behavior or a safe read/write boundary at all.

Return JSON only:
{"resolution":"answered","answer":"...","selectedOptionId":"only when selecting one supplied option","evidence":["path:line or exact source fact"]}
or
{"resolution":"unresolved","reason":"...","evidence":["path:line or exact source fact"]}`;
    const result = await runCommand(
      this.campaign.config.agent.command,
      this.argumentsFor(prompt, `${this.campaign.id} upstream source answer`, [], workflowsSource),
      {
        cwd: workflowsSource,
        timeoutMs: 1_800_000,
        logPath: path.join(artifactDirectory, `source-answer-${input.id}.jsonl`),
      },
    );
    return parseJsonResponse(result.stdout, SourceQuestionAnswerSchema);
  }
}
