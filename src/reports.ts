import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CampaignRecord,
  LabelRecord,
  TargetExcludedConfig,
  TargetExcludedEvaluationRecord,
  VariantRecord,
} from './types.js';
import type { HarnessPaths } from './paths.js';
import { campaignReportDirectory } from './paths.js';
import { compareCohort } from './metrics.js';

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

function signedDelta(value: number | null, baseline: number | null, percent = false): string {
  if (value === null || baseline === null) return 'unavailable';
  const delta = value - baseline;
  const rendered = percent ? `${(delta * 100).toFixed(1)} pp` : String(delta);
  return delta > 0 ? `+${rendered}` : rendered;
}

function usesStandardPrimaryControl(campaign: CampaignRecord): boolean {
  return campaign.config.targetExcluded?.protocol === 'standard-primary-v2';
}

function renderAssumptions(variant: VariantRecord, parent?: VariantRecord | null): string {
  if (variant.hypothesis.assumptions.length === 0) {
    return 'No explicit assumptions were captured for this legacy hypothesis.';
  }
  const authority = parent
    ? 'They are model-generated and unverified.'
    : 'They are harness-authored baseline assumptions, not measured facts.';
  return `These assumptions were recorded before execution. ${authority}\n\n${variant.hypothesis.assumptions
    .map((assumption) => `- ${markdown(assumption)}`)
    .join('\n')}`;
}

function renderObservedIssues(variant: VariantRecord, parent?: VariantRecord | null): string {
  if (!parent) {
    return 'This is a baseline observation with no parent diagnosis. No causal issue is asserted.';
  }
  const snapshottedFindings = variant.hypothesis.findingSnapshots ?? [];
  const legacyFallback = snapshottedFindings.length === 0 && variant.hypothesis.findingIds.length > 0;
  const findings = legacyFallback
    ? parent.diagnosis?.findings.filter(({ id }) => variant.hypothesis.findingIds.includes(id)) ?? []
    : snapshottedFindings;
  if (findings.length === 0) {
    return variant.hypothesis.findingIds.length === 0
      ? 'No parent diagnosis finding was selected for this experiment.'
      : `The selected finding IDs were not available in the parent diagnosis: ${variant.hypothesis.findingIds.map((id) => `\`${id}\``).join(', ')}.`;
  }
  return findings
    .map(
      (finding) => `### ${markdown(finding.id)}: ${markdown(finding.category)}

Authority: \`${legacyFallback ? 'legacy_current_parent_diagnosis' : 'unverified_model_judgment'}\`

${legacyFallback ? 'This legacy experiment predates finding snapshots. The displayed parent finding was not preregistered and may change after re-diagnosis.\n\n' : ''}${quote(finding.causalMechanism)}

Proposed generic intervention: ${markdown(finding.genericIntervention)}

Supporting evidence: ${finding.supportingEvidenceRefs.map((id) => `\`${id}\``).join(', ')}

Counterevidence: ${finding.counterEvidenceRefs.map((id) => `\`${id}\``).join(', ')}

Falsification: ${markdown(finding.falsificationTest)}

Limitations: ${finding.limitations.map((limitation) => markdown(limitation)).join('; ')}`,
    )
    .join('\n\n');
}

function renderBaselineMetrics(variant: VariantRecord, parent?: VariantRecord | null): string {
  if (!parent) {
    return 'No parent metrics exist. This experiment establishes a campaign-local baseline.';
  }
  const metrics = [
    ['Build units', parent.facts?.decisions.build ?? null, variant.facts?.decisions.build ?? null, false],
    ['Reuse units', parent.facts?.decisions.reuse ?? null, variant.facts?.decisions.reuse ?? null, false],
    ['Extend units', parent.facts?.decisions.extend ?? null, variant.facts?.decisions.extend ?? null, false],
    ['Defer units', parent.facts?.decisions.defer ?? null, variant.facts?.decisions.defer ?? null, false],
    ['Question units', parent.facts?.decisions.question ?? null, variant.facts?.decisions.question ?? null, false],
    ['Decision agreement', parent.facts?.decisionAgreement ?? null, variant.facts?.decisionAgreement ?? null, true],
    ['Selected source references', parent.facts?.evidence.selectedSourceRefs ?? null, variant.facts?.evidence.selectedSourceRefs ?? null, false],
    ['Verified accuracy', parent.score?.verified.accuracy ?? null, variant.score?.verified.accuracy ?? null, true],
    ['Provisional accuracy', parent.score?.provisional.accuracy ?? null, variant.score?.provisional.accuracy ?? null, true],
  ] as const;
  const value = (metric: number | null, percent: boolean): string =>
    metric === null ? 'unavailable' : percent ? percentage(metric) : String(metric);
  return `| Metric | Parent | Observed | Delta |
