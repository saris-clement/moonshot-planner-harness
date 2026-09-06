import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CampaignRecord, LabelRecord, VariantRecord } from './types.js';
import type { HarnessPaths } from './paths.js';
import { campaignReportDirectory } from './paths.js';

function markdown(value: string): string {
  return value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').trim();
}

function quote(value: string): string {
  return value
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function percentage(value: number | null): string {
  return value === null ? 'unscored' : `${(value * 100).toFixed(1)}%`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, filePath);
}

export async function writeVariantReport(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variant: VariantRecord,
  labels: readonly LabelRecord[],
): Promise<string> {
  const facts = variant.facts;
  const score = variant.score;
  const decisionRows = facts
    ? Object.entries(facts.decisions)
        .map(([decision, count]) => `| ${decision} | ${count} |`)
        .join('\n')
    : '| unavailable | unavailable |';
  const filePath = path.join(
    campaignReportDirectory(paths, campaign.id),
    `${String(variant.ordinal).padStart(3, '0')}-${variant.id}.md`,
  );
  const output = `# ${markdown(variant.hypothesis.title)}

## Goal

${campaign.config.goal.trim()}

## Hypothesis

The hypothesis below is model-generated and remains unverified until the experiment completes.

${quote(variant.hypothesis.rationale)}

Expected impact: ${variant.hypothesis.expectedImpact}

Risk: ${variant.hypothesis.risk}

## Provenance

| Field | Value |
| --- | --- |
| Campaign | ${campaign.id} |
| Variant | ${variant.id} |
| Parent | ${variant.parentVariantId ?? 'none'} |
| Round | ${variant.round} |
| Status | ${variant.status} |
| Planner seed | \`${campaign.seedSha}\` |
| Workflows source | \`${campaign.workflowsSha}\` |
| Environment | \`${campaign.environmentSha}\` |
| Primary pack | \`${campaign.config.benchmarks.find((item) => item.role === 'primary')?.sha256 ?? 'unavailable'}\` |
| Patch | ${variant.patchPath ? `\`${variant.patchPath}\`` : 'none'} |
| Image | ${variant.imageTag ? `\`${variant.imageTag}\`` : 'not built'} |
| Artifact collection | ${variant.artifactCollectionComplete ? 'complete' : 'incomplete'} |

## Actual Facts

| Decision | Count |
| --- | ---: |
${decisionRows}

| Metric | Value |
| --- | ---: |
| Requirement units | ${facts?.unitCount ?? 'unavailable'} |
| Replicates | ${facts?.sampleSize ?? 'unavailable'} |
| Unanimous unit decisions | ${facts ? percentage(facts.decisionAgreement) : 'unavailable'} |
| Empty shortlists | ${facts?.shortlist.empty ?? 'unavailable'} |
| Candidate occurrences | ${facts?.shortlist.candidates ?? 'unavailable'} |
| Discovered evidence | ${facts?.evidence.discovered ?? 'unavailable'} |
| Selected source references | ${facts?.evidence.selectedSourceRefs ?? 'unavailable'} |
| Model calls | ${facts?.usage.calls ?? 'unavailable'} |
| Total tokens | ${facts?.usage.totalTokens ?? 'unavailable'} |
| Cost USD | ${facts?.usage.costUsd.toFixed(4) ?? 'unavailable'} |
| Model duration ms | ${facts?.usage.durationMs ?? 'unavailable'} |

## Evaluation

| Metric | Value |
| --- | ---: |
| Human-verified labels | ${score?.verified.labeled ?? 0} |
| Verified errors | ${score?.verified.errors ?? 0} |
| Verified accuracy | ${percentage(score?.verified.accuracy ?? null)} |
| Provisional labels | ${score?.provisional.labeled ?? 0} |
| Provisional errors | ${score?.provisional.errors ?? 0} |
| Provisional accuracy | ${percentage(score?.provisional.accuracy ?? null)} |
| Persisted labels | ${labels.length} |
| Cohort pin mismatches | ${score?.cohortMismatches.join(', ') || 'none'} |

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

${quote(variant.judgment?.summary ?? 'No blind-judge result is available.')}

## Requirements Questions

