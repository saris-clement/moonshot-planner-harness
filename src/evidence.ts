import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DecisionSchema, type RunFacts } from './types.js';
import { redactResearchText } from './researchSandboxSnapshot.js';

export type EvidenceArm = 'standard' | 'control' | 'excluded';
/** Coordinator input only. Never deserialize this manifest from a model tool argument. */
export interface EvidenceScopeManifest {
  version: 1;
  campaignId: string;
  variantId: string;
  artifactRoot: string;
  currentArtifactDirectory: string;
  parentArtifactDirectory: string;
  workflowsSource: string;
  plannerSource: string;
  referencePath: string;
  allowedObservations?: Array<{
    variantId: string;
    artifactDirectory: string;
    arm: EvidenceArm;
    benchmark?: string;
    /** Required for excluded source access; must be a separately filtered snapshot. */
    sourceRoot?: string;
  }>;
}

export const EVIDENCE_DEFAULT_BYTES = 16_384;
export const EVIDENCE_MAX_BYTES = 65_536;
const paging = {
  cursor: z.string().max(1_024).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  maxBytes: z.number().int().min(2_048).max(EVIDENCE_MAX_BYTES).optional(),
};
const scopeId = /^(?!\.{1,2}$)[\w.-]+$/;
const ref = z.string().regex(/^(?:snapshot|unit|evidence|source)_[a-f0-9]{64}$/);
export const EvidenceKindSchema = z.enum(['facts', 'reference', 'score_basis', 'receipt', 'analysis', 'source_excerpt', 'transcript', 'test_log', 'patch', 'diagnosis', 'failure', 'context', 'request']);
export const ListObservationsQuerySchema = z.object({ ...paging,
  kind: z.enum(['observation', 'source', 'evidence']).optional(),
  evidenceKind: EvidenceKindSchema.optional(),
  nameQuery: z.string().min(1).max(512).describe('Case-sensitive literal substring of a relative artifact name, not a filesystem path to open.').optional(),
}).strict();
export const CompareTrialQuerySchema = z.object({ ...paging, snapshotRef: ref, baselineSnapshotRef: ref.optional(), changedOnly: z.boolean().optional() }).strict();
export const InspectUnitQuerySchema = z.object({ ...paging, unitRef: ref, includeRationale: z.boolean().optional(), includeRawAnalysis: z.boolean().optional() }).strict();
export const ReadEvidenceQuerySchema = z.object({ evidenceRef: ref, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(EVIDENCE_MAX_BYTES).optional(), maxBytes: paging.maxBytes }).strict();
export const SearchSourceQuerySchema = z.object({ ...paging, query: z.string().min(1).max(512), sourceRef: ref.optional() }).strict();
export type ListObservationsQuery = z.input<typeof ListObservationsQuerySchema>;
export type CompareTrialQuery = z.input<typeof CompareTrialQuerySchema>;
export type InspectUnitQuery = z.input<typeof InspectUnitQuerySchema>;
export type ReadEvidenceQuery = z.input<typeof ReadEvidenceQuerySchema>;
export type SearchSourceQuery = z.input<typeof SearchSourceQuerySchema>;

type Row = Record<string, unknown>;
type Kind = z.infer<typeof EvidenceKindSchema>;
export interface EvidenceOmission {
  reason: string;
  count?: number;
  evidenceRef?: string;
  field?: string;
}
export interface EvidenceResponse<T = Row> {
  schemaVersion: 1;
  snapshotRef: string;
  items: T[];
  returnedCount: number;
  totalMatched: number;
  nextCursor: string | null;
  availability: 'available' | 'partial' | 'not_captured';
  omissions: EvidenceOmission[];
  /** UTF-8 bytes of compact JSON.stringify(response), including this field. */
  byteLength: number;
}

const researchText = z.string().transform(redactResearchText);
const researchNumber = z.number().finite().nonnegative();
const researchLabelSchema = z.object({
  campaignId: researchText, benchmark: researchText, unitKey: researchText, expectedDecision: DecisionSchema,
  status: z.enum(['suggested', 'verified']), rationale: researchText.optional(),
  classification: z.enum(['system_error', 'real_gap', 'uncertain']).optional(), updatedAt: researchText.optional(),
});
const researchFactsSchema = z.object({
  status: researchText, sampleSize: researchNumber, decisionAgreement: researchNumber, unitCount: researchNumber,
  decisions: z.record(DecisionSchema, researchNumber),
  shortlist: z.object({ empty: researchNumber, nonempty: researchNumber, candidates: researchNumber }),
  evidence: z.object({ discovered: researchNumber, selectedSourceRefs: researchNumber }),
  usage: z.object({ calls: researchNumber, inputTokens: researchNumber, outputTokens: researchNumber,
    totalTokens: researchNumber, costUsd: researchNumber, durationMs: researchNumber }),
  pins: z.record(z.string(), z.unknown()).transform((pins) => Object.fromEntries([
    'inputSetHash', 'decisionSetHash', 'decisionSetVersion', 'anchorHash', 'source', 'sourceRevision',
    'sourceCommit', 'workflowsSha', 'plannerSha', 'model', 'modelVariant', 'promptHash', 'promptSha',
    'kbSnapshotId', 'kbSnapshotHash', 'knowledgeSnapshotId', 'knowledgeSnapshotHash',
  ].flatMap<[string, string | number]>((key) => {
    const value = pins[key];
    return typeof value === 'string' ? [[key, redactResearchText(value)]] :
      typeof value === 'number' && Number.isFinite(value) ? [[key, value]] : [];
  }))),
  units: z.array(z.object({
    id: researchText, key: researchText, ref: z.object({ entity: researchText, anchor: researchText }),
    kind: researchText, semantics: researchText, decision: DecisionSchema, confidence: researchText, rationale: researchText,
    selectedCandidateIds: z.array(researchText), discoveredEvidenceCount: researchNumber, shortlistCandidateCount: researchNumber,
    uncoveredSemantics: z.array(researchText),
    sourceRefs: z.array(z.object({ capabilityId: researchText.optional(), path: researchText.optional(), symbol: researchText.optional() }))
      .transform((refs) => refs.filter((item) => item.path === undefined || safeRelative(item.path))),
  })),
});

export interface ResearchSnapshotExport {
  data: {
    schemaVersion: 1;
    snapshotRef: string;
    observation: { campaignId: string; variantId: string; arm: EvidenceArm; benchmark: string | null;
      role: 'baseline' | 'trial' | 'final'; actionId: string | null; labelSetHash: string | null };
    replicates: Array<{ replicate: number; facts: RunFacts; artifactRef: string }>;
    reference: { availability: 'available' | 'not_captured'; source: 'investigator_reference' | 'archived_score_basis' | 'not_captured';
      artifactRef: string | null; labelSetHash: string | null; labels: Array<z.output<typeof researchLabelSchema>> };
    artifactBindings: Array<{ evidenceRef: string; kind: Kind; artifactPath: string; sha256: string; bytes: number; integrity: 'verified_content_hash' }>;
    sourcePolicy: { availability: 'available' | 'not_captured'; sourceRef: string | null;
      mode: 'normal_frozen_source' | 'filtered_measurement_source'; binding: 'coordinator_scope'; publicationRequired: true; description: string };
    interpretation: string;
    omissions: EvidenceOmission[];
  };
  sourceRoots: Array<{ name: string; path: string }>;
}
interface FileEntry {
  evidenceRef: string;
  root: string;
  relative: string;
  kind: Kind;
  sha256: string;
  size: number;
  qualifier: string;
  stamp: string;
}
interface SourceEntry {
  sourceRef: string;
  arm: EvidenceArm;
  role: 'workflows' | 'planner';
  files: FileEntry[];
  omissions: EvidenceOmission[];
  root: string;
  available: boolean;
  indexed: boolean;
  indexing: Promise<void> | null;
  canonicalRoot: string | null;
}
interface Observation {
  snapshotRef: string;
  variantId: string;
  arm: EvidenceArm;
  benchmark: string | null;
  role: 'baseline' | 'trial' | 'final';
  actionId: string | null;
  replicas: Array<{ replicate: number; facts: Row; file: FileEntry; analysis?: FileEntry }>;
  files: FileEntry[];
  score: unknown;
  baselineScore: unknown;
  labelSetHash: string | null;
  sourceRef: string | null;
  patchHash: string | null;
  scoreBasis: { file: FileEntry; value: Row } | null;
}