| --- | ---: | ---: | ---: |
${metrics
    .map(
      ([label, baseline, observed, percent]) =>
        `| ${label} | ${value(baseline, percent)} | ${value(observed, percent)} | ${signedDelta(observed, baseline, percent)} |`,
    )
    .join('\n')}`;
}

function renderArms(
  campaign: CampaignRecord,
  variant: VariantRecord,
  targetExcluded?: TargetExcludedEvaluationRecord | null,
): string {
  const standardPrimaryControl = Boolean(targetExcluded && usesStandardPrimaryControl(campaign));
  const rows: Array<[string, string, VariantRecord['facts']]> = [
    [
      standardPrimaryControl ? 'Standard primary (comparison control)' : 'Standard',
      standardPrimaryControl
        ? 'reference (standard measurement)'
        : variant.facts
          ? 'measured'
          : 'pending',
      variant.facts,
    ],
  ];
  if (targetExcluded) {
    if (!standardPrimaryControl) {
      rows.push([
        'Target-safe control',
        targetExcluded.controlFacts ? 'measured' : targetExcluded.status,
        targetExcluded.controlFacts,
      ]);
    }
    rows.push([
      'Target-excluded',
      targetExcluded.excludedFacts ? 'measured' : targetExcluded.status,
      targetExcluded.excludedFacts,
    ]);
  }
  return `| Arm | Status | Units | Build | Reuse | Extend | Defer | Question | Agreement |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows
    .map(
      ([arm, status, facts]) =>
        `| ${arm} | ${status} | ${facts?.unitCount ?? 'unavailable'} | ${facts?.decisions.build ?? 'unavailable'} | ${facts?.decisions.reuse ?? 'unavailable'} | ${facts?.decisions.extend ?? 'unavailable'} | ${facts?.decisions.defer ?? 'unavailable'} | ${facts?.decisions.question ?? 'unavailable'} | ${facts ? percentage(facts.decisionAgreement) : 'unavailable'} |`,
    )
    .join('\n')}

