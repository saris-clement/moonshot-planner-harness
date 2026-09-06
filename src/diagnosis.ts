import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './config.js';
import { LangfuseReadClient, type LangfuseCollection } from './langfuse.js';
import {
  DiagnosisInputSchema,
  DiagnosisManifestSchema,
  type CampaignRecord,
  type DiagnosisCompletenessItem,
  type DiagnosisEvidence,
  type DiagnosisFinding,
  type DiagnosisInput,
  type DiagnosisManifest,
  type JsonValue,
  type LabelRecord,
  type RunFacts,
  type TargetExcludedEvaluationRecord,
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
const MAX_DIAGNOSIS_INPUT_BYTES = 4 * 1_024 * 1_024;

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

function selectFocusUnits(input: AssembleDiagnosisInput): {
  keys: Set<string>;
  candidateCount: number;
} {
  const measured = new Map((input.variant.facts?.units ?? []).map((unit) => [unit.key, unit]));
  const priority = new Map<string, number>();
  const add = (key: string, value: number) => {
    if (!measured.has(key)) return;
    priority.set(key, Math.min(priority.get(key) ?? value, value));
  };
  const primary = input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name;
  for (const label of input.labels) {
    const unit = measured.get(label.unitKey);
    if (label.benchmark !== primary || !unit || unit.decision === label.expectedDecision) continue;
    add(label.unitKey, label.status === 'verified' ? 0 : 2);
  }
  for (const verdict of input.variant.judgment?.verdicts ?? []) {
    const unit = measured.get(verdict.unitKey);
    if (!unit || unit.decision === verdict.expectedDecision) continue;
    add(verdict.unitKey, verdict.classification === 'system_error' ? 1 : 3);
  }
  const decisions = new Map<string, Set<string>>();
  for (const replicate of input.variant.replicateFacts ?? []) {
    for (const unit of replicate.units) {
      const values = decisions.get(unit.key) ?? new Set<string>();
      values.add(unit.decision);
      decisions.set(unit.key, values);
    }
  }
  for (const [key, values] of decisions) if (values.size > 1) add(key, 4);
  if (priority.size === 0) {
    for (const unit of input.variant.facts?.units ?? []) add(unit.key, 5);
  }
  const selected = [...priority]
    .sort(([leftKey, leftPriority], [rightKey, rightPriority]) =>
      leftPriority - rightPriority || leftKey.localeCompare(rightKey),
    )
    .slice(0, MAX_FOCUS_UNITS)
    .map(([key]) => key);
  return { keys: new Set(selected), candidateCount: priority.size };
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
  const focus = selectFocusUnits(input);
  const inventory = new Map<string, ArtifactInventoryItem>();
  const evidence = new Map<string, DiagnosisEvidence>();
  const completeness: DiagnosisCompletenessItem[] = [];
  const reconstructionSignals: DiagnosisInput['reconstructionSignals'] = [];
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
  const artifactFiles = await walkFiles(artifactRoot);
  const replicateDirectories = [
    ...new Set(
      artifactFiles
        .map((filePath) => path.dirname(filePath))
        .filter((directory) => /^replicate-\d+$/.test(path.basename(directory))),
    ),
  ].sort();

  for (const directory of replicateDirectories) {
    const relativeDirectory = safeRelativePath(artifactRoot, directory);
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
    input.variant.executionState?.executions
      .filter(
        (execution) =>
          execution.replicate === replicate &&
          (execution.benchmark === benchmarkName || execution.benchmark.endsWith(`:${scope}`)),
      )
      .forEach((execution) => {
        lineage.caseId ??= execution.caseId;
        lineage.runId ??= execution.runId;
        if (lineage.status === 'unknown') lineage.status = execution.status;
      });

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
      data: boundedJson({ ...lineage, benchmark: scopeName, replicate }),
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
        if (!analysisCaseId || !id || !key || !focus.keys.has(key)) return;
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
            });
          } else if ((Array.isArray(shortlist.candidates) ? shortlist.candidates.length : 0) === 0) {
            reconstructionSignals.push({
              category: 'candidate_ranking',
              affectedUnitKeys: [key],
              evidenceRefs: [record.id],
              summary: 'Deterministic receipt: the durable candidate shortlist was empty before adjudication.',
              provenance: 'deterministic_reconstruction',
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
    const benchmarkName = path.basename(path.dirname(directory));
    const benchmark = benchmarkByName.get(benchmarkName);
    if (!benchmark) return [];
    const execution = input.variant.executionState?.executions.find(
      (candidate) =>
        candidate.replicate === Number.parseInt(path.basename(directory).slice(10), 10) &&
        candidate.benchmark.startsWith(benchmarkName),
    );
    const lineageEvidence = evidence.get(evidenceId(`lineage|${relativeDirectory}`));
    const data = isRecord(lineageEvidence?.data) ? lineageEvidence.data : {};
    return [
      {
        benchmark: benchmarkName,
        role: benchmark.role,
        replicate: Number.parseInt(path.basename(directory).slice(10), 10),
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

  const addReplicateEvidence = (benchmark: string, replicates: RunFacts[] | null): void => {
    if (!replicates) {
      completeness.push({
        component: 'replicate_facts',
        scope: benchmark,
        status: 'unavailable',
        captured: 0,
        expected: input.campaign.config.evaluation.replicates,
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
      });
    }
    completeness.push({
      component: 'replicate_facts',
      scope: benchmark,
      status: replicates.length > 0 ? 'complete' : 'unavailable',
      captured: replicates.length,
      expected: input.campaign.config.evaluation.replicates,
      limitations: [],
    });
  };
  addReplicateEvidence(
    input.campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary')?.name ?? 'primary',
    input.variant.replicateFacts,
  );
  for (const benchmark of input.campaign.config.benchmarks.filter((value) => value.role === 'holdout')) {
    addReplicateEvidence(benchmark.name, input.variant.holdoutReplicateFacts?.[benchmark.name] ?? null);
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
      addEvidence(`langfuse|${traceId}|${stringField(observationRecord, 'id') ?? observationIndex}`, {
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

  const judgments: Array<{ benchmark: string; judgment: VariantRecord['judgment'] }> = [
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
  for (const { benchmark, judgment } of judgments) {
    if (!judgment) continue;
    for (const verdict of judgment.verdicts) {
      addEvidence(`judge|${benchmark}|${verdict.unitKey}`, {
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
      verdict.evidence.forEach((value) => sourceCandidates.add(value));
    }
  }
  completeness.push({
    component: 'judge',
    scope: 'variant',
    status: input.variant.judgment ? 'complete' : 'unavailable',
    captured: judgments.reduce((sum, item) => sum + (item.judgment?.verdicts.length ?? 0), 0),
    expected: input.variant.facts?.unitCount ?? null,
    limitations: input.variant.judgment ? [] : ['Primary blind-judge output is unavailable.'],
  });

  for (const label of input.labels) {
    addEvidence(`label|${label.benchmark}|${label.unitKey}`, {
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
  ].filter((facts): facts is RunFacts => facts !== null);
  for (const facts of allFacts) {
    for (const unit of facts.units) {
      for (const ref of unit.sourceRefs) if (ref.path) sourceCandidates.add(ref.path);
    }
  }
  let capturedSources = 0;
  for (const rawCandidate of [...sourceCandidates].sort().slice(0, MAX_SOURCE_REFS)) {
    const candidate = normalizedSourceCandidate(rawCandidate);
    if (!candidate) continue;
    const filePath = path.resolve(input.workflowsSource, candidate);
    if (!filePath.startsWith(`${path.resolve(input.workflowsSource)}${path.sep}`)) continue;
    const details = await lstat(filePath).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink() || details.size > MAX_SOURCE_BYTES) continue;
    const bytes = await readFile(filePath);
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
      ...(sourceCandidates.size > 0 && capturedSources === 0
        ? ['No cited source path could be safely resolved in the frozen checkout.']
        : []),
    ],
  });

  if (input.targetExcluded) {
    const target = input.targetExcluded;
    addEvidence(`target-excluded|${target.variantId}`, {
      kind: 'target_excluded_summary',
      summary: `Target-excluded guard status is ${target.status} with gate ${target.gate?.status ?? 'pending'}; it is a guard, not a fitness reward.`,
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
        limitation: 'Target-excluded output and labels remain separate from normal measured facts.',
      },
      data: boundedJson({
        status: target.status,
        gate: target.gate,
        comparisons: target.comparisons,
        excludedDecisions: target.excludedFacts?.decisions,
        controlDecisions: target.controlFacts?.decisions,
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
    .map((signal) => ({
      ...signal,
      affectedUnitKeys: signal.affectedUnitKeys.filter((key) => focus.keys.has(key)),
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
  const retainedEvidence = [...evidence.values()].filter((item) => {
    const isFocused = item.affectedUnitKeys.some((key) => focus.keys.has(key));
    if (item.affectedUnitKeys.length > 0 && !isFocused && !requiredEvidence.has(item.id)) return false;
    if (item.kind === 'langfuse_observation' && isFocused) {
      const unitKey = item.affectedUnitKeys.find((key) => focus.keys.has(key))!;
      const count = retainedLangfuseByUnit.get(unitKey) ?? 0;
      if (count >= 10 && !requiredEvidence.has(item.id)) return false;
      retainedLangfuseByUnit.set(unitKey, count + 1);
    }
    if (
      item.affectedUnitKeys.length === 0 &&
      (item.kind === 'tool_transcript_entry' || item.kind === 'langfuse_observation')
    ) {
      const count = retainedByKind.get(item.kind) ?? 0;
      if (count >= 20 && !requiredEvidence.has(item.id)) return false;
    }
    const limit = evidenceLimits[item.kind];
    const count = retainedByKind.get(item.kind) ?? 0;
    if (limit !== undefined && count >= limit && !requiredEvidence.has(item.id)) return false;
    retainedByKind.set(item.kind, count + 1);
    return true;
  });
  const focusLimitation =
    focus.candidateCount > focus.keys.size
      ? `Diagnosis retained ${focus.keys.size} of ${focus.candidateCount} mismatched or unstable primary units, prioritized by verified labels, system-error judgments, suggestions, and replicate instability.`
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
    schemaVersion: 1,
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
    },
    variant: {
      id: input.variant.id,
      parentVariantId: input.variant.parentVariantId,
      round: input.variant.round,
      artifactCollectionComplete: input.variant.artifactCollectionComplete,
    },
    lineage: lineage.sort((left, right) =>
      `${left.benchmark}:${left.replicate}`.localeCompare(`${right.benchmark}:${right.replicate}`),
    ),
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
