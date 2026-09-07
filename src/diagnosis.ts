import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './config.js';
import { LangfuseReadClient, type LangfuseCollection } from './langfuse.js';
import { isV2TargetIdentitySourceCandidate } from './targetExcludedSource.js';
import { readFrozenResearchContext } from './research.js';
import {
  DiagnosisInputSchema,
  DiagnosisManifestSchema,
  DiagnosisOutputSchema,
  type CampaignRecord,
  type Decision,
  type DiagnosisCompletenessItem,
  type DiagnosisEvidence,
  type DiagnosisFinding,
  type DiagnosisInput,
  type DiagnosisLineageArm,
  type DiagnosisManifest,
  type DiagnosisOutput,
  type JsonValue,
  type LabelRecord,
  type RunFacts,
  type TargetExcludedEvaluationRecord,
  type TargetExcludedConfig,
  type VariantRecord,
} from './types.js';

type JsonRecord = Record<string, unknown>;

const MAX_JSON_ARTIFACT_BYTES = 16 * 1_024 * 1_024;
const MAX_TRANSCRIPT_CHAINS = 100;
const MAX_TRANSCRIPT_ENTRIES = 2_000;
const MAX_SOURCE_REFS = 100;
const MAX_SOURCE_BYTES = 512 * 1_024;
const MAX_SOURCE_EXCERPT_BYTES = 4_000;
const MAX_FOCUS_UNITS = 30;
const MAX_DIAGNOSIS_INPUT_BYTES = 8 * 1_024 * 1_024;

interface ArtifactInventoryItem {
  path: string;
  sha256: string;
  bytes: number;
  integrity: 'verified' | 'hash_only' | 'unverified';
}