${targetExcluded ? standardPrimaryControl ? 'The standard primary measurement is referenced as comparison normal. No additional control execution was run. The excluded arm is a promotion guard, not a fitness reward.' : 'The control and excluded arms use the same target-safe pack. The excluded arm is a promotion guard, not a fitness reward.' : 'No target-safe control or target-excluded result is available for this experiment.'}`;
}

function renderConclusion(
  variant: VariantRecord,
  parent?: VariantRecord | null,
  targetExcluded?: TargetExcludedEvaluationRecord | null,
  labels: readonly LabelRecord[] = [],
  standardPrimaryControl = false,
): string {
  if (!variant.facts) {
    return `Status: \`pending\`\n\nNo measured conclusion is available while the experiment is ${variant.status}.`;
  }
  const statements = [
    'This section is generated from persisted measurements. It does not treat model diagnosis or blind-judge suggestions as verified truth.',
  ];
  if (!parent) {
    statements.push('This run establishes a baseline observation; it does not establish that the planner decisions are correct or that the planner improved.');
  } else if (!parent.facts) {
    statements.push('The result is inconclusive because the parent has no complete measured facts.');
  } else {
    const mismatches = compareCohort(parent.facts, variant.facts);
    statements.push(
      mismatches.length === 0
        ? 'The parent and candidate requirement cohorts are comparable. The measured deltas above are descriptive until correctness is human-verified.'
        : `The result is not causally comparable with its parent because of: ${mismatches.join(', ')}.`,
    );
  }
  if (!variant.score) {
    statements.push(`Correctness could not be scored because judging did not produce a score. The campaign currently has ${labels.filter(({ status }) => status === 'verified').length} verified labels.`);
  } else if (variant.score.verified.labeled === 0) {
    statements.push('Correctness remains unverified because no human-verified labels score this experiment. Provisional accuracy is an LLM suggestion only.');
  } else {
    statements.push(`Verified accuracy is ${percentage(variant.score.verified.accuracy)} across ${variant.score.verified.labeled} human-reviewed units.`);
  }
  if (variant.diagnosisStatus !== 'completed') {
    statements.push(`Causal interpretation is not final because diagnosis status is ${variant.diagnosisStatus}.`);
  }
  if (targetExcluded) {
    statements.push(
      targetExcluded.status === 'completed'
        ? `The target-excluded promotion guard is ${targetExcluded.gate?.status ?? 'pending'}.`
        : standardPrimaryControl
          ? `The standard-primary reference and target-excluded comparison is ${targetExcluded.status}; the conclusion is incomplete until it finishes.`
          : `The target-safe control and target-excluded comparison is ${targetExcluded.status}; the conclusion is incomplete until it finishes.`,
    );
  }
  return `Status: \`${variant.status === 'failed' ? 'failed' : 'measured'}\`\n\n${statements.join('\n\n')}`;
}

