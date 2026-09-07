import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  DiagnosisInputSchema,
  DiagnosisOutputSchema,
  HypothesisSchema,
  JudgeOutputSchema,
  type CampaignRecord,
  type DiagnosisOutput,
  type Hypothesis,
  type JudgeOutput,
  type RunFacts,
  type VariantRecord,
} from './types.js';
import { runCommand } from './process.js';
import { sha256File } from './config.js';
import { diagnosisResultPath, validateDiagnosisFindingReferences } from './diagnosis.js';

const StrategyOutputSchema = z
  .object({
    hypotheses: z.array(HypothesisSchema).min(1).max(3),
  })
  .superRefine((output, context) => {
    for (const [index, hypothesis] of output.hypotheses.entries()) {
      if (hypothesis.assumptions.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['hypotheses', index, 'assumptions'],
          message: 'strategist hypotheses must record at least one assumption',
        });
      }
    }
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

async function writeImmutableText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readFile(filePath, 'utf8').catch(() => null);
  if (existing !== null) {
    if (existing !== content) throw new Error(`immutable agent artifact changed: ${filePath}`);
    return;
  }
  await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
}

export class AgentRunner {
  constructor(
    private readonly campaign: CampaignRecord,
    private readonly commandRunner: typeof runCommand = runCommand,
  ) {}

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
    requireFindingIds = true,
  ): Promise<Hypothesis[]> {
    const prompt = `You are the strategist for a generic requirements-to-builder planner evaluation.

Read the attached campaign history. Propose exactly ${count} independent, bounded hypotheses for the next round. Each hypothesis must address an observed, source-backed failure mechanism rather than optimize decision counts. ${requireFindingIds ? "Every hypothesis must cite one or more real finding IDs from the current parent variant's completed model-generated diagnosis in findingIds. Diagnosis is unverified interpretation: preserve supporting evidence, counterevidence, limitations, and falsification rather than treating it as truth. Do not invent IDs." : 'The campaign explicitly opted out of requiring a current-parent diagnosis. Return an empty findingIds array and rely only on the separately identified measured facts, labels, and limitations in history.'} Record the assumptions that must be true for the proposed intervention to work. Assumptions are model-generated and must remain visibly unverified. Do not add customer names, workflow names, fixed source paths, capability IDs, aliases, or pack-specific rules to production code. Prefer one causal mechanism per hypothesis so the experiment remains attributable.

Return JSON only:
{"hypotheses":[{"title":"...","rationale":"...","instructions":"...","expectedImpact":"...","risk":"...","findingIds":["finding-..."],"assumptions":["..."]}]}`;
    const result = await this.commandRunner(
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
    mutationContextPath: string,
  ): Promise<void> {
    const prompt = `Implement one bounded planner experiment in this disposable git worktree.

Campaign goal:
${this.campaign.config.goal}

Hypothesis:
${JSON.stringify(variant.hypothesis, null, 2)}

Rules:
- Read the attached bounded mutation context. Cite and address only the selected finding IDs; the diagnosis is unverified model interpretation, not established truth. If and only if the context records the campaign's explicit missing-parent opt-out, proceed without diagnosis findings.
- Preserve the cited counterevidence and implement the listed falsification test as a regression test when feasible.
- Investigate the current code before editing.
- Implement only this hypothesis using a generic mechanism.
- Change files only under these configured path prefixes: ${JSON.stringify(this.campaign.config.gates.allowedPathPrefixes)}. Changes outside them are rejected before tests or evaluation; leave cross-surface synchronization for post-promotion integration.
- Never hard-code customer names, workflow names, source paths, aliases, requirement text, or capability IDs.
- Add or update a regression test before fixing the behavior when feasible.
- Do not edit the evaluation harness, campaign data, or experiment reports.
- Do not commit, push, create branches, alter git configuration, or start Docker.
- Do not run host tests; the coordinator runs trusted tests in a networkless builder container.
- Leave all intended changes in the worktree when done.`;
    await writeFile(path.join(artifactDirectory, 'mutator-prompt.txt'), `${prompt}\n`);
    await this.commandRunner(
      this.campaign.config.agent.command,
      this.argumentsFor(prompt, `${variant.id} mutator`, [mutationContextPath], worktree, true),
      {
        cwd: worktree,
        timeoutMs: 1_800_000,
        logPath: path.join(artifactDirectory, 'mutator.jsonl'),
      },
    );
  }

  async diagnose(
    diagnosisInputPath: string,
    inputSha256: string,
    artifactDirectory: string,
    contextDirectory: string,
  ): Promise<DiagnosisOutput> {
    if ((await sha256File(diagnosisInputPath)) !== inputSha256) {
      throw new Error('diagnostician input hash does not match the assembled diagnosis input');
    }
    const diagnosisInput = DiagnosisInputSchema.parse(
      JSON.parse(await readFile(diagnosisInputPath, 'utf8')) as unknown,
    );
    const suffix = inputSha256.slice('sha256:'.length);
    const resultPath = diagnosisResultPath(artifactDirectory, inputSha256);
    const existing = await readFile(resultPath, 'utf8').catch(() => null);
    if (existing !== null) {
      const output = DiagnosisOutputSchema.parse(JSON.parse(existing) as unknown);
      if (output.inputSha256 !== inputSha256) throw new Error('archived diagnosis result is stale');
      validateDiagnosisFindingReferences(output.findings, diagnosisInput);
      return output;
    }
    const prompt = `Act as a read-only diagnostician for a generic requirements-to-builder planner evaluation.

The attached diagnosis input is a deterministic, bounded reconstruction from measured planner artifacts, content-addressed S3 tool transcripts, optional Langfuse telemetry, frozen-source references, replicate facts, blind-judge evidence, and human labels. Durable observations, optional telemetry, deterministic reconstruction, model inference, and missing capture are explicitly tagged and must remain distinct.

The read-only working directory contains the exact frozen planner and workflows checkouts used by the campaign. Inspect those checkouts to explain cited behavior and implementation mechanisms, but treat the attached pins and evidence IDs as the provenance boundary.

Produce a bounded causal diagnosis. Every finding must cite real evidence IDs from the attachment for both supporting evidence and counterevidence. Do not infer that historical V1 hash-only requests or missing unit joins were observed. Do not call the KB unavailable when durable records show successful search/source reads and downstream rejection. Treat blind-judge output and this diagnosis as unverified model interpretation. Findings must be generic, falsifiable, and must not recommend customer names, workflow constants, source paths, aliases, capability IDs, requirement text, or fixed decision distributions in production logic. Do not modify files.

Return JSON only:
{"kind":"ainative-planner-eval/model-diagnosis","schemaVersion":1,"interpretationStatus":"unverified_model_judgment","inputSha256":"${inputSha256}","summary":"...","findings":[{"id":"finding-stable-id","category":"workflow_resolution|source_discovery|candidate_ranking|tool_selection|evidence_hydration|evidence_retention|planner_interpretation|confidence_calibration|replicate_instability|infrastructure|unknown","affectedUnitKeys":["..."],"causalMechanism":"...","supportingEvidenceRefs":["evidence-..."],"counterEvidenceRefs":["evidence-..."],"confidence":"low|medium|high","genericIntervention":"...","falsificationTest":"...","limitations":["..."],"provenance":"model_inference"}],"limitations":["..."]}`;
    const promptPath = path.join(
      artifactDirectory,
      'diagnosis',
      `diagnosis-prompt-${suffix}.txt`,
    );
    await writeImmutableText(promptPath, `${prompt}\n`);
    const result = await this.commandRunner(
      this.campaign.config.agent.command,
      this.argumentsFor(
        prompt,
        `${this.campaign.id} read-only diagnostician`,
        [diagnosisInputPath],
        contextDirectory,
      ),
      {
        cwd: contextDirectory,
        timeoutMs: 1_800_000,
        logPath: path.join(artifactDirectory, 'diagnosis', `diagnosis-${suffix}.jsonl`),
      },
    );
    let output: DiagnosisOutput;
    try {
      output = parseJsonResponse(result.stdout, DiagnosisOutputSchema);
    } catch {
      const repairPrompt = `${prompt}\n\nYour previous response did not satisfy the required JSON contract. Return exactly one corrected JSON object. Preserve only real evidence IDs and unit keys from the attached diagnosis input; do not narrate progress or tool use.`;
      const repaired = await this.commandRunner(
        this.campaign.config.agent.command,
        this.argumentsFor(
          repairPrompt,
          `${this.campaign.id} diagnostician repair`,
          [diagnosisInputPath],
          contextDirectory,
        ),
        {
          cwd: contextDirectory,
          timeoutMs: 1_800_000,
          logPath: path.join(artifactDirectory, 'diagnosis', `diagnosis-${suffix}-repair.jsonl`),
        },
      );
      output = parseJsonResponse(repaired.stdout, DiagnosisOutputSchema);
    }
    if (output.inputSha256 !== inputSha256) {
      throw new Error('diagnostician returned a result for another input hash');
    }
    validateDiagnosisFindingReferences(output.findings, diagnosisInput);
    await writeImmutableText(resultPath, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  }

  async judge(
    variant: VariantRecord,
    workflowsSource: string,
    factsPath: string,
    artifactDirectory: string,
    targetExcluded = false,
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

The attached chunk contains requirement units and the planner's decisions. Independently inspect this exact frozen workflows source checkout when evidence is needed. ${targetExcluded ? 'The checkout is a target-excluded snapshot: the target implementation and every direct registration reference were deliberately removed. Judge only against shared or other-workflow source that remains, and never infer that removed source exists.' : ''} You must not infer expected decisions from aggregate counts. For each unit, suggest the expected decision and classify the observed result as a system_error, real_gap, or uncertain. A real_gap means implementation genuinely does not already satisfy the requirement. A system_error means the planner missed, misread, or overclaimed existing capability. Be conservative about reuse: private or partial implementation generally supports extend, not reuse.

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
        const result = await this.commandRunner(
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
        const repairPrompt = `Repair one blind-judge chunk. Return exactly one verdict object for each input unit key, with no duplicates and no other keys. Independently verify the expected decision against this frozen workflows source. ${targetExcluded ? 'This is a target-excluded snapshot; use only the shared or other-workflow source that remains and do not infer removed target source.' : ''} Do not return a map or shorthand. Every verdict must contain unitKey, expectedDecision, classification, confidence, rationale, and a non-empty evidence array.

Return JSON only in this exact shape:
{"summary":"concise repair summary","verdicts":[{"unitKey":"exact input key","expectedDecision":"build|reuse|extend|defer|question","classification":"system_error|real_gap|uncertain","confidence":"low|medium|high","rationale":"source-grounded reason","evidence":["path:line or exact source fact"]}]}

REPAIR INPUT JSON:
${JSON.stringify({ units: repairUnits })}`;
        const repaired = await this.commandRunner(
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
    options: { mode?: 'source-grounded' | 'pm-simulation' } = {},
  ): Promise<SourceQuestionAnswer> {
    const prompt =
      options.mode === 'pm-simulation'
        ? `Answer one blocking requirements question for an evaluation run by simulating the product manager responsible for the frozen implementation.

Question:
${JSON.stringify(input, null, 2)}

Inspect the full frozen implementation as private context. Act like a real PM supplying the intended product or operational decision, informed by what the product actually implements and operates. Return a concise human answer with a maximum of 3 sentences. If no defensible intended decision can be determined, return unresolved.

The answer is planner-visible. Do not put source paths, symbols, capability IDs, workflow identity, or implementation narration in the answer. The evidence field remains required and may cite exact source paths for harness-only audit. Evidence is never planner-visible.

Return JSON only:
{"resolution":"answered","answer":"...","selectedOptionId":"only when selecting one supplied option","evidence":["path:line or exact source fact"]}
or
{"resolution":"unresolved","reason":"...","evidence":["path:line or exact source fact"]}`
        : `Answer one blocking requirements question for an evaluation run by inspecting the exact frozen workflows source.

Question:
${JSON.stringify(input, null, 2)}

Use only behavior and deployment facts proven by source. Keep the answer concise and directly usable as a requirements answer. Do not invent endpoint URLs, credentials, customer policy, or production configuration absent from source. If source proves the environment, access surface, and read/write boundary but leaves an exact endpoint or secret to deployment configuration, return answered with those proven facts and explicitly say the remaining value is deployment-provided. Return unresolved only when source cannot establish the implementation's operational behavior or a safe read/write boundary at all.

Return JSON only:
{"resolution":"answered","answer":"...","selectedOptionId":"only when selecting one supplied option","evidence":["path:line or exact source fact"]}
or
{"resolution":"unresolved","reason":"...","evidence":["path:line or exact source fact"]}`;
    const result = await this.commandRunner(
      this.campaign.config.agent.command,
      this.argumentsFor(prompt, `${this.campaign.id} upstream source answer`, [], workflowsSource),
      {
        cwd: workflowsSource,
        timeoutMs: 1_800_000,
        logPath: path.join(artifactDirectory, `source-answer-${input.id}.jsonl`),
      },
    );
    try {
      return parseJsonResponse(result.stdout, SourceQuestionAnswerSchema);
    } catch {
      const repaired = await this.commandRunner(
        this.campaign.config.agent.command,
        this.argumentsFor(
          `${prompt}\n\nYour previous response was not valid JSON. Do not narrate progress or tool use. Complete the source inspection and return exactly one JSON object matching one of the required shapes.`,
          `${this.campaign.id} upstream source answer repair`,
          [],
          workflowsSource,
        ),
        {
          cwd: workflowsSource,
          timeoutMs: 1_800_000,
          logPath: path.join(artifactDirectory, `source-answer-${input.id}-repair.jsonl`),
        },
      );
      return parseJsonResponse(repaired.stdout, SourceQuestionAnswerSchema);
    }
  }
}