interface JsonArtifact {
  value: unknown;
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface AssembleDiagnosisInput {
  artifactDirectory: string;
  campaign: CampaignRecord;
  variant: VariantRecord;
  labels: readonly LabelRecord[];
  targetExcluded?: TargetExcludedEvaluationRecord | null;
  targetExcludedConfig?: TargetExcludedConfig | null;
  targetExcludedSourceManifestPath?: string | null;
  workflowsSource: string;
  environment: NodeJS.ProcessEnv;
  langfuseClient?: LangfuseReadClient;
}

export interface AssembledDiagnosis {
  input: DiagnosisInput;
  inputPath: string;
  inputSha256: string;
  manifestPath: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function numberField(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === 'number' && Number.isFinite(value[key])
    ? value[key]
    : null;
}

function countField(value: unknown, key: string): number | null {
  const count = numberField(value, key);
  return count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function safeRelativePath(root: string, filePath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`artifact path escapes the variant directory: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function safeObjectKey(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  return value;
}

function sha256Bytes(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function boundedJson(value: unknown, depth = 0): JsonValue {
  if (depth >= 7) return '[truncated-depth]';
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => boundedJson(item, depth + 1));
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 200)
      .map(([key, item]) => [key.slice(0, 256), boundedJson(item, depth + 1)]),
  );
}

async function writeImmutable(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readFile(filePath, 'utf8').catch(() => null);
  if (existing !== null) {
    if (existing !== content) throw new Error(`immutable diagnosis artifact changed: ${filePath}`);
    return;
  }
  await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
}

async function walkFiles(root: string, maximum = 20_000): Promise<string[]> {
  if (!(await stat(root).catch(() => null))?.isDirectory()) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      if (files.length > maximum) throw new Error(`diagnosis artifact scan exceeded ${maximum} files`);
    }
  }
  return files.sort();
}

function collectObjects(
  value: unknown,
  predicate: (candidate: JsonRecord) => boolean,
  maximum = 1_000,
): JsonRecord[] {
  const results: JsonRecord[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0 && results.length < maximum) {
    const current = pending.pop()!;
    if (current.depth > 20) continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(current.value)) continue;
    if (predicate(current.value)) results.push(current.value);
    for (const item of Object.values(current.value)) {
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return results;
}

function evidenceId(key: string): string {
  return `evidence-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function extractLineage(value: unknown): { caseId: string | null; runId: string | null; status: string } {
  const candidates = collectObjects(value, (record) => Boolean(record.caseId || record.runId), 100);
  const caseId =
    stringField(value, 'caseId') ??
    candidates.map((candidate) => stringField(candidate, 'caseId')).find(Boolean) ??
    null;
  const runId =
    stringField(value, 'runId') ??
    candidates.map((candidate) => stringField(candidate, 'runId')).find(Boolean) ??
    null;
  const status = stringField(value, 'status') ?? 'unknown';
  return { caseId, runId, status };
}

function unitKeyMap(facts: RunFacts | null): Map<string, string> {
  return new Map((facts?.units ?? []).map((unit) => [unit.id, unit.key]));
}

function isStandardPrimaryV2(input: AssembleDiagnosisInput): boolean {
  return (
    input.targetExcludedConfig?.protocol === 'standard-primary-v2' ||
    input.campaign.config.targetExcluded?.protocol === 'standard-primary-v2'
  );
}

function targetRunFacts(
  target: TargetExcludedEvaluationRecord | null | undefined,
  standardPrimaryV2 = false,
): RunFacts[] {
  if (!target) return [];
  if (standardPrimaryV2) {
    return [target.excludedFacts, ...(target.excludedReplicateFacts ?? [])].filter(
      (facts): facts is RunFacts => facts !== null,
    );
  }
  return [
    target.controlFacts,
    ...(target.controlReplicateFacts ?? []),
    ...Object.values(target.holdoutFacts ?? {}),
    ...Object.values(target.holdoutReplicateFacts ?? {}).flat(),
    target.excludedFacts,
    ...(target.excludedReplicateFacts ?? []),
  ].filter((facts): facts is RunFacts => facts !== null);
}

interface DiagnosisFactScope {
  benchmark: string;
  role: 'primary' | 'holdout';
  arm: DiagnosisLineageArm;
  facts: RunFacts[];
}

function focusScopeKey(benchmark: string, arm: DiagnosisLineageArm, unitKey: string): string {
  return JSON.stringify([benchmark, arm, unitKey]);
}

function diagnosisFactScopes(input: AssembleDiagnosisInput): DiagnosisFactScope[] {
  const standardPrimaryV2 = isStandardPrimaryV2(input);
  const scopes: DiagnosisFactScope[] = [];
  const add = (
    benchmark: string,
    role: DiagnosisFactScope['role'],
    arm: DiagnosisLineageArm,
    aggregate: RunFacts | null | undefined,
    replicates: RunFacts[] | null | undefined,
  ) => {
    const facts = replicates?.length ? replicates : aggregate ? [aggregate] : [];
    if (facts.length > 0) scopes.push({ benchmark, role, arm, facts });
  };
  for (const benchmark of input.campaign.config.benchmarks) {
    if (benchmark.role === 'primary') {
      add(benchmark.name, benchmark.role, 'standard', input.variant.facts, input.variant.replicateFacts);
    } else {
      add(
        benchmark.name,
        benchmark.role,
        'standard',
        input.variant.holdoutFacts?.[benchmark.name],
        input.variant.holdoutReplicateFacts?.[benchmark.name],
      );
      if (!standardPrimaryV2) {
        add(
          benchmark.name,
          benchmark.role,
          'control',
          input.targetExcluded?.holdoutFacts?.[benchmark.name],
          input.targetExcluded?.holdoutReplicateFacts?.[benchmark.name],
        );
      }
    }
  }
  const primary = input.campaign.config.benchmarks.find(({ role }) => role === 'primary');
  if (primary && input.targetExcluded) {
    if (!standardPrimaryV2) {
      add(
        primary.name,
        primary.role,
        'control',
        input.targetExcluded.controlFacts,
        input.targetExcluded.controlReplicateFacts,
      );
    }
    add(
      primary.name,
      primary.role,
      'excluded',
      input.targetExcluded.excludedFacts,
      input.targetExcluded.excludedReplicateFacts,
    );
  }
  return scopes;
}

function selectFocusUnits(input: AssembleDiagnosisInput): {
  keys: Set<string>;
  scopeKeys: Set<string>;
  candidateCount: number;
  stratumCount: number;
} {
  const scopes = diagnosisFactScopes(input);
  const knownScopes = new Map<string, string>();
  for (const scope of scopes) {
    for (const facts of scope.facts) {
      for (const unit of facts.units) {
        knownScopes.set(focusScopeKey(scope.benchmark, scope.arm, unit.key), unit.key);
      }
    }
  }
  const strata = new Map<string, Set<string>>();
  const add = (stratum: string, scope: DiagnosisFactScope, key: string) => {
    const scopedKey = focusScopeKey(scope.benchmark, scope.arm, key);
    if (!knownScopes.has(scopedKey)) return;
    const scopedKeys = strata.get(stratum) ?? new Set<string>();
    scopedKeys.add(scopedKey);
    strata.set(stratum, scopedKeys);
  };

  for (const scope of scopes) {
    const decisions = new Map<string, Set<Decision>>();
    for (const facts of scope.facts) {
      for (const unit of facts.units) {
        const values = decisions.get(unit.key) ?? new Set<Decision>();
        values.add(unit.decision);
        decisions.set(unit.key, values);
        if (scope.role === 'holdout') add('holdout', scope, unit.key);
        if (scope.arm === 'control') add('target_control', scope, unit.key);
        if (unit.shortlistCandidateCount === 0) add('funnel_no_candidates', scope, unit.key);
        else if (unit.discoveredEvidenceCount === 0) add('funnel_no_discovery', scope, unit.key);
        else if (unit.sourceRefs.length === 0) add('funnel_no_selection', scope, unit.key);
        if (unit.sourceRefs.length > 0) add('source_backed_control', scope, unit.key);
      }
    }
    for (const [key, values] of decisions) {
      if (values.size > 1) add('replicate_disagreement', scope, key);
    }
  }

  const matchingScopes = (benchmark: string): DiagnosisFactScope[] =>
    benchmark === 'target-excluded'
      ? scopes.filter(({ arm }) => arm === 'excluded')
      : scopes.filter(({ benchmark: name, arm }) => name === benchmark && arm === 'standard');
  for (const label of input.labels) {
    for (const scope of matchingScopes(label.benchmark)) {
      const units = scope.facts.flatMap((facts) =>
        facts.units.filter(({ key }) => key === label.unitKey),
      );
      if (units.some(({ decision }) => decision !== label.expectedDecision)) {
        add(
          label.status === 'verified' ? 'verified_mismatch' : 'suggested_mismatch',
          scope,
          label.unitKey,
        );
      } else if (units.length > 0) {
        add('decision_agreement_control', scope, label.unitKey);
      }
    }
  }

  const judgments = [
    ...input.campaign.config.benchmarks.flatMap((benchmark) => {
      const judgment =
        benchmark.role === 'primary'
          ? input.variant.judgment
          : input.variant.holdoutJudgments?.[benchmark.name];
      return judgment ? [{ benchmark: benchmark.name, judgment }] : [];
    }),
    ...(input.targetExcluded?.judgment
      ? [{ benchmark: 'target-excluded', judgment: input.targetExcluded.judgment }]
      : []),
  ];
  for (const { benchmark, judgment } of judgments) {
    for (const verdict of judgment.verdicts) {
      for (const scope of matchingScopes(benchmark)) {
        const units = scope.facts.flatMap((facts) =>
          facts.units.filter(({ key }) => key === verdict.unitKey),
        );
        if (units.some(({ decision }) => decision !== verdict.expectedDecision)) {
          add(
            verdict.classification === 'system_error'
              ? 'judge_system_error'
              : 'judge_other_mismatch',
            scope,
            verdict.unitKey,
          );
        } else if (units.length > 0) {
          add('decision_agreement_control', scope, verdict.unitKey);
        }
      }
    }
  }

  if (strata.size === 0) {
    strata.set('fallback', new Set(knownScopes.keys()));
  }
  const orderedStrata = [
    'verified_mismatch',
    'judge_system_error',
    'funnel_no_candidates',
    'funnel_no_discovery',
    'funnel_no_selection',
    'replicate_disagreement',
    'holdout',
    'target_control',
    'source_backed_control',
    'decision_agreement_control',
    'suggested_mismatch',
    'judge_other_mismatch',
    'fallback',
  ].flatMap((name) => {
    const keys = strata.get(name);
    return keys ? [{ name, keys: [...keys].sort() }] : [];
  });
  const selectedScopes = new Set<string>();
  const offsets = new Map(orderedStrata.map(({ name }) => [name, 0]));
  while (selectedScopes.size < Math.min(MAX_FOCUS_UNITS, knownScopes.size)) {
    let added = false;
    for (const stratum of orderedStrata) {
      let offset = offsets.get(stratum.name) ?? 0;
      while (offset < stratum.keys.length && selectedScopes.has(stratum.keys[offset]!)) offset += 1;
      offsets.set(stratum.name, offset + 1);
      const key = stratum.keys[offset];
      if (!key) continue;
      selectedScopes.add(key);
      added = true;
      if (selectedScopes.size >= MAX_FOCUS_UNITS) break;
    }
    if (!added) break;
  }
  return {
    keys: new Set([...selectedScopes].map((scopedKey) => knownScopes.get(scopedKey)!)),
    scopeKeys: selectedScopes,
    candidateCount: knownScopes.size,
    stratumCount: orderedStrata.length,
  };
}

const FUNNEL_STAGES = [
  'shortlist_candidate',
  'search_hit',
  'qualified_pointer',
  'hydration_attempt',
  'source_read',
  'admitted_evidence',
  'selected_evidence',
] as const;

type FunnelStage = (typeof FUNNEL_STAGES)[number];

function analysisFunnelAggregates(
  benchmark: string,
  role: 'primary' | 'holdout',
  arm: DiagnosisLineageArm,
  replicate: number,
  analysisUnits: JsonRecord[],
  adjudications: JsonRecord[],
): JsonRecord[] {
  const knownUnitIds = new Set(
    analysisUnits.flatMap((unit) => {
      const id = stringField(unit, 'id');
      return id ? [id] : [];
    }),
  );
  const groups = new Map<string, Array<{ adjudication: JsonRecord; unitId: string }>>();
  for (const [index, adjudication] of adjudications.entries()) {
    const disposition = stringField(adjudication, 'result') ?? 'unknown';
    const unitId = stringField(adjudication, 'requirementUnitId') ?? `unknown-${index + 1}`;
    const values = groups.get(disposition) ?? [];
    values.push({ adjudication, unitId });
    groups.set(disposition, values);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([disposition, values]) => {
      const stageValues = new Map<FunnelStage, Array<{ unitId: string; count: number }>>(
        FUNNEL_STAGES.map((stage) => [stage, []]),
      );
      const rejectionReasons = new Map<string, Array<{ unitId: string; count: number }>>();
      const rejectionObservedUnits = new Set<string>();
      for (const { adjudication, unitId } of values) {
        const shortlist = isRecord(adjudication.shortlist) ? adjudication.shortlist : null;
        if (shortlist && Array.isArray(shortlist.candidates)) {
          stageValues.get('shortlist_candidate')!.push({
            unitId,
            count: shortlist.candidates.length,
          });
        }
        const grounding = isRecord(adjudication.evidenceGrounding)
          ? adjudication.evidenceGrounding
          : null;
        if (!grounding) continue;
        const admittedSourceCount = countField(grounding, 'admittedSourceCount');
        const admittedTestCount = countField(grounding, 'admittedTestCount');
        const metrics: Array<[FunnelStage, number | null]> = [
          ['search_hit', countField(grounding, 'searchHitCount')],
          ['qualified_pointer', countField(grounding, 'qualifiedPointerCount')],
          ['hydration_attempt', countField(grounding, 'hydrationAttemptCount')],
          ['source_read', countField(grounding, 'sourceReadCount')],
          [
            'admitted_evidence',
            admittedSourceCount !== null && admittedTestCount !== null
              ? admittedSourceCount + admittedTestCount
              : null,
          ],
          ['selected_evidence', countField(grounding, 'selectedDiscoveredCount')],
        ];
        for (const [stage, count] of metrics) {
          if (count !== null) stageValues.get(stage)!.push({ unitId, count });
        }
        if (!Array.isArray(grounding.rejectionCounts)) continue;
        rejectionObservedUnits.add(unitId);
        for (const rejection of grounding.rejectionCounts.filter(isRecord)) {
          const reason = stringField(rejection, 'reason');
          const count = countField(rejection, 'count');
          if (!reason || count === null) continue;
          const records = rejectionReasons.get(reason) ?? [];
          records.push({ unitId, count });
          rejectionReasons.set(reason, records);
        }
      }
      const stages = FUNNEL_STAGES.map((stage) => {
        const observed = stageValues.get(stage)!;
        return {
          stage,
          occurrences:
            observed.length > 0 ? observed.reduce((sum, item) => sum + item.count, 0) : null,
          affectedUnits:
            observed.length > 0
              ? new Set(observed.filter(({ count }) => count > 0).map(({ unitId }) => unitId)).size
              : null,
          observedUnits: new Set(observed.map(({ unitId }) => unitId)).size,
          totalUnits: values.length,
        };
      });
      return {
        benchmark,
        role,
        arm,
        replicate,
        disposition,
        unitOccurrences: values.length,
        affectedUnits: new Set(values.map(({ unitId }) => unitId)).size,
        analysisUnitCount: knownUnitIds.size,
        stages,
        rejectionReasons: [...rejectionReasons]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, records]) => ({
            reason,
            occurrences: records.reduce((sum, item) => sum + item.count, 0),
            affectedUnits: new Set(records.filter(({ count }) => count > 0).map(({ unitId }) => unitId))
              .size,
          })),
        rejectionCoverage: {
          observedUnits: rejectionObservedUnits.size,
          totalUnits: values.length,
        },
      };
    });
}

function artifactLineageArm(relativeDirectory: string): {
  arm: DiagnosisLineageArm;
  executionScope: string | null;
} {
  const segments = relativeDirectory.split('/');
  const targetIndex = segments.indexOf('target-excluded');
  const targetDepth = targetIndex < 0 ? 0 : segments.length - targetIndex;
  if (targetDepth < 3) return { arm: 'standard', executionScope: null };
  const nestedArm = segments[targetIndex + 1];
  if (targetDepth >= 4 && (nestedArm === 'control' || nestedArm === 'excluded')) {
    return { arm: nestedArm, executionScope: nestedArm };
  }
  return { arm: 'excluded', executionScope: 'target-excluded' };
}

function artifactExecution(
  input: AssembleDiagnosisInput,
  benchmark: string,
  replicate: number,
  arm: DiagnosisLineageArm,
  executionScope: string | null,
) {
  const expectedBenchmark = arm === 'standard' ? benchmark : `${benchmark}:${executionScope}`;
  const executions =
    arm === 'standard'
      ? input.variant.executionState?.executions ?? []
      : [
          ...(input.targetExcluded?.executionState?.executions ?? []),
          ...(input.variant.executionState?.executions ?? []),
        ];
  return executions.find(
    (candidate) => candidate.replicate === replicate && candidate.benchmark === expectedBenchmark,
  );
}

function normalizedSourceCandidate(value: string): string | null {
  const cleaned = value
    .replace(/^`|`$/g, '')
    .split('#')[0]!
    .replace(/:\d+(?::\d+)?(?:\s.*)?$/, '')
    .trim();
  if (!cleaned || cleaned.startsWith('/') || cleaned.includes('\\')) return null;
  if (cleaned.split('/').some((segment) => segment === '..')) return null;
  return cleaned.startsWith('workflows/') ? cleaned.slice('workflows/'.length) : cleaned;
}

function transcriptArtifactRef(value: unknown): {
  objectKey: string;
  artifactSha256: string;
  bytes: number | null;
} | null {
  if (!isRecord(value)) return null;
  const objectKey = safeObjectKey(value.objectKey);
  const artifactSha256 = stringField(value, 'artifactSha256');
  const bytes = numberField(value, 'bytes');
  if (!objectKey || !artifactSha256?.match(/^sha256:[a-f0-9]{64}$/)) return null;
  return { objectKey, artifactSha256, bytes };
}

function contentAddressedHash(value: JsonRecord, omittedField: string): string {
  const copy = { ...value };
  delete copy[omittedField];
  return sha256Bytes(stableJson(copy));
}

export function diagnosisInputPath(artifactDirectory: string, inputSha256: string): string {
  return path.join(
    artifactDirectory,
    'diagnosis',
    `diagnosis-input-${inputSha256.slice('sha256:'.length)}.json`,
  );
}

export function diagnosisManifestPath(artifactDirectory: string, inputSha256: string): string {
  return path.join(
    artifactDirectory,
    'diagnosis',
    `diagnosis-manifest-${inputSha256.slice('sha256:'.length)}.json`,
  );
}

export function diagnosisResultPath(artifactDirectory: string, inputSha256: string): string {
  return path.join(
    artifactDirectory,
    'diagnosis',
    `diagnosis-result-${inputSha256.slice('sha256:'.length)}.json`,
  );
}

export async function verifyDiagnosisResult(
  artifactDirectory: string,
  inputSha256: string,
  resultSha256: string,
): Promise<DiagnosisOutput> {
  const filePath = diagnosisResultPath(artifactDirectory, inputSha256);
  if ((await sha256File(filePath)) !== resultSha256) {
    throw new Error('persisted diagnosis result hash does not match the variant record');
  }
  const result = DiagnosisOutputSchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
  if (result.inputSha256 !== inputSha256) {
    throw new Error('persisted diagnosis result binds another diagnosis input');
  }
  return result;
}

export async function readDiagnosisInput(
  artifactDirectory: string,
  inputSha256: string,
): Promise<DiagnosisInput> {
  const filePath = diagnosisInputPath(artifactDirectory, inputSha256);
  if ((await sha256File(filePath)) !== inputSha256) {
    throw new Error('persisted diagnosis input hash does not match the variant record');
  }
  return DiagnosisInputSchema.parse(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
}

export async function verifyDiagnosisArtifacts(
  artifactDirectory: string,
  inputSha256: string,
): Promise<DiagnosisInput> {
  const diagnosisInput = await readDiagnosisInput(artifactDirectory, inputSha256);
  const manifestFile = diagnosisManifestPath(artifactDirectory, inputSha256);
  const manifest = DiagnosisManifestSchema.parse(
    JSON.parse(await readFile(manifestFile, 'utf8')) as unknown,
  );
  const expectedInputPath = safeRelativePath(
    path.resolve(artifactDirectory),
    diagnosisInputPath(artifactDirectory, inputSha256),
  );
  if (manifest.inputSha256 !== inputSha256 || manifest.inputPath !== expectedInputPath) {
    throw new Error('diagnosis manifest does not bind the persisted diagnosis input');
  }
  const inputDetails = await stat(diagnosisInputPath(artifactDirectory, inputSha256));
  if (inputDetails.size !== manifest.inputBytes) {
    throw new Error('diagnosis manifest input byte count does not match');
  }
  const root = path.resolve(artifactDirectory);
  for (const artifact of manifest.artifacts) {
    const filePath = path.resolve(root, artifact.path);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error('diagnosis manifest contains an unsafe artifact path');
    }
    const details = await lstat(filePath).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink()) {
      throw new Error(`diagnosis source artifact is unavailable: ${artifact.path}`);
    }
    if (details.size !== artifact.bytes || (await sha256File(filePath)) !== artifact.sha256) {
      throw new Error(`diagnosis source artifact hash changed: ${artifact.path}`);
    }
  }
  return diagnosisInput;
}