function renderEvidenceLedger(
  paths: HarnessPaths,
  campaign: CampaignRecord,
  variant: VariantRecord,
  labels: readonly LabelRecord[],
  parent: VariantRecord | null | undefined,
  targetExcluded: TargetExcludedEvaluationRecord | null | undefined,
  humanNotesPresent: boolean,
): string {
  const primary = campaign.config.benchmarks.find(({ role }) => role === 'primary')?.name ?? 'primary';
  const root = path.join(paths.artifacts, campaign.id, variant.id);
  const rows = [
    ['Frozen campaign inputs', 'observed_durable', path.join(paths.campaigns, campaign.id, 'campaign.json'), 'hash-pinned'],
    ['Current measured facts', 'observed_durable', `${root}/${primary}/facts.json`, variant.facts ? (variant.artifactCollectionComplete ? 'archived' : 'pending archive') : 'unavailable'],
  ];
  if (parent) {
    rows.push([
      'Parent measured facts',
      'observed_durable',
      path.join(paths.artifacts, campaign.id, parent.id, primary, 'facts.json'),
      parent.facts ? (parent.artifactCollectionComplete ? 'archived' : 'pending archive') : 'unavailable',
    ]);
  }
  if (variant.diagnosisInputHash) {
    rows.push([
      'Diagnosis input',
      'deterministic_reconstruction',
      `${root}/diagnosis/diagnosis-input-${variant.diagnosisInputHash.slice(7)}.json`,
      variant.diagnosisStatus,
    ]);
  }
  if (variant.diagnosisInputHash && variant.diagnosisResultHash) {
    rows.push([
      'Model diagnosis',
      'model_inference',
      `${root}/diagnosis/diagnosis-result-${variant.diagnosisInputHash.slice(7)}.json`,
      variant.diagnosisStatus,
    ]);
  }
  if (targetExcluded) {
    rows.push([
      'Target-excluded comparisons',
      'deterministic_reconstruction',
      `${root}/target-excluded/comparisons/`,
      targetExcluded.status,
    ]);
  }
  rows.push([
    'Human labels',
    'human_verified',
    paths.database,
    `${labels.filter(({ status }) => status === 'verified').length} verified`,
  ]);
  if (humanNotesPresent) {
    rows.push([
      'Human notes',
      'human_authored_context',
      path.join(campaignReportDirectory(paths, campaign.id), 'human', `${variant.id}.md`),
      'tracked sidecar',
    ]);
  }
  return `| Evidence | Authority | Locator | Integrity/status |
| --- | --- | --- | --- |
${rows.map(([name, authority, locator, integrity]) => `| ${name} | \`${authority}\` | \`${locator}\` | ${integrity} |`).join('\n')}`;
}

async function readHumanNotes(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function renderTargetExcludedGuard(
  campaign: CampaignRecord,
  targetExcluded?: TargetExcludedEvaluationRecord | null,
): string {
  if (!targetExcluded) return 'Not configured or not run for this variant.';
  const decisions = (facts: TargetExcludedEvaluationRecord['excludedFacts']): string =>
    facts
      ? `build=${facts.decisions.build}, reuse=${facts.decisions.reuse}, extend=${facts.decisions.extend}, defer=${facts.decisions.defer}, question=${facts.decisions.question}`
      : 'unavailable';
  const standardPrimaryControl = usesStandardPrimaryControl(campaign);
  const binding = targetExcluded.normalArmBinding;
  const comparisonCase = (caseId: string | null): string => caseId ?? 'unavailable';
  const comparisonCases =
    targetExcluded.comparisons
      ?.map(
        ({ replicate, normalCaseId, excludedCaseId, normalRunId, excludedRunId }) =>
          `replicate ${replicate}: normal case \`${comparisonCase(normalCaseId)}\` run \`${comparisonCase(normalRunId)}\`, excluded case \`${comparisonCase(excludedCaseId)}\` run \`${comparisonCase(excludedRunId)}\``,
      )
      .join('; ') || 'unavailable';
  const armDetails = standardPrimaryControl
    ? `Protocol: \`standard-primary-v2\`

Standard primary (comparison control) reference: ${
        binding
          ? `benchmark \`${binding.benchmark}\`, resolved artifact \`${binding.resolvedArtifactSha}\`, lineage ${binding.replicates.map(({ replicate, caseId, runId }) => `replicate ${replicate} case \`${caseId}\` run \`${runId}\``).join('; ')}`
          : 'unavailable'
      }

No additional control execution was run; the standard primary measurement is reused as comparison normal.

Excluded decisions: ${decisions(targetExcluded.excludedFacts)}`
    : `Control decisions: ${decisions(targetExcluded.controlFacts)}

Excluded decisions: ${decisions(targetExcluded.excludedFacts)}`;
  const questions =
    targetExcluded.questionResolution?.entries
      .filter((entry) => entry.arm)
      .map(
        (entry) =>
          `- ${entry.arm}: ${markdown(entry.question)} -> ${markdown(entry.answer)} (${entry.resolution})`,
      )
      .join('\n') || 'No target-arm runtime question was recorded.';
  return `Status: \`${targetExcluded.status}\`

Gate: \`${targetExcluded.gate?.status ?? 'pending'}\`

Baseline mean build rate: ${percentage(targetExcluded.gate?.baselineMeanBuildRate ?? null)}

Candidate mean build rate: ${percentage(targetExcluded.gate?.candidateMeanBuildRate ?? null)}

Build-rate drop: ${percentage(targetExcluded.gate?.buildDropRatio ?? null)}

Pair validity: ${targetExcluded.comparisons?.length && targetExcluded.comparisons.every((comparison) => comparison.valid) ? 'valid' : 'invalid or pending'}

Leakage paths: ${targetExcluded.comparisons?.reduce((total, comparison) => total + comparison.leakagePaths.length, 0) ?? 0}

${armDetails}

Comparison lineage: ${comparisonCases}

Comparison mismatches: ${targetExcluded.comparisons?.flatMap((comparison) => comparison.mismatches).join('; ') || 'none'}

Recorded error: ${targetExcluded.error ? `\`${markdown(targetExcluded.error)}\`` : 'none'}

Target-arm questions: ${targetExcluded.questionResolution?.plannerQuestions ?? 0}

${questions}