function record(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function records(value: unknown): Row[] { return Array.isArray(value) ? value.map(record) : []; }
function hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function sizeResponse<T extends { byteLength: number }>(value: T): T {
  value.byteLength = bytes(value);
  value.byteLength = bytes(value);
  value.byteLength = bytes(value);
  return value;
}
function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeRelative(relative: string): boolean {
  return !!relative && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0') &&
    relative.split('/').every((part) => part !== '.' && part !== '..' && part !== '' && !secret(part));
}
function secret(name: string): boolean {
  return /^(?:\.git|\.aws|\.ssh|\.config|node_modules|\.data|\.npmrc|\.netrc|\.pypirc)$/i.test(name) ||
    /(?:^|[._-])(?:env|stackenv|credentials?|secrets?|private[-_]?key)(?:$|[._-])/i.test(name) ||
    /\.(?:pem|key|p12|pfx|keystore)$/i.test(name) || /^id_(?:rsa|ed25519|ecdsa)/i.test(name);
}

function stamp(details: Stats): string {
  return [details.dev, details.ino, details.size, details.mtimeMs, details.ctimeMs, details.mode].join(':');
}

/** Validate every path component even when reusing cached content or a registered hash. */
async function fileState(root: string, relative: string) {
  if (!safeRelative(relative)) throw new Error('Unsafe evidence path');
  const canonicalRoot = await realpath(root);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink evidence root');
  let candidate = root;
  let details: Stats | undefined;
  for (const part of relative.split('/')) {
    candidate = path.join(candidate, part);
    details = await lstat(candidate);
    if (details.isSymbolicLink()) throw new Error('Symlink evidence path');
  }
  if (!contained(canonicalRoot, await realpath(candidate))) throw new Error('Evidence escaped scope');
  if (!details?.isFile()) throw new Error('Evidence is not a regular file');
  return { canonicalRoot, candidate, details };
}

async function safeRead(root: string, relative: string, max = 32 * 1_024 * 1_024, onRead?: (stamp: string) => void): Promise<Buffer> {
  const { candidate, canonicalRoot } = await fileState(root, relative);
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > max) throw new Error('Evidence is not a bounded regular file');
    const content = await file.readFile();
    const after = await lstat(candidate);
    if (after.isSymbolicLink() || stamp(before) !== stamp(after) ||
        before.size !== content.length || !contained(canonicalRoot, await realpath(candidate))) {
      throw new Error('Evidence changed during read');
    }
    onRead?.(stamp(after));
    return content;
  } finally { await file.close(); }
}

function artifactKind(relative: string): Kind | null {
  const name = path.basename(relative);
  if (name === 'facts.json') return 'facts';
  if (name === 'analysis.json' || /^analysis-run-[\w-]+\.json$/.test(name)) return 'analysis';
  if (name === 'investigator-reference.json') return 'reference';
  if (name === 'score-basis.json') return 'score_basis';
  if (name === 'receipt.json') return 'receipt';
  if (name === 'request.json') return 'request';
  if (['failure.json', 'events.json', 'runtime-run-latest.json', 'run.json'].includes(name) || /^failure[-.].*\.json$/.test(name)) return 'failure';
  if (/^(?:variant|mutation)\.patch$/.test(name)) return 'patch';
  if (/^(?:tests|typecheck|test-files|diff-check|gate-\d+|image-build|test-image-build|test-runner-image-build)\.log$/.test(name)) return 'test_log';
  if (/^(?:investigator-turn-\d+|mutator|repair|strategist(?:-repair)?|judge(?:-[\w-]+)?|diagnosis-[\w-]+|source-answer-[\w-]+)\.jsonl$/.test(name) || relative.includes('/tool-transcripts/')) return 'transcript';
  if (/^diagnosis-(?:input|result|manifest)-[a-f0-9]+\.json$/.test(name)) return 'diagnosis';
  if (/^investigator-(?:context|turn-\d+-(?:context|feedback))\.json$/.test(name)) return 'context';
  if (relative.includes('/source/') && /\.(?:json|txt|ts|js)$/.test(name)) return 'source_excerpt';
  return null;
}

function units(facts: Row): Map<string, Row> {
  const output = new Map<string, Row>();
  for (const unit of records(facts.units)) {
    if (typeof unit.key !== 'string' || typeof unit.decision !== 'string' || output.has(unit.key)) throw new Error('Invalid or duplicate archived unit key');
    output.set(unit.key, unit);
  }
  return output;
}
function histograms(observation: Observation): { aggregate: Record<string, number>; byUnit: Map<string, Record<string, number>> } {
  const counts = new Map<string, Record<string, number>>();
  const aggregate: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const replica of observation.replicas) {
    for (const [unitKey, unit] of units(replica.facts)) {
      const decision = String(unit.decision);
      const count = counts.get(unitKey) ?? Object.create(null) as Record<string, number>;
      count[decision] = (count[decision] ?? 0) + 1;
      counts.set(unitKey, count);
      aggregate[decision] = (aggregate[decision] ?? 0) + 1;
    }
  }
  const mean = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([decision, count]) => [decision, count / observation.replicas.length]));
  return { aggregate: mean(aggregate), byUnit: new Map([...counts].map(([key, value]) => [key, mean(value)])) };
}

/** Read-only, transport-independent evidence service. All filesystem authority comes from scope. */
export class EvidenceStore {
  private readonly scope: EvidenceScopeManifest;
  private readonly namespace: string;
  private readonly files = new Map<string, FileEntry>();
  private readonly observations = new Map<string, Observation>();
  private readonly unitRefs = new Map<string, { snapshotRef: string; key: string }>();
  private readonly sources = new Map<string, SourceEntry>();
  private readonly roots = new Map<string, SourceEntry>();
  private readonly registeredPaths = new Map<string, FileEntry>();
  private readonly readStamps = new Map<string, string>();
  private readonly parsed = new Map<string, Row>();
  private readonly sourceText = new Map<string, string>();
  private sourceTextBytes = 0;
  private readonly scans = new Map<string, { files: string[]; directories: Map<string, string>; omissions: EvidenceOmission[] }>();
  private reference: FileEntry | null = null;
  private referenceValue: Row = {};
  private baselineRef: string | null = null;
  private initialized: Promise<void> | null = null;
  private catalog: Row[] = [];
  private catalogOmissions: EvidenceOmission[] = [];

  constructor(scope: EvidenceScopeManifest) {
    if (scope.version !== 1 || !scopeId.test(scope.campaignId) || !scopeId.test(scope.variantId)) throw new Error('Invalid evidence scope manifest');
    this.scope = structuredClone(scope);
    this.namespace = hash([scope.campaignId, scope.variantId]);
    const root = path.resolve(scope.artifactRoot);
    const current = path.resolve(scope.currentArtifactDirectory);
    const parent = path.resolve(scope.parentArtifactDirectory);
    const campaignRoot = path.dirname(current);
    if ((!contained(root, current) || !contained(root, parent)) || path.basename(campaignRoot) !== scope.campaignId ||
        path.basename(current) !== scope.variantId || path.dirname(parent) !== campaignRoot ||
        !contained(current, path.resolve(scope.referencePath))) throw new Error('Artifact scope must belong to one campaign and the current variant');
    for (const allowed of scope.allowedObservations ?? []) {
      const variantRoot = path.join(campaignRoot, allowed.variantId);
      const directory = path.resolve(allowed.artifactDirectory);
      if (!scopeId.test(allowed.variantId) || (directory !== variantRoot && !contained(variantRoot, directory)) ||
          !['standard', 'control', 'excluded'].includes(allowed.arm)) throw new Error('Observation registration escaped campaign');
      if (allowed.arm === 'excluded' && allowed.sourceRoot &&
          [scope.workflowsSource, scope.plannerSource].some((source) => path.resolve(source) === path.resolve(allowed.sourceRoot!))) {
        throw new Error('Excluded source requires a separate filtered root');
      }
    }
  }