export async function assembleDiagnosisInput(input: AssembleDiagnosisInput): Promise<AssembledDiagnosis> {
  const artifactRoot = path.resolve(input.artifactDirectory);
  const researchContext = await readFrozenResearchContext(
    input.campaign.config.researchPaths,
    input.campaign.config.researchSha256,
  );
  const standardPrimaryV2 = isStandardPrimaryV2(input);
  const targetExcludedSourceManifestSha256 = input.targetExcludedSourceManifestPath &&
    (await stat(input.targetExcludedSourceManifestPath).catch(() => null))?.isFile()
    ? await sha256File(input.targetExcludedSourceManifestPath)
    : null;
  const focus = selectFocusUnits(input);
  const inventory = new Map<string, ArtifactInventoryItem>();
  const evidence = new Map<string, DiagnosisEvidence>();
  const evidenceFocusScopes = new Map<string, string>();
  const completeness: DiagnosisCompletenessItem[] = [];
  const reconstructionSignals: Array<
    DiagnosisInput['reconstructionSignals'][number] & {
      scopeBenchmark: string | null;
      scopeArm: DiagnosisLineageArm | null;
    }
  > = [];
  const sourceCandidates = new Set<string>();
  const unitKeys = new Map<string, string>();
  const focusByCase = new Map<
    string,
    { unitIds: Set<string>; ordinals: Set<number>; unitByOrdinal: Map<number, string> }
  >();
  const transcriptHeads = new Map<string, JsonRecord>();
  const publishedAnalysisRefs: Array<{
    scope: string;
    ref: unknown;
    apiArtifact: JsonArtifact;
    caseId: string | null;
    runId: string | null;
  }> = [];

  const registerArtifact = async (
    filePath: string,
    integrity: ArtifactInventoryItem['integrity'] = 'verified',
  ): Promise<ArtifactInventoryItem> => {
    const relativePath = safeRelativePath(artifactRoot, filePath);
    const details = await stat(filePath);
    const item = {
      path: relativePath,
      sha256: await sha256File(filePath),
      bytes: details.size,
      integrity,
    };
    inventory.set(relativePath, item);
    return item;
  };

  const readJsonArtifact = async (filePath: string): Promise<JsonArtifact | null> => {
    const details = await stat(filePath).catch(() => null);
    if (!details?.isFile()) return null;
    if (details.size > MAX_JSON_ARTIFACT_BYTES) return null;
    const bytes = await readFile(filePath);
    const item = await registerArtifact(filePath);
    return {
      value: JSON.parse(bytes.toString('utf8')) as unknown,
      relativePath: item.path,
      sha256: item.sha256,
      bytes: item.bytes,
    };
  };

  const addEvidence = (
    key: string,
    value: Omit<DiagnosisEvidence, 'id'>,
  ): DiagnosisEvidence => {
    const id = evidenceId(key);
    const record: DiagnosisEvidence = { id, ...value };
    const existing = evidence.get(id);
    if (existing && stableJson(existing) !== stableJson(record)) {
      throw new Error(`diagnosis evidence ID collision: ${id}`);
    }
    evidence.set(id, record);
    return record;
  };

  const benchmarkByName = new Map(input.campaign.config.benchmarks.map((value) => [value.name, value]));
  const artifactFiles = (await walkFiles(artifactRoot)).filter(
    (filePath) =>
      !safeRelativePath(artifactRoot, filePath).startsWith('target-excluded-attempts/'),
  );
  const primaryBenchmarkName =
    input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name ??
    'primary';
  const replicateDirectories = [
    ...new Set(
      artifactFiles
        .map((filePath) => path.dirname(filePath))
        .filter((directory) => /^replicate-\d+$/.test(path.basename(directory))),
    ),
  ]
    .filter((directory) => {
      if (!standardPrimaryV2) return true;
      const { arm } = artifactLineageArm(safeRelativePath(artifactRoot, directory));
      if (arm === 'control') return false;
      return arm === 'standard' || path.basename(path.dirname(directory)) === primaryBenchmarkName;
    })
    .sort();

  for (const directory of replicateDirectories) {
    const relativeDirectory = safeRelativePath(artifactRoot, directory);
    const { arm, executionScope } = artifactLineageArm(relativeDirectory);
    const replicate = Number.parseInt(path.basename(directory).slice('replicate-'.length), 10);
    const benchmarkName = path.basename(path.dirname(directory));
    const benchmark = benchmarkByName.get(benchmarkName);
    if (!benchmark) continue;
    const scope = relativeDirectory.split('/').slice(0, -2).join('/') || 'evaluation';
    const scopeName = scope === 'evaluation' ? benchmarkName : `${scope}/${benchmarkName}`;
    const factsArtifact = await readJsonArtifact(path.join(directory, 'facts.json'));
    const facts = factsArtifact?.value as RunFacts | undefined;
    const factMap = unitKeyMap(facts ?? null);
    for (const [id, key] of factMap) unitKeys.set(id, key);

    const resultArtifact = await readJsonArtifact(path.join(directory, 'result.json'));
    const analysisArtifact = await readJsonArtifact(path.join(directory, 'analysis.json'));
    const lineage = extractLineage(resultArtifact?.value ?? analysisArtifact?.value);
    const execution = artifactExecution(
      input,
      benchmarkName,
      replicate,
      arm,
      executionScope,
    );
    if (execution) {
      lineage.caseId ??= execution.caseId;
      lineage.runId ??= execution.runId;
      if (lineage.status === 'unknown') lineage.status = execution.status;
    }

    const lineageEvidence = addEvidence(`lineage|${relativeDirectory}`, {
      kind: 'case_run_lineage',
      summary: `${scopeName} replicate ${replicate} recorded case/run lineage with status ${lineage.status}.`,
      affectedUnitKeys: [],
      provenance: {
        classification: resultArtifact ? 'observed_durable' : 'deterministic_reconstruction',
        source: resultArtifact ? 'planner_api' : 'harness',
        artifactPath: resultArtifact?.relativePath ?? null,
        artifactSha256: resultArtifact?.sha256 ?? null,
        integrity: resultArtifact ? 'verified' : 'unverified',
        caseId: lineage.caseId,
        runId: lineage.runId,
        unitKey: null,
        limitation: lineage.caseId && lineage.runId ? null : 'Case or run identity was not captured.',
      },
      data: boundedJson({ ...lineage, benchmark: scopeName, arm, replicate }),
    });
    void lineageEvidence;

    if (!analysisArtifact) {
      completeness.push({
        component: 'analysis',
        scope: relativeDirectory,
        status: 'unavailable',
        captured: 0,
        expected: 1,
        limitations: ['Published analysis.json was not captured for this replicate.'],
      });
    } else {
      const envelope = isRecord(analysisArtifact.value) ? analysisArtifact.value : {};
      const analysis = isRecord(envelope.analysis) ? envelope.analysis : envelope;
      const metadata = isRecord(envelope.metadata) ? envelope.metadata : {};
      if (metadata.artifact) {
        publishedAnalysisRefs.push({
          scope: relativeDirectory,
          ref: metadata.artifact,
          apiArtifact: analysisArtifact,
          caseId: stringField(metadata, 'caseId') ?? lineage.caseId,
          runId: stringField(metadata, 'runId') ?? lineage.runId,
        });
      }
      const resolvedInputs = isRecord(analysis.resolvedInputs) ? analysis.resolvedInputs : {};
      const workflowResolution = resolvedInputs.workflowResolution;
      const analysisUnits = Array.isArray(analysis.requirementUnits)
        ? analysis.requirementUnits.filter(isRecord)
        : [];
      const analysisUnitMap = new Map(analysisUnits.map((unit) => [stringField(unit, 'id'), unit]));
      const analysisCaseId = stringField(metadata, 'caseId') ?? lineage.caseId;
      analysisUnits.forEach((unit, index) => {
        const id = stringField(unit, 'id');
        const key = id ? factMap.get(id) ?? unitKeys.get(id) : null;
        if (
          !analysisCaseId ||
          !id ||
          !key ||
          !focus.scopeKeys.has(focusScopeKey(benchmarkName, arm, key))
        ) return;
        const caseFocus = focusByCase.get(analysisCaseId) ?? {
          unitIds: new Set<string>(),
          ordinals: new Set<number>(),
          unitByOrdinal: new Map<number, string>(),
        };
        caseFocus.unitIds.add(id);
        caseFocus.ordinals.add(index + 1);
        caseFocus.unitByOrdinal.set(index + 1, id);
        focusByCase.set(analysisCaseId, caseFocus);
      });
      const adjudications = Array.isArray(analysis.adjudications)
        ? analysis.adjudications.filter(isRecord)
        : [];
      for (const aggregate of analysisFunnelAggregates(
        benchmarkName,
        benchmark.role,
        arm,
        replicate,
        analysisUnits,
        adjudications,
      )) {
        const disposition = String(aggregate.disposition);
        addEvidence(`all-unit-funnel|${relativeDirectory}|${disposition}`, {
          kind: 'all_unit_funnel_aggregate',
          summary: `${scopeName} replicate ${replicate} ${disposition} disposition has ${String(aggregate.unitOccurrences)} adjudication occurrences; funnel counts distinguish occurrences, affected units, and unavailable capture.`,
          affectedUnitKeys: [],
          provenance: {
            classification: 'deterministic_reconstruction',
            source: 'harness',
            artifactPath: analysisArtifact.relativePath,
            artifactSha256: analysisArtifact.sha256,
            integrity: 'verified',
            caseId: stringField(metadata, 'caseId') ?? lineage.caseId,
            runId: stringField(metadata, 'runId') ?? lineage.runId,
            unitKey: null,
            limitation:
              'Counts summarize all archived adjudications in this analysis. Null means the stage was not durably captured; zero means it was captured with no occurrences.',
          },
          data: boundedJson(aggregate),
        });
      }
      addEvidence(`analysis-pins|${relativeDirectory}`, {
        kind: 'analysis_pins',
        summary: `${scopeName} replicate ${replicate} published immutable input, source, workflow-resolution, and knowledge pins.`,
        affectedUnitKeys: [],
        provenance: {
          classification: 'observed_durable',
          source: 'planner_api',
          artifactPath: analysisArtifact.relativePath,
          artifactSha256: analysisArtifact.sha256,
          integrity: 'verified',
          caseId: stringField(metadata, 'caseId') ?? lineage.caseId,
          runId: stringField(metadata, 'runId') ?? lineage.runId,
          unitKey: null,
          limitation: null,
        },
        data: boundedJson({
          inputSetHash: analysis.inputSetHash,
          pins: metadata.pins,
          workflowResolution,
          source: resolvedInputs.source,
          knowledgeSnapshot: resolvedInputs.knowledgeSnapshot,
        }),
      });
      const analysisEvidenceByUnit = new Map<string, string>();
      for (const adjudication of adjudications) {
        const unitId = stringField(adjudication, 'requirementUnitId');
        if (!unitId) continue;
        const key = factMap.get(unitId) ?? unitKeys.get(unitId) ?? unitId;
        unitKeys.set(unitId, key);
        const shortlist = isRecord(adjudication.shortlist) ? adjudication.shortlist : {};
        const grounding = isRecord(adjudication.evidenceGrounding)
          ? adjudication.evidenceGrounding
          : null;
        const unit = analysisUnitMap.get(unitId);
        const record = addEvidence(`analysis-unit|${relativeDirectory}|${unitId}`, {
          kind: 'unit_adjudication',
          summary: `${key} was adjudicated ${String(adjudication.result ?? 'unknown')} with ${Array.isArray(shortlist.candidates) ? shortlist.candidates.length : 0} shortlisted candidates and ${grounding ? 'a durable evidence-grounding receipt' : 'no captured evidence-grounding receipt'}.`,
          affectedUnitKeys: [key],
          provenance: {
            classification: 'observed_durable',
            source: 'planner_api',
            artifactPath: analysisArtifact.relativePath,
            artifactSha256: analysisArtifact.sha256,
            integrity: 'verified',
            caseId: stringField(metadata, 'caseId') ?? lineage.caseId,
            runId: stringField(metadata, 'runId') ?? lineage.runId,
            unitKey: key,
            limitation: grounding ? null : 'Evidence-grounding receipts were not captured by this planner version.',
          },
          data: boundedJson({
            requirementUnitId: unitId,
            requirement: unit
              ? { ref: unit.ref, kind: unit.kind, semantics: unit.semantics }
              : { unavailable: true },
            decision: adjudication.result,
            confidence: adjudication.confidence,
            rationale: adjudication.rationale,
            shortlist: {
              algorithmVersion: shortlist.algorithmVersion,
              candidates: shortlist.candidates,
              exclusions: shortlist.exclusions,
            },
            selectedCandidateIds: adjudication.selectedCandidateIds,
            sourceRefs: adjudication.sourceRefs,
            evidenceGrounding: grounding ?? { availability: 'not_captured' },
          }),
        });
        evidenceFocusScopes.set(record.id, focusScopeKey(benchmarkName, arm, key));
        analysisEvidenceByUnit.set(unitId, record.id);
        for (const ref of Array.isArray(adjudication.sourceRefs) ? adjudication.sourceRefs : []) {
          if (isRecord(ref) && typeof ref.path === 'string') sourceCandidates.add(ref.path);
        }
        if (grounding) {
          const searchHits = numberField(grounding, 'searchHitCount') ?? 0;
          const sourceReads = numberField(grounding, 'sourceReadCount') ?? 0;
          const admitted =
            (numberField(grounding, 'admittedSourceCount') ?? 0) +
            (numberField(grounding, 'admittedTestCount') ?? 0);
          const rejectionCounts = Array.isArray(grounding.rejectionCounts)
            ? grounding.rejectionCounts.filter(isRecord)
            : [];
          if (sourceReads > 0 && admitted === 0 && rejectionCounts.length > 0) {
            reconstructionSignals.push({
              category: 'evidence_hydration',
              affectedUnitKeys: [key],
              evidenceRefs: [record.id],
              summary: `Deterministic receipt: ${searchHits} search hits led to ${sourceReads} source reads but no admitted evidence; recorded rejection reasons, not KB availability, explain the loss.`,
              provenance: 'deterministic_reconstruction',
              scopeBenchmark: benchmarkName,
              scopeArm: arm,
            });
          } else if ((Array.isArray(shortlist.candidates) ? shortlist.candidates.length : 0) === 0) {
            reconstructionSignals.push({
              category: 'candidate_ranking',
              affectedUnitKeys: [key],
              evidenceRefs: [record.id],
              summary: 'Deterministic receipt: the durable candidate shortlist was empty before adjudication.',
              provenance: 'deterministic_reconstruction',
              scopeBenchmark: benchmarkName,
              scopeArm: arm,
            });
          }
        }
      }
      completeness.push({
        component: 'analysis',
        scope: relativeDirectory,
        status: adjudications.length > 0 ? 'complete' : 'partial',
        captured: adjudications.length,
        expected: analysisUnits.length || null,
        limitations: adjudications.length > 0 ? [] : ['Published analysis contained no adjudications.'],
      });
      completeness.push({
        component: 'shortlist_and_evidence',
        scope: relativeDirectory,
        status:
          adjudications.length > 0 &&
          adjudications.every((adjudication) => isRecord(adjudication.shortlist))
            ? 'complete'
            : 'partial',
        captured: analysisEvidenceByUnit.size,
        expected: adjudications.length,
        limitations: adjudications.some((adjudication) => !isRecord(adjudication.evidenceGrounding))
          ? ['One or more units predate durable evidence-grounding receipts.']
          : [],
      });
    }

    for (const name of ['analysis-run-latest.json', 'analysis-runs.json']) {
      const runtime = await readJsonArtifact(path.join(directory, name));
      if (!runtime) continue;
      for (const head of collectObjects(
        runtime.value,
        (candidate) => candidate.kind === 'ainative-planner/tool-transcript-head',
        MAX_TRANSCRIPT_CHAINS,
      )) {
        const cumulativeHash = stringField(head, 'cumulativeHash');
        if (cumulativeHash) transcriptHeads.set(cumulativeHash, head);
      }
    }
  }

  const lineage = replicateDirectories.flatMap((directory) => {
    const relativeDirectory = safeRelativePath(artifactRoot, directory);
    const { arm, executionScope } = artifactLineageArm(relativeDirectory);
    const benchmarkName = path.basename(path.dirname(directory));
    const benchmark = benchmarkByName.get(benchmarkName);
    if (!benchmark) return [];
    const replicate = Number.parseInt(path.basename(directory).slice(10), 10);
    const execution = artifactExecution(
      input,
      benchmarkName,
      replicate,
      arm,
      executionScope,
    );
    const lineageEvidence = evidence.get(evidenceId(`lineage|${relativeDirectory}`));
    const data = isRecord(lineageEvidence?.data) ? lineageEvidence.data : {};
    return [
      {
        benchmark: benchmarkName,
        role: benchmark.role,
        arm,
        replicate,
        caseId: typeof data.caseId === 'string' ? data.caseId : execution?.caseId ?? null,
        runId: typeof data.runId === 'string' ? data.runId : execution?.runId ?? null,
        status: typeof data.status === 'string' ? data.status : execution?.status ?? 'unknown',
      },
    ];
  });
  completeness.push({
    component: 'case_run_lineage',
    scope: 'variant',
    status: lineage.length > 0 && lineage.every((item) => item.caseId && item.runId) ? 'complete' : 'partial',
    captured: lineage.filter((item) => item.caseId && item.runId).length,
    expected: replicateDirectories.length,
    limitations:
      lineage.length === replicateDirectories.length && lineage.every((item) => item.caseId && item.runId)
        ? []
        : ['Some replicate case/run identifiers were not captured.'],
  });

  const addReplicateEvidence = (
    benchmark: string,
    replicates: RunFacts[] | null,
    expected = input.campaign.config.evaluation.replicates,
    enforceExpected = false,
    scopeBenchmark = benchmark,
    scopeArm: DiagnosisLineageArm = 'standard',
  ): void => {
    if (!replicates) {
      completeness.push({
        component: 'replicate_facts',
        scope: benchmark,
        status: 'unavailable',
        captured: 0,
        expected,
        limitations: ['Replicate facts are unavailable.'],
      });
      return;
    }
    const record = addEvidence(`replicate-facts|${benchmark}`, {
      kind: 'replicate_facts',
      summary: `${benchmark} has ${replicates.length} persisted replicate fact sets.`,
      affectedUnitKeys: [...new Set(replicates.flatMap((facts) => facts.units.map((unit) => unit.key)))].slice(
        0,
        500,
      ),
      provenance: {
        classification: 'observed_durable',
        source: 'replicate',
        artifactPath: null,
        artifactSha256: null,
        integrity: 'unverified',
        caseId: null,
        runId: null,
        unitKey: null,
        limitation: 'Compact replicate facts were loaded from SQLite; raw facts files are separately inventoried.',
      },
      data: boundedJson(
        replicates.map((facts, index) => ({
          replicate: index + 1,
          status: facts.status,
          decisions: facts.decisions,
          unitDecisions: facts.units.map(({ key, decision, confidence }) => ({ key, decision, confidence })),
        })),
      ),
    });
    const byUnit = new Map<string, Set<string>>();
    for (const facts of replicates) {
      for (const unit of facts.units) {
        const decisions = byUnit.get(unit.key) ?? new Set<string>();
        decisions.add(unit.decision);
        byUnit.set(unit.key, decisions);
      }
    }
    const unstable = [...byUnit].filter(([, decisions]) => decisions.size > 1).map(([key]) => key);
    if (unstable.length > 0) {
      reconstructionSignals.push({
        category: 'replicate_instability',
        affectedUnitKeys: unstable.slice(0, 500),
        evidenceRefs: [record.id],
        summary: `${unstable.length} units changed decision across persisted replicates.`,
        provenance: 'deterministic_reconstruction',
        scopeBenchmark,
        scopeArm,
      });
    }
    completeness.push({
      component: 'replicate_facts',
      scope: benchmark,
      status:
        replicates.length === 0
          ? 'unavailable'
          : enforceExpected && replicates.length !== expected
            ? 'partial'
            : 'complete',
      captured: replicates.length,
      expected,
      limitations:
        enforceExpected && replicates.length !== expected
          ? [`Captured ${replicates.length} of ${expected} expected replicate fact sets.`]
          : [],
    });
  };
  addReplicateEvidence(
    input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name ?? 'primary',
    input.variant.replicateFacts,
  );
  for (const benchmark of input.campaign.config.benchmarks.filter((value) => value.role === 'holdout')) {
    addReplicateEvidence(benchmark.name, input.variant.holdoutReplicateFacts?.[benchmark.name] ?? null);
  }
  if (input.targetExcluded) {
    const target = input.targetExcluded;
    const primary =
      input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name ??
      'primary';
    const targetExpectedReplicates = (
      arm: 'control' | 'excluded',
      aggregate: RunFacts | null,
      replicates: RunFacts[] | null,
    ): number => {
      const executionBenchmarks =
        arm === 'control'
          ? new Set([`${primary}:control`])
          : new Set([`${primary}:excluded`, `${primary}:target-excluded`]);
      const counts = [
        ...(target.executionState?.executions
          .filter((execution) => executionBenchmarks.has(execution.benchmark))
          .map((execution) => execution.replicateCount) ?? []),
        ...(arm === 'control'
          ? (input.variant.executionState?.executions
              .filter((execution) => execution.benchmark === primary)
              .map((execution) => execution.replicateCount) ?? [])
          : []),
        aggregate?.sampleSize,
      ].filter(
        (count): count is number =>
          typeof count === 'number' && Number.isSafeInteger(count) && count > 0,
      );
      return counts.length > 0
        ? Math.max(...counts)
        : replicates && replicates.length > 0
          ? replicates.length
          : input.campaign.config.evaluation.replicates;
    };
    if (!standardPrimaryV2) {
      addReplicateEvidence(
        `target-excluded/control/${primary}`,
        target.controlReplicateFacts,
        targetExpectedReplicates('control', target.controlFacts, target.controlReplicateFacts),
        true,
        primary,
        'control',
      );
    }
    addReplicateEvidence(
      `target-excluded/excluded/${primary}`,
      target.excludedReplicateFacts,
      targetExpectedReplicates('excluded', target.excludedFacts, target.excludedReplicateFacts),
      true,
      primary,
      'excluded',
    );
  }

  const s3Files = artifactFiles.filter((filePath) =>
    safeRelativePath(artifactRoot, filePath).split('/').includes('s3'),
  );
  const s3BySuffix = new Map<string, string[]>();
  for (const filePath of s3Files) {
    const relative = safeRelativePath(artifactRoot, filePath);
    for (const marker of ['tool-transcripts/', 'phase2/', 'source/', 'requirements/']) {
      const index = relative.indexOf(marker);
      if (index < 0) continue;
      const objectKey = relative.slice(index);
      s3BySuffix.set(objectKey, [...(s3BySuffix.get(objectKey) ?? []), filePath].sort());
    }
  }

  const readRef = async (
    refValue: unknown,
  ): Promise<{ artifact: JsonArtifact; value: JsonRecord } | null> => {
    const ref = transcriptArtifactRef(refValue);
    if (!ref) return null;
    const candidates = s3BySuffix.get(ref.objectKey) ?? [];
    for (const filePath of candidates) {
      const artifact = await readJsonArtifact(filePath);
      if (!artifact || artifact.sha256 !== ref.artifactSha256) continue;
      if (ref.bytes !== null && artifact.bytes !== ref.bytes) continue;
      if (!isRecord(artifact.value)) continue;
      return { artifact, value: artifact.value };
    }
    return null;
  };

  let verifiedPublishedAnalyses = 0;
  for (const reference of publishedAnalysisRefs) {
    const loaded = await readRef(reference.ref);
    if (!loaded) continue;
    verifiedPublishedAnalyses += 1;
    addEvidence(`published-analysis-s3|${reference.scope}`, {
      kind: 'published_analysis_integrity',
      summary: `The published analysis for ${reference.scope} was resolved to its content-addressed S3 artifact.`,
      affectedUnitKeys: [],
      provenance: {
        classification: 'observed_durable',
        source: 's3',
        artifactPath: loaded.artifact.relativePath,
        artifactSha256: loaded.artifact.sha256,
        integrity: 'verified',
        caseId: reference.caseId,
        runId: reference.runId,
        unitKey: null,
        limitation: null,
      },
      data: boundedJson({
        plannerApiArtifact: reference.apiArtifact.relativePath,
        publishedArtifact: transcriptArtifactRef(reference.ref),
      }),
    });
  }
  if (publishedAnalysisRefs.length > 0) {
    completeness.push({
      component: 'analysis',
      scope: 'content-addressed-s3',
      status:
        verifiedPublishedAnalyses === publishedAnalysisRefs.length ? 'complete' : 'partial',
      captured: verifiedPublishedAnalyses,
      expected: publishedAnalysisRefs.length,
      limitations:
        verifiedPublishedAnalyses === publishedAnalysisRefs.length
          ? []
          : ['Some published analysis references could not be verified against collected S3 bytes.'],
    });
  }

  let transcriptEntries = 0;
  let transcriptResults = 0;
  let transcriptRequests = 0;
  let transcriptFailures = 0;
  let transcriptCapReached = false;
  let transcriptV2Entries = 0;
  let sawV1 = false;
  let sawV2 = false;
  const seenEntries = new Set<string>();
  const allHeads = [...transcriptHeads.values()]
    .filter((head) => {
      const caseId = stringField(head, 'caseId');
      return lineage.some((item) => !caseId || item.caseId === caseId);
    });
  const supersededHeadHashes = new Set(
    allHeads.flatMap((head) => {
      const previous = stringField(head, 'previousCumulativeHash');
      return previous ? [previous] : [];
    }),
  );
  const heads = allHeads
    .filter((head) => !supersededHeadHashes.has(stringField(head, 'cumulativeHash') ?? ''))
    .sort((left, right) =>
      String(left.cumulativeHash ?? '').localeCompare(String(right.cumulativeHash ?? '')),
    )
    .slice(0, MAX_TRANSCRIPT_CHAINS);
  for (const head of heads) {
    let expectedHash = stringField(head, 'cumulativeHash');
    let ref: unknown = head.latestEntryRef;
    let expectedOrdinal = numberField(head, 'entryCount');
    for (
      let count = 0;
      ref && count < MAX_TRANSCRIPT_ENTRIES && transcriptEntries < MAX_TRANSCRIPT_ENTRIES;
      count += 1
    ) {
      const loaded = await readRef(ref);
      if (!loaded) {
        transcriptFailures += 1;
        break;
      }
      const entry = loaded.value;
      const cumulativeHash = stringField(entry, 'cumulativeHash');
      if (!cumulativeHash || seenEntries.has(cumulativeHash)) break;
      seenEntries.add(cumulativeHash);
      transcriptEntries += 1;
      const version = numberField(entry, 'schemaVersion');
      sawV1 ||= version === 1;
      sawV2 ||= version === 2;
      if (version === 2) transcriptV2Entries += 1;
      const validEntry =
        cumulativeHash === expectedHash &&
        cumulativeHash === contentAddressedHash(entry, 'cumulativeHash') &&
        (expectedOrdinal === null || numberField(entry, 'ordinal') === expectedOrdinal) &&
        stringField(entry, 'caseId') === stringField(head, 'caseId') &&
        stringField(entry, 'runId') === stringField(head, 'runId');
      if (!validEntry) transcriptFailures += 1;
      const result = await readRef(entry.modelResultArtifact);
      if (result) transcriptResults += 1;
      else transcriptFailures += 1;
      let providerRequest: ReturnType<typeof boundedJson> = {
        availability: version === 1 ? 'hash_only' : 'unavailable',
      };
      let effectiveRequest: ReturnType<typeof boundedJson> = {
        availability: version === 1 ? 'not_captured' : 'unavailable',
      };
      if (version === 2) {
        const provider = await readRef(entry.providerRequestArtifact);
        const effective = await readRef(entry.effectiveRequestArtifact);
        if (provider) {
          transcriptRequests += 1;
          const requestHash = sha256Bytes(
            stableJson({ operation: provider.value.operation, input: provider.value.input }),
          );
          if (requestHash !== provider.value.requestHash || requestHash !== entry.providerRequestHash) {
            transcriptFailures += 1;
          }
          providerRequest = boundedJson(provider.value);
        } else transcriptFailures += 1;
        if (effective) {
          transcriptRequests += 1;
          const requestHash = sha256Bytes(
            stableJson({ operation: effective.value.operation, input: effective.value.input }),
          );
          if (requestHash !== effective.value.requestHash || requestHash !== entry.effectiveRequestHash) {
            transcriptFailures += 1;
          }
          effectiveRequest = boundedJson(effective.value);
        } else transcriptFailures += 1;
      }
      if (result && version === 2) {
        const content = stringField(result.value, 'content') ?? '';
        if (
          Buffer.byteLength(content, 'utf8') !== numberField(result.value, 'contentBytes') ||
          sha256Bytes(content) !== stringField(result.value, 'contentSha256')
        ) {
          transcriptFailures += 1;
        }
      }
      const unitId = version === 2 ? stringField(entry, 'requirementUnitId') : null;
      const key = unitId ? unitKeys.get(unitId) ?? unitId : null;
      const record = addEvidence(`transcript|${cumulativeHash}`, {
        kind: 'tool_transcript_entry',
        summary: `${String(entry.toolName ?? 'unknown')} transcript entry ${String(entry.ordinal ?? '?')} used schema V${version ?? '?'}${key ? ` for ${key}` : '; durable unit correlation was not captured'}.`,
        affectedUnitKeys: key ? [key] : [],
        provenance: {
          classification: 'observed_durable',
          source: 's3',
          artifactPath: loaded.artifact.relativePath,
          artifactSha256: loaded.artifact.sha256,
          integrity: validEntry ? 'verified' : 'unverified',
          caseId: stringField(entry, 'caseId'),
          runId: stringField(entry, 'runId'),
          unitKey: key,
          limitation:
            version === 1
              ? 'V1 has no durable requirement-unit join and only a canonical provider-request hash.'
              : null,
        },
        data: boundedJson({
          schemaVersion: version,
          role: entry.role,
          stage: entry.stage,
          attempt: entry.attempt,
          turn: entry.turn,
          ordinal: entry.ordinal,
          requirementUnitId: unitId ?? { availability: 'not_captured' },
          requirementOrdinal:
            version === 2 ? entry.requirementOrdinal : { availability: 'not_captured' },
          toolUseId:
            version === 2
              ? entry.toolUseId
              : result?.value.toolUseId
                ? { value: result.value.toolUseId, correlation: 'result_only' }
                : { availability: 'not_captured' },
          toolName: entry.toolName,
          toolVersion: entry.toolVersion,
          status: entry.status,
          providerRequestHash:
            version === 2 ? entry.providerRequestHash : entry.canonicalRequestHash,
          providerRequest,
          effectiveRequest,
          result: result ? boundedJson(result.value) : { availability: 'unavailable' },
        }),
      });
      const transcriptLineage = lineage.find(
        (item) =>
          item.caseId === stringField(entry, 'caseId') &&
          (!item.runId || item.runId === stringField(entry, 'runId')),
      );
      if (key) {
        evidenceFocusScopes.set(
          record.id,
          focusScopeKey(
            transcriptLineage?.benchmark ?? '__unresolved__',
            transcriptLineage?.arm ?? 'standard',
            key,
          ),
        );
      }
      if (key && result && isRecord(result.value.metadata)) {
        const resultContent = stringField(result.value, 'content');
        if (resultContent) {
          try {
            const parsed = JSON.parse(resultContent) as unknown;
            const rejections = collectObjects(
              parsed,
              (candidate) => Array.isArray(candidate.evidenceRejections),
              20,
            );
            if (rejections.length > 0) {
              reconstructionSignals.push({
                category: 'evidence_hydration',
                affectedUnitKeys: [key],
                evidenceRefs: [record.id],
                summary:
                  'The durable tool result retained evidence-rejection records for a unit-correlated source operation.',
                provenance: 'deterministic_reconstruction',
                scopeBenchmark: transcriptLineage?.benchmark ?? '__unresolved__',
                scopeArm: transcriptLineage?.arm ?? 'standard',
              });
            }
          } catch {
            // Non-JSON model-visible tool results remain available as bounded transcript evidence.
          }
        }
      }
      expectedHash = stringField(entry, 'previousCumulativeHash');
      ref = entry.previousEntryRef;
      expectedOrdinal = expectedOrdinal === null ? null : expectedOrdinal - 1;
    }
    if (ref && transcriptEntries >= MAX_TRANSCRIPT_ENTRIES) transcriptCapReached = true;
  }
  const expectedTranscriptEntries =
    heads.reduce((sum, head) => sum + (numberField(head, 'entryCount') ?? 0), 0) || null;
  completeness.push({
    component: 'transcript_entries',
    scope: 'variant',
    status:
      heads.length === 0
        ? 'unavailable'
        : transcriptFailures > 0 ||
            transcriptCapReached ||
            (expectedTranscriptEntries !== null && transcriptEntries !== expectedTranscriptEntries)
          ? 'partial'
          : 'complete',
    captured: transcriptEntries,
    expected: expectedTranscriptEntries,
    limitations: [
      ...(heads.length === 0 ? ['No transcript head was captured in planner runtime artifacts.'] : []),
      ...(sawV1 ? ['V1 entries have no durable unit identity or persisted request body.'] : []),
      ...(transcriptFailures > 0 ? [`${transcriptFailures} transcript integrity checks failed.`] : []),
      ...(transcriptCapReached
        ? [`Transcript traversal stopped at the cap of ${MAX_TRANSCRIPT_ENTRIES} entries.`]
        : []),
    ],
  });
  completeness.push({
    component: 'transcript_requests',
    scope: 'variant',
    status: sawV2 ? (transcriptFailures > 0 ? 'partial' : 'complete') : sawV1 ? 'unavailable' : 'unavailable',
    captured: transcriptRequests,
    expected: sawV2 ? transcriptV2Entries * 2 : null,
    limitations: sawV1 ? ['Historical V1 records only request hashes; request artifacts are not captured.'] : [],
  });
  completeness.push({
    component: 'transcript_results',
    scope: 'variant',
    status:
      transcriptEntries === 0
        ? 'unavailable'
        : transcriptResults === transcriptEntries
          ? 'complete'
          : 'partial',
    captured: transcriptResults,
    expected: transcriptEntries || null,
    limitations: transcriptResults === transcriptEntries ? [] : ['Some transcript result artifacts were unavailable.'],
  });

  const langfuseCases = [
    ...new Set([
      ...lineage.flatMap(({ caseId }) => (caseId ? [caseId] : [])),
      ...heads.flatMap((head) => {
        const caseId = stringField(head, 'caseId');
        return caseId ? [caseId] : [];
      }),
    ]),
  ];
  const langfuseLineages = langfuseCases.map((caseId) => ({
    caseId,
    runIds: [
      ...new Set([
        ...lineage
          .filter((item) => item.caseId === caseId)
          .flatMap(({ runId }) => (runId ? [runId] : [])),
        ...heads.flatMap((head) =>
          stringField(head, 'caseId') === caseId && stringField(head, 'runId')
            ? [stringField(head, 'runId')!]
            : [],
        ),
      ]),
    ],
    requirementUnitIds: [...(focusByCase.get(caseId)?.unitIds ?? [])].sort(),
    requirementOrdinals: [...(focusByCase.get(caseId)?.ordinals ?? [])].sort(
      (left, right) => left - right,
    ),
  }));
  const langfuseSnapshotPath = path.join(artifactRoot, 'diagnosis', 'langfuse-snapshot-v2.json');
  let langfuse: LangfuseCollection;
  const existingLangfuse = await readJsonArtifact(langfuseSnapshotPath);
  if (existingLangfuse) {
    const value = existingLangfuse.value;
    if (
      !isRecord(value) ||
      !['not_configured', 'complete', 'partial', 'failed'].includes(String(value.status)) ||
      !Array.isArray(value.traces) ||
      !Array.isArray(value.limitations)
    ) {
      throw new Error('persisted Langfuse snapshot has an invalid shape');
    }
    langfuse = value as unknown as LangfuseCollection;
  } else {
    langfuse = await (
      input.langfuseClient ?? new LangfuseReadClient(input.environment)
    ).collect(langfuseLineages);
    await writeImmutable(langfuseSnapshotPath, stablePrettyJson(langfuse));
    await registerArtifact(langfuseSnapshotPath);
  }
  for (const [traceIndex, trace] of langfuse.traces.entries()) {
    const traceRecord = isRecord(trace.trace) ? trace.trace : {};
    const traceId = stringField(traceRecord, 'id') ?? `trace-${traceIndex + 1}`;
    for (const [observationIndex, observation] of trace.observations.entries()) {
      const observationRecord = isRecord(observation) ? observation : {};
      const metadata = isRecord(observationRecord.metadata) ? observationRecord.metadata : {};
      const observationCaseId = stringField(metadata, 'caseId') ?? stringField(traceRecord, 'sessionId');
      const namedOrdinal = /^adjudicate (\d+)\//.exec(stringField(observationRecord, 'name') ?? '')?.[1];
      const unitId =
        stringField(metadata, 'requirementUnitId') ??
        (observationCaseId && namedOrdinal
          ? focusByCase
              .get(observationCaseId)
              ?.unitByOrdinal.get(Number.parseInt(namedOrdinal, 10)) ?? null
          : null);
      const key = unitId ? unitKeys.get(unitId) ?? unitId : null;
      const record = addEvidence(`langfuse|${traceId}|${stringField(observationRecord, 'id') ?? observationIndex}`, {
        kind: 'langfuse_observation',
        summary: `Optional Langfuse observation ${String(observationRecord.name ?? observationIndex + 1)}${key ? ` correlated to ${key}` : ''}.`,
        affectedUnitKeys: key ? [key] : [],
        provenance: {
          classification: 'observed_langfuse',
          source: 'langfuse',
          artifactPath: null,
          artifactSha256: null,
          integrity: 'unverified',
          caseId: observationCaseId,
          runId: stringField(metadata, 'runId'),
          unitKey: key,
          limitation: 'Langfuse is an optional, non-durable corroborating projection.',
        },
        data: boundedJson({ traceId, observation }),
      });
      const observationLineage = lineage.find(
        (item) =>
          item.caseId === observationCaseId &&
          (!item.runId || item.runId === stringField(metadata, 'runId')),
      );
      if (key) {
        evidenceFocusScopes.set(
          record.id,
          focusScopeKey(
            observationLineage?.benchmark ?? '__unresolved__',
            observationLineage?.arm ?? 'standard',
            key,
          ),
        );
      }
    }
  }
  completeness.push({
    component: 'langfuse',
    scope: 'variant',
    status:
      langfuse.status === 'not_configured'
        ? 'not_configured'
        : langfuse.status === 'complete'
          ? 'complete'
          : langfuse.status === 'partial'
            ? 'partial'
            : 'failed',
    captured: langfuse.traces.reduce((sum, trace) => sum + trace.observations.length, 0),
    expected: null,
    limitations: langfuse.limitations,
  });

  const variantJudgments: Array<{ benchmark: string; judgment: VariantRecord['judgment'] }> = [
    {
      benchmark:
        input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name ??
        'primary',
      judgment: input.variant.judgment,
    },
    ...Object.entries(input.variant.holdoutJudgments ?? {}).map(([benchmark, judgment]) => ({
      benchmark,
      judgment,
    })),
  ];
  const judgments: Array<{ benchmark: string; judgment: VariantRecord['judgment'] }> = [
    ...variantJudgments,
    ...(input.targetExcluded?.judgment
      ? [{ benchmark: 'target-excluded', judgment: input.targetExcluded.judgment }]
      : []),
  ];
  for (const { benchmark, judgment } of judgments) {
    if (!judgment) continue;
    for (const verdict of judgment.verdicts) {
      const record = addEvidence(`judge|${benchmark}|${verdict.unitKey}`, {
        kind: 'judge_verdict',
        summary: `Blind judge suggested ${verdict.expectedDecision}/${verdict.classification} for ${verdict.unitKey}; this remains model-generated, not verified truth.`,
        affectedUnitKeys: [verdict.unitKey],
        provenance: {
          classification: 'model_inference',
          source: 'judge',
          artifactPath: null,
          artifactSha256: null,
          integrity: 'unverified',
          caseId: null,
          runId: null,
          unitKey: verdict.unitKey,
          limitation: 'Blind-judge output is model inference and is not a human-verified label.',
        },
        data: boundedJson({ benchmark, ...verdict }),
      });
      evidenceFocusScopes.set(
        record.id,
        focusScopeKey(
          benchmark === 'target-excluded' ? primaryBenchmarkName : benchmark,
          benchmark === 'target-excluded' ? 'excluded' : 'standard',
          verdict.unitKey,
        ),
      );
      verdict.evidence.forEach((value) => sourceCandidates.add(value));
    }
  }
  completeness.push({
    component: 'judge',
    scope: 'variant',
    status: input.variant.judgment ? 'complete' : 'unavailable',
    captured: variantJudgments.reduce((sum, item) => sum + (item.judgment?.verdicts.length ?? 0), 0),
    expected: input.variant.facts?.unitCount ?? null,
    limitations: input.variant.judgment ? [] : ['Primary blind-judge output is unavailable.'],
  });
  if (input.targetExcluded) {
    completeness.push({
      component: 'judge',
      scope: 'target-excluded',
      status: input.targetExcluded.judgment ? 'complete' : 'unavailable',
      captured: input.targetExcluded.judgment?.verdicts.length ?? 0,
      expected: input.targetExcluded.excludedFacts?.unitCount ?? null,
      limitations: input.targetExcluded.judgment
        ? ['Target blind-judge output remains model inference and is not human-verified truth.']
        : ['Target blind-judge output is unavailable.'],
    });
  }

  for (const label of input.labels) {
    const record = addEvidence(`label|${label.benchmark}|${label.unitKey}`, {
      kind: 'label',
      summary: `${label.status === 'verified' ? 'Human-verified' : 'Model-suggested'} label for ${label.unitKey}.`,
      affectedUnitKeys: [label.unitKey],
      provenance: {
        classification: label.status === 'verified' ? 'observed_durable' : 'model_inference',
        source: label.status === 'verified' ? 'human_label' : 'judge',
        artifactPath: null,
        artifactSha256: null,
        integrity: 'unverified',
        caseId: null,
        runId: null,
        unitKey: label.unitKey,
        limitation:
          label.status === 'verified'
            ? null
            : 'Suggested labels are model judgments and have not been human verified.',
      },
      data: boundedJson(label),
    });
    evidenceFocusScopes.set(
      record.id,
      focusScopeKey(
        label.benchmark === 'target-excluded' ? primaryBenchmarkName : label.benchmark,
        label.benchmark === 'target-excluded' ? 'excluded' : 'standard',
        label.unitKey,
      ),
    );
  }
  completeness.push({
    component: 'labels',
    scope: 'campaign',
    status: 'complete',
    captured: input.labels.length,
    expected: null,
    limitations:
      input.labels.some((label) => label.status === 'verified')
        ? []
        : ['No human-verified labels were available; suggested labels remain model judgments.'],
  });

  const allFacts = [
    input.variant.facts,
    ...(input.variant.replicateFacts ?? []),
    ...Object.values(input.variant.holdoutFacts ?? {}),
    ...Object.values(input.variant.holdoutReplicateFacts ?? {}).flat(),
    ...targetRunFacts(input.targetExcluded, standardPrimaryV2),
  ].filter((facts): facts is RunFacts => facts !== null);
  for (const facts of allFacts) {
    for (const unit of facts.units) {
      for (const ref of unit.sourceRefs) if (ref.path) sourceCandidates.add(ref.path);
    }
  }
  let capturedSources = 0;
  let filteredTargetLeakSources = 0;
  const targetWorkflow =
    input.targetExcludedConfig?.targetImplementationWorkflow ??
    input.campaign.config.targetExcluded?.targetImplementationWorkflow;
  for (const rawCandidate of [...sourceCandidates].sort().slice(0, MAX_SOURCE_REFS)) {
    const candidate = normalizedSourceCandidate(rawCandidate);
    if (!candidate) continue;
    const filePath = path.resolve(input.workflowsSource, candidate);
    if (!filePath.startsWith(`${path.resolve(input.workflowsSource)}${path.sep}`)) continue;
    const details = await lstat(filePath).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink() || details.size > MAX_SOURCE_BYTES) continue;
    const bytes = await readFile(filePath);
    if (
      standardPrimaryV2 &&
      targetWorkflow &&
      isV2TargetIdentitySourceCandidate({
        relativePath: candidate,
        text: bytes.toString('utf8'),
        targetWorkflow,
      })
    ) {
      filteredTargetLeakSources += 1;
      continue;
    }
    const excerpt = bytes.subarray(0, MAX_SOURCE_EXCERPT_BYTES).toString('utf8');
    addEvidence(`frozen-source|${candidate}`, {
      kind: 'frozen_source_reference',
      summary: `Frozen source reference ${candidate} was verified at the campaign workflows revision.`,
      affectedUnitKeys: [],
      provenance: {
        classification: 'observed_durable',
        source: 'frozen_source',
        artifactPath: `frozen-source/${candidate}`,
        artifactSha256: sha256Bytes(bytes),
        integrity: 'verified',
        caseId: null,
        runId: null,
        unitKey: null,
        limitation:
          details.size > MAX_SOURCE_EXCERPT_BYTES
            ? `Only the first ${MAX_SOURCE_EXCERPT_BYTES} bytes are included; the full file is hash-referenced.`
            : null,
      },
      data: boundedJson({
        path: candidate,
        bytes: details.size,
        sha256: sha256Bytes(bytes),
        excerpt,
        excerptBytes: Buffer.byteLength(excerpt),
        truncated: details.size > MAX_SOURCE_EXCERPT_BYTES,
      }),
    });
    capturedSources += 1;
  }
  completeness.push({
    component: 'frozen_source',
    scope: 'campaign-workflows',
    status:
      sourceCandidates.size === 0
        ? 'unavailable'
        : capturedSources === Math.min(sourceCandidates.size, MAX_SOURCE_REFS)
          ? 'complete'
          : 'partial',
    captured: capturedSources,
    expected: Math.min(sourceCandidates.size, MAX_SOURCE_REFS),
    limitations: [
      ...(sourceCandidates.size > MAX_SOURCE_REFS
        ? [`Frozen source references were capped at ${MAX_SOURCE_REFS}.`]
        : []),
      ...(filteredTargetLeakSources > 0
        ? [
            `Filtered ${filteredTargetLeakSources} frozen-source candidate${filteredTargetLeakSources === 1 ? '' : 's'} containing the standard-primary-v2 excluded target identity.`,
          ]
        : []),
      ...(sourceCandidates.size > filteredTargetLeakSources && capturedSources === 0
        ? ['No cited source path could be safely resolved in the frozen checkout.']
        : []),
    ],
  });

  const comparisonArtifactHashes: Array<{
    replicate: number;
    normalCaseId: string | null;
    excludedCaseId: string | null;
    normalRunId: string | null;
    excludedRunId: string | null;
    reportHash: string | null;
    artifactSha256: string;
  }> = [];
  if (input.targetExcluded) {
    const target = input.targetExcluded;
    const pmSimulationAnswers =
      target.questionResolution?.pmSimulationAnswers ??
      target.questionResolution?.entries.filter(({ resolution }) => resolution === 'pm_simulation')
        .length ??
      0;
    if (standardPrimaryV2) {
      const binding = target.normalArmBinding;
      addEvidence(`target-normal-arm-binding|${target.variantId}`, {
        kind: 'target_normal_arm_binding',
        summary:
          'The standard primary physical measurement is reused as the comparison normal arm; no additional control execution is represented.',
        affectedUnitKeys: [],
        provenance: {
          classification: 'deterministic_reconstruction',
          source: 'harness',
          artifactPath: null,
          artifactSha256: binding?.resolvedArtifactSha ?? null,
          integrity: binding ? 'hash_only' : 'unavailable',
          caseId: null,
          runId: null,
          unitKey: null,
          limitation: binding
            ? null
            : 'The standard-primary normal-arm case/run binding was not captured.',
        },
        data: boundedJson({
          protocol: 'standard-primary-v2',
          physicalMeasurement: 'standard_primary',
          comparisonArm: 'normal',
          additionalControlExecution: false,
          normalArmBinding: binding,
        }),
      });
    }
    const comparisonsByReplicate = new Map(
      (target.comparisons ?? []).map((comparison) => [comparison.replicate, comparison]),
    );
    for (const filePath of artifactFiles) {
      const relativePath = safeRelativePath(artifactRoot, filePath);
      const match = /^target-excluded\/comparisons\/replicate-(\d+)\.json$/.exec(relativePath);
      if (!match) continue;
      const replicate = Number.parseInt(match[1]!, 10);
      const comparison = comparisonsByReplicate.get(replicate);
      if (!comparison) continue;
      const report = await readJsonArtifact(filePath);
      if (!report) continue;
      const embeddedHash = stringField(report.value, 'hash');
      const reportRecord = isRecord(report.value) ? { ...report.value } : null;
      if (!reportRecord) continue;
      delete reportRecord.hash;
      if (
        !embeddedHash ||
        sha256Bytes(stableJson(reportRecord)) !== embeddedHash ||
        (comparison.reportHash && embeddedHash !== comparison.reportHash)
      ) continue;
      addEvidence(`target-excluded-comparison|${replicate}|${report.sha256}`, {
        kind: 'target_excluded_comparison',
        summary: `Target comparison replicate ${replicate} was read from the archived JSON report and verified by content hash.`,
        affectedUnitKeys: [],
        provenance: {
          classification: 'observed_durable',
          source: 'harness',
          artifactPath: report.relativePath,
          artifactSha256: report.sha256,
          integrity: 'verified',
          caseId: null,
          runId: null,
          unitKey: null,
          limitation: null,
        },
        data: boundedJson(report.value),
      });
      comparisonArtifactHashes.push({
        replicate,
        normalCaseId: comparison.normalCaseId ?? null,
        excludedCaseId: comparison.excludedCaseId ?? null,
        normalRunId: comparison.normalRunId ?? null,
        excludedRunId: comparison.excludedRunId ?? null,
        reportHash: comparison.reportHash,
        artifactSha256: report.sha256,
      });
    }
    addEvidence(`target-excluded|${target.variantId}`, {
      kind: 'target_excluded_summary',
      summary: `Target-excluded guard status is ${target.status} with gate ${target.gate?.status ?? 'pending'}; it is a guard, not a fitness reward.${pmSimulationAnswers > 0 ? ` It includes ${pmSimulationAnswers} unverified PM-simulation answer${pmSimulationAnswers === 1 ? '' : 's'}, not human-verified authority.` : ''}`,
      affectedUnitKeys: target.excludedFacts?.units.map((unit) => unit.key).slice(0, 500) ?? [],
      provenance: {
        classification: 'deterministic_reconstruction',
        source: 'harness',
        artifactPath: null,
        artifactSha256: null,
        integrity: 'unverified',
        caseId: null,
        runId: null,
        unitKey: null,
        limitation: `Target-excluded output and labels remain separate from normal measured facts.${pmSimulationAnswers > 0 ? ' PM-simulation answers are unverified synthetic input, not human-verified authority.' : ''}`,
      },
      data: boundedJson({
        status: target.status,
        error: target.error,
        questionResolution: target.questionResolution,
        artifactCollectionComplete: target.artifactCollectionComplete,
        gate: target.gate,
        comparisons: target.comparisons,
        comparisonHashes: [...(target.comparisons ?? [])]
          .sort((left, right) => left.replicate - right.replicate)
          .flatMap(({ reportHash }) => (reportHash ? [reportHash] : [])),
        comparisonArtifactHashes: comparisonArtifactHashes.sort(
          (left, right) => left.replicate - right.replicate,
        ),
        excludedDecisions: target.excludedFacts?.decisions,
        ...(!standardPrimaryV2
          ? { controlDecisions: target.controlFacts?.decisions }
          : {
              protocol: 'standard-primary-v2',
              normalArmBinding: target.normalArmBinding,
            }),
        score: target.score,
      }),
    });
  }
  completeness.push({
    component: 'target_excluded',
    scope: 'variant',
    status: input.targetExcluded ? (input.targetExcluded.status === 'completed' ? 'complete' : 'partial') : 'not_configured',
    captured: input.targetExcluded ? 1 : 0,
    expected: input.targetExcluded ? 1 : null,
    limitations: input.targetExcluded
      ? ['Target-excluded facts are a separate promotion guard and do not establish normal-run truth.']
      : ['No target-excluded evaluation was associated with this variant.'],
  });

  for (const item of completeness) {
    addEvidence(`completeness|${item.component}|${item.scope}`, {
      kind: 'capture_completeness',
      summary: `${item.component} capture for ${item.scope} is ${item.status}.`,
      affectedUnitKeys: [],
      provenance: {
        classification:
          item.status === 'unavailable' || item.status === 'not_configured' || item.status === 'failed'
            ? 'not_captured'
            : 'deterministic_reconstruction',
        source: 'harness',
        artifactPath: null,
        artifactSha256: null,
        integrity: item.status === 'complete' ? 'verified' : 'unavailable',
        caseId: null,
        runId: null,
        unitKey: null,
        limitation: item.limitations.join(' ').slice(0, 2_000) || null,
      },
      data: boundedJson(item),
    });
  }

  const focusedSignals = reconstructionSignals
    .map(({ scopeBenchmark, scopeArm, ...signal }) => ({
      ...signal,
      affectedUnitKeys: signal.affectedUnitKeys.filter((key) =>
        scopeBenchmark && scopeArm
          ? focus.scopeKeys.has(focusScopeKey(scopeBenchmark, scopeArm, key))
          : false,
      ),
    }))
    .filter((signal) => signal.affectedUnitKeys.length > 0)
    .filter(
      (signal, index, values) =>
        values.findIndex((candidate) => stableJson(candidate) === stableJson(signal)) === index,
    )
    .sort((left, right) =>
      `${left.category}:${left.affectedUnitKeys.join(',')}`.localeCompare(
        `${right.category}:${right.affectedUnitKeys.join(',')}`,
      ),
    );
  const requiredEvidence = new Set(focusedSignals.flatMap((signal) => signal.evidenceRefs));
  const retainedByKind = new Map<string, number>();
  const retainedLangfuseByUnit = new Map<string, number>();
  const evidenceLimits: Record<string, number> = {
    unit_adjudication: 180,
    tool_transcript_entry: 300,
    langfuse_observation: 300,
    judge_verdict: MAX_FOCUS_UNITS,
    label: MAX_FOCUS_UNITS,
  };
  const evidenceRankByUnit = new Map<string, number>();
  const rankedEvidence = [...evidence.values()]
    .map((item) => {
      const unitKey = item.affectedUnitKeys.find((key) => focus.keys.has(key)) ?? null;
      const scopedKey = evidenceFocusScopes.get(item.id) ?? null;
      const bucket = `${item.kind}:${scopedKey ?? unitKey ?? 'unscoped'}`;
      const rank = evidenceRankByUnit.get(bucket) ?? 0;
      evidenceRankByUnit.set(bucket, rank + 1);
      return { item, unitKey, scopedKey, rank };
    })
    .sort((left, right) =>
      left.item.kind.localeCompare(right.item.kind) ||
      Number(right.scopedKey !== null || right.unitKey !== null) -
        Number(left.scopedKey !== null || left.unitKey !== null) ||
      left.rank - right.rank ||
      (left.scopedKey ?? left.unitKey ?? '').localeCompare(
        right.scopedKey ?? right.unitKey ?? '',
      ) ||
      left.item.id.localeCompare(right.item.id),
    )
    .map(({ item }) => item);
  const retainedEvidence = rankedEvidence.filter((item) => {
    const scopedKey = evidenceFocusScopes.get(item.id);
    const isFocused = scopedKey
      ? focus.scopeKeys.has(scopedKey)
      : item.affectedUnitKeys.some((key) => focus.keys.has(key));
    if (item.affectedUnitKeys.length > 0 && !isFocused && !requiredEvidence.has(item.id)) return false;
    if (requiredEvidence.has(item.id)) return true;
    if (item.kind === 'langfuse_observation' && isFocused) {
      const unitKey = item.affectedUnitKeys.find((key) => focus.keys.has(key))!;
      const quotaKey = evidenceFocusScopes.get(item.id) ?? unitKey;
      const count = retainedLangfuseByUnit.get(quotaKey) ?? 0;
      if (count >= 10) return false;
      retainedLangfuseByUnit.set(quotaKey, count + 1);
    }
    if (
      item.affectedUnitKeys.length === 0 &&
      (item.kind === 'tool_transcript_entry' || item.kind === 'langfuse_observation')
    ) {
      const count = retainedByKind.get(item.kind) ?? 0;
      if (count >= 20) return false;
    }
    const limit = evidenceLimits[item.kind];
    const count = retainedByKind.get(item.kind) ?? 0;
    if (limit !== undefined && count >= limit) return false;
    retainedByKind.set(item.kind, count + 1);
    return true;
  });
  const focusLimitation =
    focus.candidateCount > focus.scopeKeys.size
      ? `Diagnosis retained stratified detail for ${focus.scopeKeys.size} of ${focus.candidateCount} measured benchmark/arm units across ${focus.stratumCount} available strata, including funnel failures, source-backed controls, decision disagreements, and holdout coverage.`
      : null;
  const materialLimitations = [
    ...completeness.flatMap((item) => item.limitations),
    ...(focusLimitation ? [focusLimitation] : []),
  ];
  const overallPartial =
    focusLimitation !== null ||
    completeness.some(
      (item) =>
        item.status === 'partial' ||
        item.status === 'failed' ||
        (item.status === 'unavailable' && item.component !== 'target_excluded'),
    );
  const diagnosisInput = DiagnosisInputSchema.parse({
    kind: 'ainative-planner-eval/diagnosis-input',
    schemaVersion: 2,
    interpretationPolicy: 'Diagnosis is model-generated, unverified, and excluded from numeric scoring.',
    campaign: {
      id: input.campaign.id,
      plannerSeed: input.campaign.seedSha,
      workflowsRevision: input.campaign.workflowsSha,
      environmentSha256: input.campaign.environmentSha,
      benchmarkPins: input.campaign.config.benchmarks.map(({ name, role, sha256 }) => ({
        name,
        role,
        sha256: sha256 ?? null,
      })),
      ...(input.targetExcludedConfig
        ? {
            targetExcludedProtocol: {
              protocol: input.targetExcludedConfig.protocol,
              targetImplementationWorkflow:
                input.targetExcludedConfig.targetImplementationWorkflow,
              baselineVariantId: input.targetExcludedConfig.baselineVariantId,
              comparatorImage: input.targetExcludedConfig.comparatorImage,
              replicates: input.targetExcludedConfig.replicates,
              concurrency: input.targetExcludedConfig.concurrency,
              warningBuildDropRatio: input.targetExcludedConfig.warningBuildDropRatio,
              blockBuildDropRatio: input.targetExcludedConfig.blockBuildDropRatio,
              sourceManifestSha256: targetExcludedSourceManifestSha256,
              normalArmBinding: input.targetExcluded?.normalArmBinding ?? null,
            },
          }
        : {}),
    },
    variant: {
      id: input.variant.id,
      parentVariantId: input.variant.parentVariantId,
      round: input.variant.round,
      artifactCollectionComplete: input.variant.artifactCollectionComplete,
    },
    lineage: lineage.sort((left, right) =>
      `${left.benchmark}:${left.arm}:${left.replicate}`.localeCompare(
        `${right.benchmark}:${right.arm}:${right.replicate}`,
      ),
    ),
    researchContext,
    completeness: {
      status: overallPartial ? 'partial' : 'complete',
      items: completeness.sort((left, right) =>
        `${left.component}:${left.scope}`.localeCompare(`${right.component}:${right.scope}`),
      ),
      limitations: [...new Set(materialLimitations)].sort().slice(0, 200),
    },
    evidence: retainedEvidence.sort((left, right) => left.id.localeCompare(right.id)),
    reconstructionSignals: focusedSignals,
  });
  const serializedInput = stablePrettyJson(diagnosisInput);
  if (Buffer.byteLength(serializedInput) > MAX_DIAGNOSIS_INPUT_BYTES) {
    throw new Error(
      `bounded diagnosis input exceeded ${MAX_DIAGNOSIS_INPUT_BYTES} bytes after deterministic focus selection`,
    );
  }
  const inputSha256 = sha256Bytes(serializedInput);
  const inputPath = diagnosisInputPath(artifactRoot, inputSha256);
  await writeImmutable(inputPath, serializedInput);
  const inputRelativePath = safeRelativePath(artifactRoot, inputPath);
  const manifest: DiagnosisManifest = DiagnosisManifestSchema.parse({
    kind: 'ainative-planner-eval/diagnosis-manifest',
    schemaVersion: 1,
    inputPath: inputRelativePath,
    inputSha256,
    inputBytes: Buffer.byteLength(serializedInput),
    artifacts: [...inventory.values()].sort((left, right) => left.path.localeCompare(right.path)),
  });
  const manifestPath = diagnosisManifestPath(artifactRoot, inputSha256);
  await writeImmutable(manifestPath, stablePrettyJson(manifest));
  return { input: diagnosisInput, inputPath, inputSha256, manifestPath };
}