This arm is a promotion guard, not a fitness reward. Target-blind labels and suggestions remain separate from normal evaluation truth.`;
}

async function readHistoricalExperiments(experimentsRoot: string): Promise<Array<Record<string, unknown>>> {
  const historyPath = path.join(experimentsRoot, 'history');
  let historyDetails;
  try {
    historyDetails = await lstat(historyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (historyDetails.isSymbolicLink() || !historyDetails.isDirectory()) {
    throw new Error('historical research root must be a real directory');
  }
  const [reportsRoot, historyRoot] = await Promise.all([
    realpath(experimentsRoot),
    realpath(historyPath),
  ]);
  if (!historyRoot.startsWith(`${reportsRoot}${path.sep}`)) {
    throw new Error('historical research root escapes the reports directory');
  }
  const manifestPath = path.join(historyPath, 'manifest.json');
  let manifestDetails;
  try {
    manifestDetails = await lstat(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
    throw new Error('historical research manifest must be a contained regular file');
  }
  const resolvedManifest = await realpath(manifestPath);
  if (!resolvedManifest.startsWith(`${historyRoot}${path.sep}`)) {
    throw new Error('historical research manifest must be a contained regular file');
  }
  const manifest = JSON.parse(await readFile(resolvedManifest, 'utf8')) as unknown;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('historical research manifest must be an object');
  }
  const manifestRecord = manifest as Record<string, unknown>;
  if (manifestRecord.schemaVersion !== 1) {
    throw new Error('unsupported historical research manifest version');
  }
  const sourceRepository = manifestRecord.sourceRepository;
  const sourceRevision = manifestRecord.sourceRevision;
  if (typeof sourceRepository !== 'string' || sourceRepository.length === 0) {
    throw new Error('historical research manifest omitted sourceRepository');
  }
  if (typeof sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(sourceRevision)) {
    throw new Error('historical research manifest has an invalid sourceRevision');
  }
  const materials = manifestRecord.materials;
  if (!Array.isArray(materials)) throw new Error('historical research manifest omitted materials');
  const imported = await Promise.all(
    materials.map(async (value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`historical research material ${index} must be an object`);
      }
      const material = value as Record<string, unknown>;
      const relative = material.path;
      const expectedSha = material.sha256;
      if (
        typeof relative !== 'string' ||
        path.isAbsolute(relative) ||
        relative.includes('\\') ||
        relative.split('/').some((segment) => segment === '..') ||
        !relative.startsWith('history/')
      ) {
        throw new Error(`historical research material ${index} has an unsafe path`);
      }
      if (typeof expectedSha !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedSha)) {
        throw new Error(`historical research material ${index} has an invalid hash`);
      }
      if (typeof material.kind !== 'string' || material.comparability !== 'historical_context_only') {
        throw new Error(`historical research material ${index} has invalid authority metadata`);
      }
      const filePath = path.join(experimentsRoot, relative);
      const [resolvedFile, details] = await Promise.all([realpath(filePath), lstat(filePath)]);
      if (
        !resolvedFile.startsWith(`${historyRoot}${path.sep}`) ||
        details.isSymbolicLink() ||
        !details.isFile()
      ) {
        throw new Error(`historical research material escapes its manifest root: ${relative}`);
      }
      const content = await readFile(resolvedFile, 'utf8');
      const actualSha = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (actualSha !== expectedSha) {
        throw new Error(`historical research material hash mismatch: ${relative}`);
      }
      return {
        name: typeof material.name === 'string' ? material.name : path.basename(relative),
        path: relative,
        sha256: expectedSha,
        sourceRepository,
        sourceRevision,
        kind: material.kind,
        comparability: material.comparability,
        content: content.slice(0, 40_000),
        contentBytes: Buffer.byteLength(content),
        contentTruncated: content.length > 40_000,
      };
    }),
  );
  return imported;
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
  targetExcluded?: TargetExcludedEvaluationRecord | null,
  parent?: VariantRecord | null,
): Promise<string> {
  const facts = variant.facts;
  const score = variant.score;
  const diagnosisFindings = variant.diagnosis?.findings
    .map(
      (finding) =>
        `### ${markdown(finding.id)}: ${markdown(finding.category)}\n\nConfidence: \`${finding.confidence}\`\n\n${quote(finding.causalMechanism)}\n\nSupporting evidence: ${finding.supportingEvidenceRefs.map((id) => `\`${id}\``).join(', ')}\n\nCounterevidence: ${finding.counterEvidenceRefs.map((id) => `\`${id}\``).join(', ')}\n\nFalsification: ${finding.falsificationTest}`,
    )
    .join('\n\n');
  const decisionRows = facts
    ? Object.entries(facts.decisions)
        .map(([decision, count]) => `| ${decision} | ${count} |`)
        .join('\n')
    : '| unavailable | unavailable |';
  const filePath = path.join(
    campaignReportDirectory(paths, campaign.id),
    `${String(variant.ordinal).padStart(3, '0')}-${variant.id}.md`,
  );
  const humanNotesPath = path.join(
    campaignReportDirectory(paths, campaign.id),
    'human',
    `${variant.id}.md`,
  );
  const humanNotes = await readHumanNotes(humanNotesPath);
  const standardPrimaryControl = usesStandardPrimaryControl(campaign);
  const output = `# ${markdown(variant.hypothesis.title)}

## Goal

${campaign.config.goal.trim()}

## Base Assumptions

${renderAssumptions(variant, parent)}

## Observed Issues

${renderObservedIssues(variant, parent)}

## Planned Change

${parent ? 'The plan below is model-generated and remains unverified.' : 'The baseline plan below is harness-authored.'} It is recorded before execution so the result can be evaluated against the original intervention.

${quote(variant.hypothesis.rationale)}

Implementation instructions:
${quote(variant.hypothesis.instructions)}

Expected impact: ${markdown(variant.hypothesis.expectedImpact)}

Risk: ${markdown(variant.hypothesis.risk)}

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

## Baseline Metrics

${renderBaselineMetrics(variant, parent)}

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

## Experiment Arms

${renderArms(campaign, variant, targetExcluded)}

## Conclusion

${renderConclusion(variant, parent, targetExcluded, labels, standardPrimaryControl)}

## LLM Suggestion

This section is model-generated interpretation, not verified fact. Per-unit suggestions require human review in the dashboard.

${quote(variant.judgment?.summary ?? 'No blind-judge result is available.')}

## Model-Generated Diagnosis

This diagnosis is unverified model interpretation. It is shown separately from measured output, blind-judge suggestions, and human labels, and it does not contribute to numeric scoring.

Status: \`${variant.diagnosisStatus}\`

Input hash: ${variant.diagnosisInputHash ? `\`${variant.diagnosisInputHash}\`` : 'unavailable'}