${
    variant.questionResolutions
      ? Object.values(variant.questionResolutions)
          .map(
            (resolution) => `### ${resolution.benchmark}

| Metric | Count |
| --- | ---: |
| Blocking questions | ${resolution.blockingQuestions} |
| Requirements-agent requests | ${resolution.requirementsAgentRequests} |
| Requirements-agent answers | ${resolution.requirementsAgentAnswers} |
| Source fallback answers | ${resolution.sourceFallbackAnswers} |
| Reused campaign answers | ${resolution.reusedAnswers} |
| Planner questions | ${resolution.plannerQuestions} |
| Planner requirements-agent requests | ${resolution.plannerRequirementsAgentRequests} |
| Planner requirements-agent answers | ${resolution.plannerRequirementsAgentAnswers} |
| Planner source fallback answers | ${resolution.plannerSourceFallbackAnswers} |
| Planner reused answers | ${resolution.plannerReusedAnswers} |

${
  resolution.entries.length === 0
    ? 'No blocking question required an answer.'
    : resolution.entries
        .map(
          (entry) => `#### ${entry.id}

Resolution: \`${entry.resolution}\`

Question:
${quote(entry.question)}

Answer:
${quote(entry.answer)}

Evidence:
${entry.evidence.map((evidence) => `- ${markdown(evidence)}`).join('\n')}`,
        )
        .join('\n\n')
}`,
          )
          .join('\n\n')
      : 'Question resolution did not run.'
  }

## Holdout

${
    variant.holdoutFacts
      ? Object.entries(variant.holdoutFacts)
          .map(
            ([name, holdout]) =>
              `- ${name}: ${holdout.sampleSize} runs, ${percentage(holdout.decisionAgreement)} unanimous decisions; ${holdout.unitCount} units; build=${holdout.decisions.build}, reuse=${holdout.decisions.reuse}, extend=${holdout.decisions.extend}, defer=${holdout.decisions.defer}, question=${holdout.decisions.question}; verified=${percentage(variant.holdoutScores?.[name]?.verified.accuracy ?? null)}, provisional=${percentage(variant.holdoutScores?.[name]?.provisional.accuracy ?? null)}`,
          )
          .join('\n')
      : 'Not run for this variant.'
  }

## Failure

${variant.error ? `\`${markdown(variant.error)}\`` : 'None recorded.'}

## Artifacts

Raw artifacts, prompts, logs, source excerpts, and model events remain in the ignored local data directory for this variant.
`;
  await atomicWrite(filePath, output);
  return filePath;
}

export async function writeCampaignIndex(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variants: readonly VariantRecord[],
): Promise<string> {
  const directory = campaignReportDirectory(paths, campaign.id);
  const filePath = path.join(directory, 'README.md');
  const rows = variants
    .map(
      (variant) =>
        `| ${variant.ordinal} | ${variant.id} | ${variant.round} | ${markdown(variant.hypothesis.title)} | ${variant.status} | ${percentage(variant.score?.verified.accuracy ?? null)} | ${percentage(variant.score?.provisional.accuracy ?? null)} |`,
    )
    .join('\n');
  const output = `# ${campaign.id}

## Goal

${campaign.config.goal.trim()}

## Frozen Inputs

- Planner seed: \`${campaign.seedSha}\`
- Workflows source: \`${campaign.workflowsSha}\`
- Environment profile: \`${campaign.environmentSha}\`
- Mode: \`${campaign.config.mode}\`
- Concurrency: ${campaign.config.limits.concurrency}
- Replicate concurrency: ${campaign.config.evaluation.replicateConcurrency ?? 2}
- Maximum generated variants: ${campaign.config.limits.maxVariants}

## Experiments

| # | Variant | Round | Hypothesis | Status | Verified | Provisional |
| ---: | --- | ---: | --- | --- | ---: | ---: |
${rows || '| - | - | - | No experiments yet | - | - | - |'}
`;
  await atomicWrite(filePath, output);
  return filePath;
}

export async function writeAgentHistory(
  filePath: string,
  experimentsRoot: string,
  campaign: CampaignRecord,
  variants: readonly VariantRecord[],
  labels: readonly LabelRecord[],
): Promise<void> {
  const historicalExperiments = await Promise.all(
    (await readdir(experimentsRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => ({
        name: entry.name,
        content: (await readFile(path.join(experimentsRoot, entry.name), 'utf8')).slice(0, 40_000),
      })),
  );
  const history = {
    goal: campaign.config.goal,
    genericityConstraints: [
      'No customer or workflow constants in production code.',
      'Prefer a single causal mechanism per experiment.',
      'A lower build count is not itself an improvement.',
      'Human-verified labels outrank LLM suggestions.',
    ],
    frozenInputs: {
      plannerSeed: campaign.seedSha,
      workflowsSource: campaign.workflowsSha,
      environment: campaign.environmentSha,
      benchmarks: campaign.config.benchmarks.map(({ name, role, sha256 }) => ({ name, role, sha256 })),
    },
    historicalExperiments,
    labels: labels.map(({ unitKey, expectedDecision, classification, rationale, status }) => ({
      unitKey,
      expectedDecision,
      classification,
      rationale,
      status,
    })),
    variants: variants.map((variant) => ({
      id: variant.id,
      parent: variant.parentVariantId,
      round: variant.round,
      hypothesis: variant.hypothesis,
      status: variant.status,
      decisions: variant.facts?.decisions,
      evidence: variant.facts?.evidence,
      usage: variant.facts?.usage,
      score: variant.score,
      questionResolutions: variant.questionResolutions,
      judgeSummary: variant.judgment?.summary,
      error: variant.error,
    })),
  };
  await atomicWrite(filePath, `${JSON.stringify(history, null, 2)}\n`);
}