export async function writeMutationContext(
  artifactDirectory: string,
  parent: VariantRecord,
  diagnosisInput: DiagnosisInput,
  findingIds: readonly string[],
): Promise<string> {
  if (!parent.diagnosis || !parent.diagnosisInputHash) {
    throw new Error('parent diagnosis result is unavailable');
  }
  const findings = parent.diagnosis.findings.filter((finding) => findingIds.includes(finding.id));
  if (findings.length !== findingIds.length) {
    throw new Error('mutation hypothesis cites an unknown diagnosis finding');
  }
  const evidenceIds = new Set(
    findings.flatMap((finding) => [
      ...finding.supportingEvidenceRefs,
      ...finding.counterEvidenceRefs,
    ]),
  );
  const context = {
    kind: 'ainative-planner-eval/mutation-context',
    schemaVersion: 1,
    interpretationPolicy:
      'The diagnosis and findings are model-generated, unverified hypotheses. They do not override measured facts, judge suggestions, or human labels.',
    parentVariantId: parent.id,
    diagnosisInputSha256: parent.diagnosisInputHash,
    selectedFindings: findings.map(
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
      }),
    ),
    citedEvidence: diagnosisInput.evidence
      .filter((item) => evidenceIds.has(item.id))
      .map(({ id, kind, summary, affectedUnitKeys, provenance, data }) => ({
        id,
        kind,
        summary,
        affectedUnitKeys,
        provenance,
        data,
      })),
  };
  const filePath = path.join(artifactDirectory, 'mutation-context.json');
  await writeImmutable(filePath, stablePrettyJson(context));
  return filePath;
}

export function validateDiagnosisFindingReferences(
  findings: readonly DiagnosisFinding[],
  diagnosisInput: DiagnosisInput,
): void {
  const evidenceIds = new Set(diagnosisInput.evidence.map(({ id }) => id));
  for (const finding of findings) {
    for (const id of [...finding.supportingEvidenceRefs, ...finding.counterEvidenceRefs]) {
      if (!evidenceIds.has(id)) throw new Error(`diagnosis finding ${finding.id} cites unknown evidence ${id}`);
    }
    const knownUnits = new Set(diagnosisInput.evidence.flatMap((item) => item.affectedUnitKeys));
    if (finding.affectedUnitKeys.some((key) => !knownUnits.has(key))) {
      throw new Error(`diagnosis finding ${finding.id} cites an unknown affected unit`);
    }
  }
}