Result hash: ${variant.diagnosisResultHash ? `\`${variant.diagnosisResultHash}\`` : 'unavailable'}

${quote(variant.diagnosis?.summary ?? variant.diagnosisError ?? 'No model-generated diagnosis is available.')}

${diagnosisFindings || 'No diagnosis findings are available.'}

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
| Planner human answers | ${resolution.plannerHumanAnswers ?? 0} |

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

## Target-Excluded Guard

${renderTargetExcludedGuard(campaign, targetExcluded)}

## Failure

${variant.error ? `\`${markdown(variant.error)}\`` : 'None recorded.'}

## Evidence Ledger

${renderEvidenceLedger(paths, campaign, variant, labels, parent, targetExcluded, humanNotes !== null)}

## Human Notes

Human-authored notes are contextual and do not become verified scoring truth unless they are also saved as reviewed labels.

${humanNotes ?? 'No human-authored notes have been added.'}

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
  targetConfig?: TargetExcludedConfig | null,
  targetEvaluations: readonly TargetExcludedEvaluationRecord[] = [],
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
- Effective replicate protocol: ${targetConfig ? `${targetConfig.replicates} runs at concurrency ${targetConfig.concurrency}` : `${campaign.config.evaluation.replicates} runs`}
- Target-excluded workflow: ${targetConfig ? `\`${targetConfig.targetImplementationWorkflow}\`` : 'not configured'}
- Target-excluded baseline: ${targetConfig?.baselineVariantId ?? 'not configured'}

## Target-Excluded Evaluations