  private id(kind: 'snapshot' | 'unit' | 'evidence' | 'source', value: unknown): string { return `${kind}_${hash([this.namespace, value])}`; }

  private async register(root: string, relative: string, kind: Kind, qualifier: string): Promise<FileEntry> {
    const key = JSON.stringify([path.resolve(root), relative, qualifier]);
    const previous = this.registeredPaths.get(key);
    if (previous && stamp((await this.stateScoped(root, relative)).details) === previous.stamp) return previous;
    if (previous && qualifier.startsWith('source:')) {
      await this.verified(previous);
      return previous;
    }
    const content = await this.readScoped(root, relative, kind === 'source_excerpt' ? 5 * 1_024 * 1_024 : undefined);
    if (kind === 'source_excerpt') {
      if (content.includes(0)) throw new Error('Source is not text');
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    const evidenceRef = this.id('evidence', [qualifier, relative, sha256]);
    const entry = { evidenceRef, root, relative, kind, sha256, size: content.length, qualifier, stamp: this.readStamps.get(JSON.stringify([root, relative]))! };
    this.files.set(evidenceRef, entry);
    this.registeredPaths.set(key, entry);
    if (kind === 'source_excerpt') this.cacheSourceText(entry, content.toString('utf8'));
    if (['facts', 'reference', 'receipt', 'score_basis'].includes(kind)) {
      try { this.parsed.set(evidenceRef, record(JSON.parse(content.toString('utf8')))); } catch { /* json() reports malformed archives when selected. */ }
    }
    return entry;
  }

  private cacheSourceText(entry: FileEntry, text: string): void {
    if (this.sourceText.has(entry.evidenceRef)) return;
    // Bounded, per-store cache. Files retain their hash and filesystem identity after eviction.
    while (this.sourceTextBytes + entry.size > 96 * 1_024 * 1_024 && this.sourceText.size) {
      const oldest = this.sourceText.keys().next().value!;
      this.sourceTextBytes -= Buffer.byteLength(this.sourceText.get(oldest)!);
      this.sourceText.delete(oldest);
    }
    this.sourceText.set(entry.evidenceRef, text);
    this.sourceTextBytes += entry.size;
  }

  private async verified(entry: FileEntry): Promise<Buffer> {
    const text = this.sourceText.get(entry.evidenceRef);
    if (text !== undefined && stamp((await this.stateScoped(entry.root, entry.relative)).details) === entry.stamp) return Buffer.from(text);
    const content = await this.readScoped(entry.root, entry.relative);
    if (createHash('sha256').update(content).digest('hex') !== entry.sha256) throw new Error('Evidence integrity failure: registered artifact changed');
    entry.stamp = this.readStamps.get(JSON.stringify([entry.root, entry.relative]))!;
    if (entry.kind === 'source_excerpt') this.cacheSourceText(entry, content.toString('utf8'));
    return content;
  }

  private async assertUnchanged(entry: FileEntry): Promise<void> {
    if (stamp((await this.stateScoped(entry.root, entry.relative)).details) !== entry.stamp) await this.verified(entry);
  }

  private async stateScoped(root: string, relative: string) {
    const authority = path.resolve(this.scope.artifactRoot);
    return contained(authority, path.resolve(root))
      ? fileState(authority, path.relative(authority, path.join(root, relative)))
      : fileState(root, relative);
  }

  private async readScoped(root: string, relative: string, max?: number): Promise<Buffer> {
    // Artifact roots are nested authorities: validate their ancestors back to artifactRoot too.
    const authority = path.resolve(this.scope.artifactRoot);
    const onRead = (value: string) => this.readStamps.set(JSON.stringify([root, relative]), value);
    return contained(authority, path.resolve(root))
      ? safeRead(authority, path.relative(authority, path.join(root, relative)), max, onRead)
      : safeRead(root, relative, max, onRead);
  }

  private async json(entry: FileEntry): Promise<Row> {
    await this.assertUnchanged(entry);
    const cached = this.parsed.get(entry.evidenceRef);
    if (cached) return cached;
    try {
      const value = record(JSON.parse((await this.verified(entry)).toString('utf8')));
      this.parsed.set(entry.evidenceRef, value);
      return value;
    }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Archived evidence is not valid JSON'); throw error; }
  }

  private async scan(root: string, source: boolean, omissions: EvidenceOmission[]): Promise<string[]> {
    const cacheKey = JSON.stringify([root, source]);
    const previous = this.scans.get(cacheKey);
    if (previous) {
      let unchanged = true;
      for (const [directory, expected] of previous.directories) {
        const current = await lstat(directory).catch(() => null);
        if (!current?.isDirectory() || current.isSymbolicLink() || stamp(current) !== expected) { unchanged = false; break; }
      }
      if (unchanged) { omissions.push(...previous.omissions); return previous.files; }
    }
    const found: string[] = [];
    const directories = new Map<string, string>();
    const ownOmissions: EvidenceOmission[] = [];
    let visited = 0;
    let skipped = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 30 || visited >= 20_000) { skipped += 1; return; }
      const absolute = path.join(root, directory);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new Error('Symlink evidence directory');
      directories.set(absolute, stamp(details));
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (++visited > 20_000) { skipped += 1; break; }
        if (secret(entry.name) || entry.isSymbolicLink()) { skipped += 1; continue; }
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!source && ['target-excluded', 'control', 'excluded'].includes(entry.name)) continue;
          await walk(relative, depth + 1);
        } else if (entry.isFile() && (source || artifactKind(relative))) found.push(relative);
      }
    };
    try {
      if ((await lstat(root)).isSymbolicLink()) throw new Error('Symlink evidence root');
      await walk('', 0);
    } catch { ownOmissions.push({ reason: 'root_not_captured_or_unsafe', count: 1 }); }
    if (skipped) ownOmissions.push({ reason: 'unsafe_unsupported_or_scan_limit', count: skipped });
    if (directories.size && !ownOmissions.some((item) => item.reason === 'root_not_captured_or_unsafe')) this.scans.set(cacheKey, { files: found, directories, omissions: ownOmissions });
    omissions.push(...ownOmissions);
    return found;
  }

  private async source(root: string, arm: EvidenceArm, role: 'workflows' | 'planner'): Promise<SourceEntry> {
    const key = `${arm}:${role}:${path.resolve(root)}`;
    const previous = this.roots.get(key);
    if (previous) return previous;
    const details = await lstat(root).catch(() => null);
    const available = !!details?.isDirectory() && !details.isSymbolicLink();
    const canonicalRoot = available ? await realpath(root).catch(() => null) : null;
    // This is a coordinator-scoped locator, not a claim that the source tree was hashed.
    const sourceRef = this.id('source', [arm, role, path.resolve(root)]);
    const entry: SourceEntry = { sourceRef, root, arm, role, files: [], omissions: available ? [] : [{ reason: 'source_root_not_captured_or_unsafe' }], available: available && canonicalRoot !== null, indexed: false, indexing: null, canonicalRoot };
    this.sources.set(sourceRef, entry);
    this.roots.set(key, entry);
    return entry;
  }

  private async loadSource(source: SourceEntry): Promise<void> {
    if (source.indexed) {
      for (const [directory, expected] of this.scans.get(JSON.stringify([source.root, true]))?.directories ?? []) {
        const current = await lstat(directory).catch(() => null);
        if (!current?.isDirectory() || current.isSymbolicLink() || stamp(current) !== expected) throw new Error('Frozen source directory changed');
      }
    }
    source.indexing ??= (async () => {
      if (source.available) {
        for (const relative of await this.scan(source.root, true, source.omissions)) {
          try { source.files.push(await this.register(source.root, relative, 'source_excerpt', `source:${source.sourceRef}`)); }
          catch (error) {
            if (error instanceof Error && error.message.includes('integrity failure')) throw error;
            source.omissions.push({ reason: 'source_file_not_captured_or_unsafe', count: 1 });
          }
        }
      }
      source.indexed = true;
    })();
    await source.indexing;
  }

  private async initialize(): Promise<void> {
    const current = this.scope.currentArtifactDirectory;
    try {
      this.reference = await this.register(current, path.relative(current, this.scope.referencePath), 'reference', 'frozen-reference');
      this.referenceValue = await this.json(this.reference);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await this.source(this.scope.workflowsSource, 'standard', 'workflows');
    await this.source(this.scope.plannerSource, 'standard', 'planner');
    await this.refresh();
  }

  private async ready(): Promise<void> {
    this.initialized ??= this.initialize();
    await this.initialized;
    if (this.reference) await this.assertUnchanged(this.reference);
  }

  private addObservation(input: Omit<Observation, 'snapshotRef'>): Observation {
    const snapshotRef = this.id('snapshot', [input.variantId, input.arm, input.benchmark, input.role, input.actionId, input.sourceRef, input.labelSetHash,
      input.files.map((file) => file.evidenceRef), input.replicas.map((replica) => replica.replicate)]);
    const observation = { ...input, snapshotRef };
    this.observations.set(snapshotRef, observation);
    for (const replica of observation.replicas) {
      for (const key of units(replica.facts).keys()) this.unitRefs.set(this.id('unit', [snapshotRef, key]), { snapshotRef, key });
    }
    return observation;
  }

  private async refresh(): Promise<void> {
    if (this.reference) await this.assertUnchanged(this.reference);
    const omissions: EvidenceOmission[] = [];
    const observations: Observation[] = [];
    const archiveFiles = new Map<string, FileEntry>();
    const normalSource = await this.source(this.scope.workflowsSource, 'standard', 'workflows');
    const base = record(this.referenceValue.baseline);
    if (typeof base.id === 'string' && base.id !== path.basename(this.scope.parentArtifactDirectory)) throw new Error('Frozen baseline variant disagrees with coordinator scope');
    const baselineFacts = records(base.replicateFacts);
    const labels = records(this.referenceValue.labels);
    const benchmark = typeof labels[0]?.benchmark === 'string' ? labels[0].benchmark : null;
    if (this.reference && baselineFacts.length) {
      let scoreBasis: Observation['scoreBasis'] = null;
      if (benchmark && safeRelative(benchmark)) {
        try {
          const file = await this.register(this.scope.parentArtifactDirectory, `${benchmark}/score-basis.json`, 'score_basis', 'frozen-baseline-score');
          const value = await this.json(file);
          if (value.benchmark !== benchmark) throw new Error('Archived score basis benchmark mismatch');
          scoreBasis = { file, value };
          archiveFiles.set(file.evidenceRef, file);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      const baseline = this.addObservation({
        variantId: path.basename(this.scope.parentArtifactDirectory), arm: 'standard',
        benchmark, role: 'baseline', actionId: null, files: [this.reference, ...(scoreBasis ? [scoreBasis.file] : [])],
        replicas: baselineFacts.map((facts, index) => ({ replicate: index + 1, facts, file: this.reference! })),
        score: base.score ?? scoreBasis?.value.score ?? null, baselineScore: null, labelSetHash: typeof this.referenceValue.labelSetHash === 'string' ? this.referenceValue.labelSetHash : null,
        sourceRef: normalSource.sourceRef, patchHash: null, scoreBasis,
      });
      this.baselineRef = baseline.snapshotRef;
      observations.push(baseline);
      archiveFiles.set(this.reference.evidenceRef, this.reference);
    } else omissions.push({ reason: 'frozen_baseline_replicates_not_captured' });

    const scopes = [
      { variantId: this.scope.variantId, artifactDirectory: this.scope.currentArtifactDirectory, arm: 'standard' as EvidenceArm },
      { variantId: path.basename(this.scope.parentArtifactDirectory), artifactDirectory: this.scope.parentArtifactDirectory, arm: 'standard' as EvidenceArm },
      ...(this.scope.allowedObservations ?? []),
    ];
    for (const scope of scopes) {
      const sourceRoot = 'sourceRoot' in scope ? scope.sourceRoot : undefined;
      const source = sourceRoot ? await this.source(sourceRoot, scope.arm, 'workflows') : scope.arm === 'excluded' ? null : normalSource;
      const captured = new Map<string, FileEntry>();
      const qualifier = `${scope.variantId}:${scope.arm}:${path.relative(this.scope.artifactRoot, scope.artifactDirectory)}`;
      for (const relative of await this.scan(scope.artifactDirectory, false, omissions)) {
        try {
          const file = await this.register(scope.artifactDirectory, relative, artifactKind(relative)!, qualifier);
          captured.set(relative, file);
          archiveFiles.set(file.evidenceRef, file);
        } catch { omissions.push({ reason: 'artifact_not_captured_or_unsafe', count: 1 }); }
      }
      const receiptActions = new Set<string>();
      for (const [relative, file] of captured) {
        const match = /^investigation\/(action-\d+)\/receipt\.json$/.exec(relative);
        if (!match) continue;
        const receipt = await this.json(file);
        const result = record(receipt.result);
        const raw = records(result.replicateFacts);
        if (!raw.length) continue;
        receiptActions.add(match[1]!);
        const analysisFiles = [...captured.values()].filter((entry) => entry.kind === 'analysis' && entry.relative.startsWith(`investigation/${match[1]}/`));
        const replicas = raw.map((facts, index) => {
          const analysis = analysisFiles.find((entry) => new RegExp(`/replicate-?${index + 1}/analysis\\.json$`).test(entry.relative));
          return { replicate: index + 1, facts, file, ...(analysis ? { analysis } : {}) };
        });
        observations.push(this.addObservation({
          variantId: scope.variantId, arm: scope.arm, benchmark: ('benchmark' in scope ? scope.benchmark : undefined) ?? benchmark,
          role: 'trial', actionId: match[1]!, files: [file, ...analysisFiles], replicas,
          score: result.score ?? null, baselineScore: result.baselineScore ?? null,
          labelSetHash: typeof result.labelSetHash === 'string' ? result.labelSetHash : null,
          sourceRef: source?.sourceRef ?? null, patchHash: typeof receipt.patchHash === 'string' ? receipt.patchHash : null, scoreBasis: null,
        }));
      }
      const groups = new Map<string, Array<{ replicate: number; facts: Row; file: FileEntry; analysis?: FileEntry }>>();
      for (const [relative, file] of captured) {
        const match = /^(?:(investigation\/(action-\d+))\/)?([^/]+)\/replicate-?(\d+)\/facts\.json$/.exec(relative);
        if (!match || (match[2] && receiptActions.has(match[2])) || ('benchmark' in scope && scope.benchmark && scope.benchmark !== match[3])) continue;
        const key = `${match[1] ?? ''}|${match[3]}`;
        const replicas = groups.get(key) ?? [];
        const analysis = captured.get(relative.replace(/facts\.json$/, 'analysis.json'));
        replicas.push({ replicate: Number(match[4]), facts: await this.json(file), file, ...(analysis ? { analysis } : {}) });
        groups.set(key, replicas);
      }
      for (const [key, replicas] of groups) {
        replicas.sort((a, b) => a.replicate - b.replicate);
        const [action, name] = key.split('|');
        const basisFile = captured.get(`${action ? `${action}/` : ''}${name}/score-basis.json`);
        const basisValue = basisFile ? await this.json(basisFile) : null;
        if (basisValue && basisValue.benchmark !== (scope.arm === 'excluded' ? `${name}:target-excluded` : name)) throw new Error('Archived score basis benchmark mismatch');
        observations.push(this.addObservation({
          variantId: scope.variantId, arm: scope.arm, benchmark: name!, role: action ? 'trial' : scope.variantId === path.basename(this.scope.parentArtifactDirectory) ? 'baseline' : 'final',
          actionId: action ? path.basename(action) : null, files: [...replicas.flatMap((replica) => [replica.file, ...(replica.analysis ? [replica.analysis] : [])]), ...(basisFile ? [basisFile] : [])],
          replicas, score: basisValue?.score ?? null, baselineScore: null, labelSetHash: typeof basisValue?.labelHash === 'string' ? basisValue.labelHash : null,
          sourceRef: source?.sourceRef ?? null, patchHash: null, scoreBasis: basisFile && basisValue ? { file: basisFile, value: basisValue } : null,
        }));
      }
    }
    this.catalog = [...new Map(observations.map((observation) => [observation.snapshotRef, observation])).values()].map((observation) => ({
      kind: 'observation', snapshotRef: observation.snapshotRef, campaignId: this.scope.campaignId,
      variantId: observation.variantId, arm: observation.arm, benchmark: observation.benchmark, role: observation.role,
      actionId: observation.actionId, replicateCount: observation.replicas.length,
      unitCount: new Set(observation.replicas.flatMap((replica) => [...units(replica.facts).keys()])).size,
      labelSetHash: observation.labelSetHash, sourceRef: observation.sourceRef,
      sourceAvailability: observation.sourceRef && this.sources.get(observation.sourceRef)?.available ? 'available_on_request' : 'not_captured',
      evidenceRef: observation.files[0]?.evidenceRef ?? null,
    }));
    this.catalog.push(...[...this.sources.values()].map((source) => ({ kind: 'source', sourceRef: source.sourceRef, arm: source.arm, role: source.role,
      availability: source.available ? 'available_on_request' : 'not_captured', omissions: this.compactOmissions(source.omissions), binding: 'coordinator_scope',
      contentSnapshotRef: source.indexed ? this.id('snapshot', [source.sourceRef, source.files.map((file) => file.evidenceRef)]) : null,
      sourcePolicy: source.arm === 'excluded' ? 'filtered_measurement_source' : 'normal_frozen_source', fileCount: source.indexed ? source.files.length : null })));
    this.catalog.push(...[...archiveFiles.values()].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : a.evidenceRef.localeCompare(b.evidenceRef)).map((file) => ({
      kind: 'evidence', evidenceRef: file.evidenceRef, evidenceKind: file.kind, name: file.relative, bytes: file.size,
    })));
    this.catalogOmissions = omissions;
  }

  private page<E extends Row>(snapshotRef: string, rows: Row[], query: ListObservationsQuery, identity: unknown, extra: E, omissions: EvidenceOmission[] = [], captured = true): EvidenceResponse & E {
    const queryHash = hash([snapshotRef, identity]);
    let offset = 0;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { queryHash: string; offset: number };
        if (cursor.queryHash !== queryHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > rows.length) throw new Error();
        offset = cursor.offset;
      } catch { throw new Error('Invalid or stale query cursor'); }
    }
    const max = query.maxBytes ?? EVIDENCE_DEFAULT_BYTES;
    const cursor = (next: number) => next < rows.length ? Buffer.from(JSON.stringify({ queryHash, offset: next })).toString('base64url') : null;
    const response: EvidenceResponse & E = { ...extra, schemaVersion: 1, snapshotRef, items: [], returnedCount: 0, totalMatched: rows.length,
      nextCursor: cursor(offset), availability: captured ? 'available' : 'not_captured', omissions: this.compactOmissions(omissions), byteLength: 0 };
    // A large diagnostic never consumes the whole envelope or hides the continuation.
    for (const name of Object.keys(extra)) {
      if (bytes(response[name as keyof typeof response]) > max / 4) {
        const evidenceRef = typeof extra.evidenceRef === 'string' ? extra.evidenceRef : undefined;
        (response as Row)[name] = { availability: 'omitted', reason: 'byte_limit', ...(evidenceRef ? { evidenceRef } : {}) };
        response.omissions.push({ reason: 'byte_limit', field: name, ...(evidenceRef ? { evidenceRef } : {}) });
      }
    }
    for (const row of rows.slice(offset, offset + (query.limit ?? 20))) {
      const next = offset + response.items.length + 1;
      const candidate = { ...response, items: [...response.items, row], returnedCount: response.items.length + 1, nextCursor: cursor(next) };
      if (bytes(sizeResponse(candidate)) > max) {
        if (response.items.length) break;
        const handles = Object.fromEntries(Object.entries(row).filter(([name, value]) => /Ref$/.test(name) && typeof value === 'string' && value.length < 128));
        response.items.push({ ...handles, availability: 'omitted', reason: 'row_exceeds_byte_limit' });
        response.omissions.push({ reason: 'row_exceeds_byte_limit', ...handles });
        break;
      }
      response.items.push(row);
    }
    response.returnedCount = response.items.length;
    response.nextCursor = cursor(offset + response.returnedCount);
    if (captured && (response.nextCursor || response.omissions.length)) response.availability = 'partial';
    sizeResponse(response);
    if (response.byteLength > max) throw new Error('Evidence envelope exceeds requested byte limit');
    return structuredClone(response);
  }

  private compactOmissions(omissions: EvidenceOmission[]): EvidenceOmission[] {
    const counts = new Map<string, number>();
    for (const omission of omissions) counts.set(omission.reason, (counts.get(omission.reason) ?? 0) + (omission.count ?? 1));
    return [...counts].map(([reason, count]) => ({ reason, count }));
  }

  async listObservations(input: ListObservationsQuery = {}) {
    const query = ListObservationsQuerySchema.parse(input);
    const alreadyInitialized = this.initialized !== null;
    await this.ready();
    if (alreadyInitialized) await this.refresh();
    const snapshotRef = this.id('snapshot', this.catalog);
    const rows = this.catalog.filter((row) => (!query.kind || row.kind === query.kind) &&
      (!query.evidenceKind || row.evidenceKind === query.evidenceKind) &&
      (!query.nameQuery || (typeof row.name === 'string' && row.name.includes(query.nameQuery))));
    return this.page(snapshotRef, rows, query, ['catalog', query.kind, query.evidenceKind, query.nameQuery], { baselineSnapshotRef: this.baselineRef }, this.catalogOmissions);
  }

  /** Coordinator-only helper. Do not expose filesystem paths as model tool arguments. */
  async referenceForArtifact(relative: string): Promise<string | null> {
    if (typeof relative !== 'string' || !safeRelative(relative)) throw new Error('Unsafe coordinator artifact path');
    const kind = artifactKind(relative);
    if (!kind) return null;
    const current = this.scope.currentArtifactDirectory;
    const candidate = path.join(current, relative);
    const scopes = [{ variantId: this.scope.variantId, arm: 'standard' as EvidenceArm, artifactDirectory: current },
      ...(this.scope.allowedObservations ?? [])].filter((item) => contained(path.resolve(item.artifactDirectory), path.resolve(candidate)))
      .sort((a, b) => b.artifactDirectory.length - a.artifactDirectory.length);
    const scope = scopes[0]!;
    const local = path.relative(scope.artifactDirectory, candidate);
    if (local.split('/').some((part) => ['target-excluded', 'control', 'excluded'].includes(part))) throw new Error('Artifact is outside registered observation scope');
    try {
      const file = await this.register(scope.artifactDirectory, local, kind,
        `${scope.variantId}:${scope.arm}:${path.relative(this.scope.artifactRoot, scope.artifactDirectory)}`);
      return file.evidenceRef;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Coordinator-only bridge to a curated research bundle. No writes and no raw artifact-root mounts.
   * The publisher must still filter credentials/symlinks from sourceRoots and publish read-only copies.
   */
  async exportResearchSnapshot(snapshotRef: string): Promise<ResearchSnapshotExport> {
    z.string().regex(/^snapshot_[a-f0-9]{64}$/).parse(snapshotRef);
    const selected = await this.observation(snapshotRef);
    const bindings = new Map(selected.files.map((file) => [file.evidenceRef, file]));
    const parent = this.parentBaseline(selected);
    const matchingFrozen = selected.benchmark !== null && selected.arm === 'standard' &&
      parent?.snapshotRef === this.baselineRef && this.reference !== null;
    const basis = matchingFrozen ? null : parent?.scoreBasis ?? null;
    const referenceFile = matchingFrozen ? this.reference : basis?.file ?? null;
    const referenceValue = matchingFrozen ? this.referenceValue : basis?.value ?? {};
    const benchmark = selected.arm === 'excluded' ? `${selected.benchmark}:target-excluded` : selected.benchmark;
    if (basis && basis.value.benchmark !== benchmark) throw new Error('Research reference benchmark disagrees with observation scope');
    if (referenceFile) bindings.set(referenceFile.evidenceRef, referenceFile);
    // Rehash the exact selected inputs at this export boundary; no mutable raw envelope is published.
    for (const file of bindings.values()) await this.verified(file);
    const omissions: EvidenceOmission[] = [{ reason: 'non_schema_payloads_and_unapproved_pins_excluded' }, { reason: 'credential_patterns_redacted' }];
    const labels = new Map<string, z.output<typeof researchLabelSchema>>();
    for (const label of records(referenceValue.labels)) {
      if (label.campaignId !== this.scope.campaignId || label.benchmark !== benchmark) continue;
      const parsed = researchLabelSchema.safeParse(label);
      if (!parsed.success) { omissions.push({ reason: 'invalid_reference_label_excluded', count: 1 }); continue; }
      if (!labels.has(parsed.data.unitKey) || parsed.data.status === 'verified') labels.set(parsed.data.unitKey, parsed.data);
    }
    if (basis) {
      for (const verdict of records(record(referenceValue.referenceJudgment).verdicts)) {
        const parsed = researchLabelSchema.safeParse({ ...verdict, campaignId: this.scope.campaignId, benchmark, status: 'suggested' });
        if (parsed.success && !labels.has(parsed.data.unitKey)) labels.set(parsed.data.unitKey, parsed.data);
      }
    }

    const sourceRoots: ResearchSnapshotExport['sourceRoots'] = [];
    const source = selected.sourceRef ? this.sources.get(selected.sourceRef) : null;
    if (selected.sourceRef && !source) throw new Error('Research source reference is not registered');
    if (source) {
      if (source.role !== 'workflows' || (selected.arm === 'excluded' ? source.arm !== 'excluded' : source.arm === 'excluded')) {
        throw new Error('Research source policy disagrees with observation arm');
      }
      const details = await lstat(source.root).catch(() => null);
      if (details?.isSymbolicLink()) throw new Error('Symlink research source root');
      if (source.available && details?.isDirectory()) {
        const canonical = await realpath(source.root);
        if (canonical !== source.canonicalRoot) throw new Error('Registered research source root changed');
        if (selected.arm === 'excluded') {
          for (const normal of this.sources.values()) {
            if (normal.arm !== 'standard' || !normal.canonicalRoot) continue;
            if (canonical === normal.canonicalRoot || contained(canonical, normal.canonicalRoot) || contained(normal.canonicalRoot, canonical)) {
              throw new Error('Excluded research source must be a separate filtered root');
            }
          }
        }
        sourceRoots.push({ name: selected.arm === 'excluded' ? 'filtered-workflows' : 'workflows', path: canonical });
      }
    }
    if (!sourceRoots.length) omissions.push({ reason: 'source_root_not_captured' });
    if (!parent) omissions.push({ reason: 'baseline_not_captured' });
    if (!referenceFile) omissions.push({ reason: 'matching_frozen_reference_not_captured' });
    const labelHash = matchingFrozen ? referenceValue.labelSetHash : referenceValue.labelHash;
    const data: ResearchSnapshotExport['data'] = {
      schemaVersion: 1, snapshotRef,
      observation: { campaignId: this.scope.campaignId, variantId: selected.variantId, arm: selected.arm,
        benchmark: selected.benchmark, role: selected.role, actionId: selected.actionId, labelSetHash: selected.labelSetHash },
      replicates: selected.replicas.map((replica) => {
        const facts = researchFactsSchema.parse(replica.facts) as RunFacts;
        const removed = records(replica.facts.units).reduce((sum, unit) => sum + records(unit.sourceRefs).length, 0) -
          facts.units.reduce((sum, unit) => sum + unit.sourceRefs.length, 0);
        if (removed) omissions.push({ reason: 'unsafe_source_refs_excluded', count: removed });
        return { replicate: replica.replicate, facts, artifactRef: replica.file.evidenceRef };
      }),
      reference: { availability: referenceFile ? 'available' : 'not_captured',
        source: matchingFrozen ? 'investigator_reference' : basis ? 'archived_score_basis' : 'not_captured',
        artifactRef: referenceFile?.evidenceRef ?? null, labelSetHash: typeof labelHash === 'string' ? redactResearchText(labelHash) : null,
        labels: [...labels.values()] },
      artifactBindings: [...bindings.values()].map((file) => ({ evidenceRef: file.evidenceRef, kind: file.kind,
        artifactPath: path.relative(this.scope.artifactRoot, path.join(file.root, file.relative)),
        sha256: `sha256:${file.sha256}`, bytes: file.size, integrity: 'verified_content_hash' })),
      sourcePolicy: { availability: sourceRoots.length ? 'available' : 'not_captured', sourceRef: selected.sourceRef,
        mode: selected.arm === 'excluded' ? 'filtered_measurement_source' : 'normal_frozen_source', binding: 'coordinator_scope', publicationRequired: true,
        description: 'Only the observation-registered workflows root may be published. Filter secret files and symlinks; publish read-only copies. No raw context, environment, log, or model API response is included.' },
      interpretation: 'Artifact content hashes are verified, not planner correctness. Rationales and suggested labels remain unverified interpretations. This is a schema-projected research copy, not the original artifact bytes.',
      omissions: this.compactOmissions(omissions),
    };
    // Redact string values, never serialized JSON: measured token counters remain numeric.
    const sanitized = JSON.parse(JSON.stringify(data), (_key: string, value: unknown) =>
      typeof value === 'string' ? redactResearchText(value) : value) as ResearchSnapshotExport['data'];
    return { data: sanitized, sourceRoots };
  }

  private async observation(snapshotRef: string): Promise<Observation> {
    await this.ready();
    if (!this.observations.has(snapshotRef)) await this.refresh();
    const observation = this.observations.get(snapshotRef);
    if (!observation) throw new Error('Unknown or out-of-scope snapshot reference');
    for (const file of observation.files) await this.assertUnchanged(file);
    return observation;
  }

  private parentBaseline(observation: Observation): Observation | null {
    const parentId = path.basename(this.scope.parentArtifactDirectory);
    const matches = (item: Observation) => item.variantId === parentId && item.role === 'baseline' &&
      item.arm === observation.arm && item.benchmark === observation.benchmark;
    const frozen = this.baselineRef ? this.observations.get(this.baselineRef) : null;
    if (frozen && matches(frozen)) return frozen;
    // Historical handles stay resolvable, but automatic selection uses only the current catalog.
    return this.catalog.filter((row) => row.kind === 'observation')
      .map((row) => this.observations.get(String(row.snapshotRef))).find((item) => item && matches(item)) ?? null;
  }

  async compareTrial(input: CompareTrialQuery) {
    const query = CompareTrialQuerySchema.parse(input);
    const trial = await this.observation(query.snapshotRef);
    const parent = this.parentBaseline(trial);
    if (parent) await this.observation(parent.snapshotRef);
    const baseline = query.baselineSnapshotRef ? await this.observation(query.baselineSnapshotRef) :
      parent;
    if (baseline && (baseline.arm !== trial.arm || baseline.benchmark !== trial.benchmark)) throw new Error('Comparison snapshots have different benchmark or arm scopes');
    // Freeze the diagnostic denominator independently of each run's recorded promotion score.
    const useInvestigatorReference = parent?.snapshotRef === this.baselineRef && this.reference !== null;
    const basis = useInvestigatorReference ? null : parent?.scoreBasis ?? null;
    const basisValue = useInvestigatorReference ? this.referenceValue : basis?.value ?? {};
    const basisBenchmark = trial.arm === 'excluded' ? `${trial.benchmark}:target-excluded` : trial.benchmark;
    const labelMap = new Map<string, Row>();
    for (const label of records(basisValue.labels)) {
      if (label.campaignId !== this.scope.campaignId || label.benchmark !== basisBenchmark || typeof label.unitKey !== 'string') continue;
      if (!labelMap.has(label.unitKey) || label.status === 'verified') labelMap.set(label.unitKey, label);
    }
    if (basis) {
      for (const verdict of records(record(basisValue.referenceJudgment).verdicts)) {
        if (typeof verdict.unitKey === 'string' && !labelMap.has(verdict.unitKey)) {
          labelMap.set(verdict.unitKey, { ...verdict, status: 'suggested', source: 'archived_reference_judgment' });
        }
      }
    }
    const labels = [...labelMap.values()];
    const trialHistograms = histograms(trial);
    const baselineHistograms = baseline ? histograms(baseline) : null;
    const keys = [...new Set([...trialHistograms.byUnit.keys(), ...(baselineHistograms?.byUnit.keys() ?? []), ...labelMap.keys()])].sort();
    const choices = new Map([trial, ...(baseline ? [baseline] : [])].map((observation) => [observation, observation.replicas.map((replica) => units(replica.facts))]));
    const agreement = (observation: Observation | null, key?: string): number | null => {
      if (!observation || !labels.length) return null;
      const label = key === undefined ? null : labelMap.get(key);
      const expected = key === undefined ? labels : label ? [label] : [];
      if (!expected.length) return null;
      return choices.get(observation)!.reduce((sum, replica) =>
        sum + expected.filter((label) => replica.get(String(label.unitKey))?.decision === label.expectedDecision).length / expected.length,
      0) / observation.replicas.length;
    };
    const rows = keys.map((key) => {
      const before = baselineHistograms ? baselineHistograms.byUnit.get(key) ?? {} : null;
      const after = trialHistograms.byUnit.get(key) ?? {};
      const changed = before === null ? null : JSON.stringify(before) !== JSON.stringify(after);
      return { unitRef: this.id('unit', [trial.snapshotRef, key]), baselineUnitRef: baseline && baselineHistograms?.byUnit.has(key) ? this.id('unit', [baseline.snapshotRef, key]) : null, unitKey: key, before, after, changed,
        expectedDecision: labelMap.get(key)?.expectedDecision ?? null, labelStatus: labelMap.get(key)?.status ?? null,
        baselineAgreement: agreement(baseline, key), trialAgreement: agreement(trial, key) };
    });
    for (const key of keys) this.unitRefs.set(this.id('unit', [trial.snapshotRef, key]), { snapshotRef: trial.snapshotRef, key });
    const before = baselineHistograms?.aggregate ?? null;
    const after = trialHistograms.aggregate;
    const frozenHashValue = useInvestigatorReference ? this.referenceValue.labelSetHash : basisValue.labelHash;
    const frozenHash = typeof frozenHashValue === 'string' ? frozenHashValue : null;
    const omissions: EvidenceOmission[] = [];
    if (!baseline) omissions.push({ reason: 'baseline_not_captured' });
    if (!parent && query.baselineSnapshotRef) omissions.push({ reason: 'scoped_parent_not_captured' });
    if (!labels.length) omissions.push({ reason: 'fixed_labels_not_captured' });
    if (!trial.score) omissions.push({ reason: 'recorded_trial_score_not_captured' });
    if (!trial.baselineScore && !baseline?.score) omissions.push({ reason: 'recorded_baseline_score_not_captured' });
    if (trial.labelSetHash && trial.labelSetHash !== frozenHash) omissions.push({ reason: 'recorded_score_label_basis_mismatch' });
    return this.page(trial.snapshotRef, query.changedOnly ? rows.filter((row) => row.changed) : rows, query,
      ['compare', baseline?.snapshotRef, query.changedOnly ?? false, this.reference?.evidenceRef], {
        evidenceRef: trial.files[0]!.evidenceRef,
        baselineSnapshotRef: baseline?.snapshotRef ?? null,
        baselineEvidenceRef: baseline?.files[0]?.evidenceRef ?? null,
        summary: { unitCount: keys.length, changedUnitCount: baseline ? rows.filter((row) => row.changed).length : null,
          sameAggregateHistogram: baseline ? JSON.stringify(before) === JSON.stringify(after) : null,
          baselineHistogram: before, trialHistogram: after, baselineMeanAgreement: agreement(baseline), trialMeanAgreement: agreement(trial) },
        recordedScores: { trial: trial.score, baseline: trial.baselineScore ?? baseline?.score ?? null,
          trialBasisRef: trial.scoreBasis?.file.evidenceRef ?? trial.files[0]?.evidenceRef ?? null,
          baselineBasisRef: trial.baselineScore ? trial.files[0]?.evidenceRef ?? null : baseline?.scoreBasis?.file.evidenceRef ?? baseline?.files[0]?.evidenceRef ?? null },
        labelBasis: { evidenceRef: useInvestigatorReference ? this.reference?.evidenceRef ?? null : basis?.file.evidenceRef ?? null,
          source: useInvestigatorReference ? 'investigator_reference' : basis ? 'archived_baseline_score_basis' : 'not_captured',
          labelSetHash: frozenHash, recordedLabelSetHash: trial.labelSetHash,
          interpretation: 'Fixed-label agreement is diagnostic, not a new promotion score. Suggested labels are unverified judgments; missing choices count as disagreement.' },
      }, omissions);
  }

  async inspectUnit(input: InspectUnitQuery) {
    const query = InspectUnitQuerySchema.parse(input);
    await this.ready();
    if (!this.unitRefs.has(query.unitRef)) await this.refresh();
    let reference = this.unitRefs.get(query.unitRef);
    // Removed units still have comparison handles, including across transport restarts.
    if (!reference) {
      for (const observation of this.observations.values()) {
        for (const baseline of this.observations.values()) {
          if ((baseline !== observation && baseline.role !== 'baseline') || baseline.arm !== observation.arm || baseline.benchmark !== observation.benchmark) continue;
          const labelKeys = [...records(this.referenceValue.labels).filter((label) => observation.arm === 'standard' && label.benchmark === observation.benchmark),
            ...records(baseline.scoreBasis?.value.labels), ...records(record(baseline.scoreBasis?.value.referenceJudgment).verdicts)]
            .flatMap((label) => typeof label.unitKey === 'string' ? [label.unitKey] : []);
          const keys = new Set([...baseline.replicas.flatMap((replica) => [...units(replica.facts).keys()]), ...labelKeys]);
          for (const key of keys) {
            if (this.id('unit', [observation.snapshotRef, key]) === query.unitRef) reference = { snapshotRef: observation.snapshotRef, key };
          }
        }
      }
      if (reference) this.unitRefs.set(query.unitRef, reference);
    }
    if (!reference) throw new Error('Unknown or out-of-scope unit reference');
    const observation = await this.observation(reference.snapshotRef);
    const rows: Row[] = [];
    const omissions: EvidenceOmission[] = [];
    const source = observation.sourceRef ? this.sources.get(observation.sourceRef) : null;
    for (const replica of observation.replicas) {
      const unit = units(replica.facts).get(reference.key);
      if (!unit) {
        rows.push({ replicate: replica.replicate, availability: 'not_captured', evidenceRef: replica.file.evidenceRef });
        omissions.push({ reason: 'unit_not_captured_in_replicate', count: 1 });
        continue;
      }
      const sourceRefs = await Promise.all(records(unit.sourceRefs).map(async (item) => {
        let file: FileEntry | null = null;
        if (source?.available && typeof item.path === 'string' && safeRelative(item.path)) {
          try { file = await this.register(source.root, item.path, 'source_excerpt', `source:${source.sourceRef}`); }
          catch (error) {
            if (error instanceof Error && error.message.includes('integrity failure')) throw error;
            // Missing or unsafe selected source is explicit, never a fallback to full source.
          }
        }
        return { path: typeof item.path === 'string' && safeRelative(item.path) ? item.path : null, symbol: item.symbol ?? null,
          capabilityId: item.capabilityId ?? null, evidenceRef: file?.evidenceRef ?? null, availability: file ? 'available' : 'not_captured' };
      }));
      const row: Row = { replicate: replica.replicate, decision: unit.decision, confidence: unit.confidence ?? null,
        selectedCandidateIds: unit.selectedCandidateIds ?? null, shortlistCandidateCount: unit.shortlistCandidateCount ?? null,
        discoveredEvidenceCount: unit.discoveredEvidenceCount ?? null, sourceRefs, evidenceRef: replica.file.evidenceRef,
        rawAnalysis: { availability: replica.analysis ? 'available_on_request' : 'not_captured', evidenceRef: replica.analysis?.evidenceRef ?? null } };
      if (query.includeRationale) row.rationale = unit.rationale ?? { availability: 'not_captured' };
      if (query.includeRawAnalysis && replica.analysis) {
        const envelope = await this.json(replica.analysis);
        const analysis = record(envelope.analysis ?? envelope);
        const adjudication = records(analysis.adjudications).find((item) => item.requirementUnitId === unit.id);
        row.rawAnalysis = adjudication ? {
          evidenceRef: replica.analysis.evidenceRef, shortlist: adjudication.shortlist ?? { availability: 'not_captured' },
          evidenceGrounding: adjudication.evidenceGrounding ?? { availability: 'not_captured' },
          discoveredLinks: adjudication.discoveredLinks ?? adjudication.discoveredEvidence ?? { availability: 'not_captured' },
        } : { availability: 'not_captured', evidenceRef: replica.analysis.evidenceRef };
      }
      for (const field of ['rationale', 'sourceRefs', 'selectedCandidateIds', 'rawAnalysis']) {
        if (row[field] !== undefined && bytes(row[field]) > Math.min(4_096, (query.maxBytes ?? EVIDENCE_DEFAULT_BYTES) / 4)) {
          const evidenceRef = field === 'rawAnalysis' ? replica.analysis?.evidenceRef ?? replica.file.evidenceRef : replica.file.evidenceRef;
          row[field] = { availability: 'omitted', reason: 'byte_limit', evidenceRef };
          omissions.push({ reason: 'byte_limit', field, evidenceRef });
        }
      }
      rows.push(row);
    }
    return this.page(observation.snapshotRef, rows, query, ['unit', query.unitRef, query.includeRationale ?? false, query.includeRawAnalysis ?? false],
      { unitRef: query.unitRef, unitKey: reference.key }, omissions, rows.some((row) => row.availability !== 'not_captured'));
  }

  /** Offsets and limits are UTF-8 bytes, not lines. nextOffset is always a character boundary. */
  async readEvidence(input: ReadEvidenceQuery) {
    const query = ReadEvidenceQuerySchema.parse(input);
    await this.ready();
    let file = this.files.get(query.evidenceRef);
    if (!file) { await this.refresh(); file = this.files.get(query.evidenceRef); }
    if (!file) {
      for (const source of this.sources.values()) {
        await this.loadSource(source);
        file = this.files.get(query.evidenceRef);
        if (file) break;
      }
    }
    if (!file) throw new Error('Unknown or out-of-scope evidence reference');
    const content = await this.verified(file);
    if (content.includes(0)) throw new Error('Evidence is not captured as text');
    try { new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { throw new Error('Evidence is not UTF-8 text'); }
    const offset = query.offset ?? 0;
    if (offset > content.length || (offset < content.length && (content[offset]! & 0xc0) === 0x80)) throw new Error('Invalid UTF-8 byte offset');
    const max = query.maxBytes ?? EVIDENCE_DEFAULT_BYTES;
    let end = Math.min(content.length, offset + (query.limit ?? 8_192));
    const boundary = () => { while (end > offset && end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1; };
    boundary();
    const response = { schemaVersion: 1 as const, snapshotRef: this.id('snapshot', file.evidenceRef), items: [] as Row[], returnedCount: 0,
      totalMatched: content.length, nextCursor: null, nextOffset: null as number | null, availability: 'available' as EvidenceResponse['availability'],
      omissions: [] as EvidenceOmission[], evidenceRef: file.evidenceRef, evidenceKind: file.kind, offset, offsetUnit: 'utf8_bytes', byteLength: 0 };
    for (;;) {
      response.items = end > offset ? [{ text: content.subarray(offset, end).toString('utf8'), offset, endOffset: end }] : [];
      response.returnedCount = response.items.length;
      response.nextOffset = end < content.length ? end : null;
      response.availability = end < content.length ? 'partial' : 'available';
      response.omissions = end < content.length ? [{ reason: 'continued_at_nextOffset', evidenceRef: file.evidenceRef }] : [];
      sizeResponse(response);
      if (response.byteLength <= max) break;
      end = offset + Math.floor((end - offset) * 0.75);
      boundary();
    }
    if (end === offset && offset < content.length) throw new Error('Read limit is smaller than the next UTF-8 character');
    return response;
  }

  async searchSource(input: SearchSourceQuery) {
    const query = SearchSourceQuerySchema.parse(input);
    await this.ready();
    const source = query.sourceRef ? this.sources.get(query.sourceRef) : await this.source(this.scope.workflowsSource, 'standard', 'workflows');
    if (!source) throw new Error('Unknown or out-of-scope source reference');
    await this.loadSource(source);
    const rows: Row[] = [];
    const omissions = [...source.omissions];
    for (const file of source.files) {
      const content = await this.verified(file);
      if (content.includes(0)) { omissions.push({ reason: 'non_text_source', count: 1 }); continue; }
      const lines = content.toString('utf8').split('\n');
      let offset = 0;
      for (const [index, line] of lines.entries()) {
        if (line.includes(query.query)) rows.push({ evidenceRef: file.evidenceRef, path: file.relative, line: index + 1, offset, offsetUnit: 'utf8_bytes' });
        offset += Buffer.byteLength(line) + 1;
      }
    }
    return this.page(this.id('snapshot', [source.sourceRef, source.files.map((file) => file.evidenceRef)]), rows, query, ['source', source.sourceRef, query.query], {
      sourceRef: source.sourceRef, sourcePolicy: source.arm === 'excluded' ? 'filtered_measurement_source' : 'normal_frozen_source',
      matching: 'literal_case_sensitive', snippets: 'readEvidence_on_demand',
    }, omissions, source.files.length > 0);
  }
}