${
  targetEvaluations.length
    ? targetEvaluations
        .map(
          (evaluation) =>
            `- ${evaluation.variantId}: ${evaluation.status}; gate=${evaluation.gate?.status ?? 'pending'}; build drop=${percentage(evaluation.gate?.buildDropRatio ?? null)}`,
        )
        .join('\n')
    : 'No target-excluded evaluation has run.'
}

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
  targetEvaluations: readonly TargetExcludedEvaluationRecord[] = [],
): Promise<void> {
  const historicalExperiments = await readHistoricalExperiments(experimentsRoot);
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
    labels: labels.map(({ benchmark, unitKey, expectedDecision, classification, rationale, status }) => ({
      benchmark,
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
      diagnosis: {
        status: variant.diagnosisStatus,
        inputSha256: variant.diagnosisInputHash,
        interpretationStatus: variant.diagnosis?.interpretationStatus ?? null,
        summary: variant.diagnosis?.summary ?? null,
        findings:
          variant.diagnosis?.findings.map(
            ({
              id,
              category,
              affectedUnitKeys,
              causalMechanism,
              supportingEvidenceRefs,
              counterEvidenceRefs,
              confidence,
              genericIntervention,
              falsificationTest,
              limitations,
            }) => ({
              id,
              category,
              affectedUnitKeys,
              causalMechanism,
              supportingEvidenceRefs,
              counterEvidenceRefs,
              confidence,
              genericIntervention,
              falsificationTest,
              limitations,
              unverified: true,
            }),
          ) ?? [],
        error: variant.diagnosisError,
      },
      holdouts: Object.fromEntries(
        Object.entries(variant.holdoutFacts ?? {}).map(([name, facts]) => [
          name,
          {
            sampleSize: facts.sampleSize,
            decisionAgreement: facts.decisionAgreement,
            decisions: facts.decisions,
            evidence: facts.evidence,
            score: variant.holdoutScores?.[name] ?? null,
          },
        ]),
      ),
      targetExcluded: (() => {
        const evaluation = targetEvaluations.find((item) => item.variantId === variant.id);
        if (!evaluation) return null;
        return usesStandardPrimaryControl(campaign)
          ? {
              protocol: 'standard-primary-v2' as const,
              status: evaluation.status,
              artifactCollectionComplete: evaluation.artifactCollectionComplete,
              gate: evaluation.gate,
              comparisons: evaluation.comparisons?.map(
                ({
                  replicate,
                  normalCaseId,
                  excludedCaseId,
                  normalRunId,
                  excludedRunId,
                  valid,
                  mismatches,
                  leakagePaths,
                  reportHash,
                }) => ({
                  replicate,
                  normalCaseId: normalCaseId ?? null,
                  excludedCaseId: excludedCaseId ?? null,
                  normalRunId: normalRunId ?? null,
                  excludedRunId: excludedRunId ?? null,
                  valid,
                  mismatches,
                  leakagePaths,
                  reportHash,
                }),
              ),
              normalArmBinding: evaluation.normalArmBinding,
              excludedDecisions: evaluation.excludedFacts?.decisions ?? null,
              score: evaluation.score,
            }
          : {
              status: evaluation.status,
              artifactCollectionComplete: evaluation.artifactCollectionComplete,
              gate: evaluation.gate,
              comparisons: evaluation.comparisons?.map(
                ({
                  replicate,
                  normalCaseId,
                  excludedCaseId,
                  normalRunId,
                  excludedRunId,
                  valid,
                  mismatches,
                  leakagePaths,
                  reportHash,
                }) => ({
                  replicate,
                  normalCaseId: normalCaseId ?? null,
                  excludedCaseId: excludedCaseId ?? null,
                  normalRunId: normalRunId ?? null,
                  excludedRunId: excludedRunId ?? null,
                  valid,
                  mismatches,
                  leakagePaths,
                  reportHash,
                }),
              ),
              controlDecisions: evaluation.controlFacts?.decisions ?? null,
              excludedDecisions: evaluation.excludedFacts?.decisions ?? null,
              score: evaluation.score,
            };
      })(),
      error: variant.error,
    })),
  };
  await atomicWrite(filePath, `${JSON.stringify(history, null, 2)}\n`);
}
