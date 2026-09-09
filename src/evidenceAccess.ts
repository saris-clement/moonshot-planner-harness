import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EvidenceStore, CompareTrialQuerySchema, InspectUnitQuerySchema, ListObservationsQuerySchema,
  ReadEvidenceQuerySchema, SearchSourceQuerySchema, type EvidenceScopeManifest } from './evidence.js';
import { readResearchOutput, readResearchUrl, runResearchShell, type ResearchScope } from './researchSandbox.js';
import { validateResearchHosts } from './researchSandboxBroker.js';
import { redactResearchText } from './researchSandboxSnapshot.js';

export const EVIDENCE_SERVER_NAME = 'harness_evidence';
export const evidenceReadSchemas = {
  list_observations: ListObservationsQuerySchema,
  compare_trial: CompareTrialQuerySchema,
  inspect_unit: InspectUnitQuerySchema,
  read_evidence: ReadEvidenceQuerySchema,
  search_source: SearchSourceQuerySchema,
};
const observationRef = z.string().regex(/^snapshot_[a-f0-9]{64}$/).describe('snapshotRef of an observation from list_observations, not the catalog snapshotRef.');
const timeoutMs = z.number().int().min(100).max(300_000).optional();
export const evidenceToolSchemas = {
  ...evidenceReadSchemas,
  research_shell: z.object({ observationRef, command: z.string().min(1).max(65_536), timeoutMs }).strict(),
  research_http: z.object({ observationRef, url: z.string().min(1).max(8_192), method: z.enum(['GET', 'HEAD']).optional(), followRedirects: z.boolean().optional(), timeoutMs }).strict(),
  research_output: z.object({ observationRef, invocationId: z.string().regex(/^research-[a-f0-9-]{36}$/),
    stream: z.enum(['stdout', 'stderr']), offset: z.number().int().min(0).optional(), limit: z.number().int().min(4).max(16_384).optional() }).strict(),
};
export type EvidenceReadTool = keyof typeof evidenceReadSchemas;
const idSchema = z.string().max(256).regex(/^(?!\.{1,2}$)[\w.-]+$/);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeFiles = ['evidenceAccess', 'evidenceMcp', 'evidence', 'researchSandbox', 'researchSandboxBroker', 'researchSandboxSnapshot', 'types']
  .map((name) => `${name}${path.extname(fileURLToPath(import.meta.url))}`);
const defaultHosts = ['opencode.ai', 'modelcontextprotocol.io', 'nodejs.org', 'developer.mozilla.org', 'github.com',
  'raw.githubusercontent.com', 'api.github.com', 'typescriptlang.org', 'docs.docker.com'];

// Resolve missing archive/source leaves without creating them. Existing symlinks at a scope leaf are never authority.
function canonical(value: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f,*?{}\[\]\\]/.test(value)) throw new Error('Invalid evidence scope path');
  try {
    if (lstatSync(value).isSymbolicLink()) throw new Error('Symlink evidence scope path');
    return realpathSync(value);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return path.join(canonical(path.dirname(value)), path.basename(value));
  }
}
function existsDirectory(value: string): boolean {
  try {
    if (!lstatSync(value).isDirectory()) throw new Error('Evidence scope must be a directory, not a symlink');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
function scopedPath(value: string, expected: string): string {
  if (canonical(value) !== expected) throw new Error('Evidence path escaped the canonical campaign scope');
  return expected;
}

/** Coordinator-only: context paths are checked against harness roots, never model tool arguments. */
export function evidenceScopeFromContext(
  campaign: { id: string }, variant: { id: string; campaignId: string; parentVariantId: string | null },
  worktree: string, artifactDirectory: string, context: unknown,
): EvidenceScopeManifest {
  idSchema.parse(campaign.id); idSchema.parse(variant.id);
  if (variant.campaignId !== campaign.id) throw new Error('Variant belongs to another campaign');
  const artifacts = z.object({ artifacts: z.object({ current: z.string(), parent: z.string().optional(), workflowsSource: z.string(),
    priorExperiments: z.array(z.object({ id: idSchema, directory: z.string() })).default([]),
  }) }).parse(context).artifacts;
  const artifactRoot = canonical(path.dirname(path.dirname(artifactDirectory)));
  const campaignRoot = path.join(artifactRoot, campaign.id);
  const current = scopedPath(artifactDirectory, path.join(campaignRoot, variant.id));
  scopedPath(artifacts.current, current);
  const worktrees = path.join(canonical(path.dirname(artifactRoot)), 'worktrees', campaign.id);
  const plannerSource = scopedPath(worktree, path.join(worktrees, variant.id));
  const workflowsSource = scopedPath(artifacts.workflowsSource, path.join(worktrees, 'frozen-workflows'));
  const parentId = idSchema.parse(variant.parentVariantId ?? variant.id);
  const parent = scopedPath(artifacts.parent ?? path.join(campaignRoot, parentId), path.join(campaignRoot, parentId));
  const standard = new Map([[variant.id, current], [parentId, parent]]);
  for (const prior of artifacts.priorExperiments) standard.set(prior.id, scopedPath(prior.directory, path.join(campaignRoot, prior.id)));
  const allowedObservations: NonNullable<EvidenceScopeManifest['allowedObservations']> = [];
  const filtered = path.join(worktrees, 'target-excluded-workflows');
  const sourceRoot = existsDirectory(filtered) ? scopedPath(filtered, filtered) : undefined;
  for (const [variantId, directory] of standard) {
    if (variantId !== variant.id && variantId !== parentId && existsDirectory(directory)) {
      allowedObservations.push({ variantId, artifactDirectory: directory, arm: 'standard' });
    }
    for (const arm of ['control', 'excluded'] as const) {
      const armDirectory = path.join(directory, 'target-excluded', arm);
      if (existsDirectory(armDirectory)) allowedObservations.push({ variantId, artifactDirectory: scopedPath(armDirectory, armDirectory), arm,
        ...(arm === 'excluded' && sourceRoot ? { sourceRoot } : {}) });
    }
  }
  return { version: 1, campaignId: campaign.id, variantId: variant.id, artifactRoot, currentArtifactDirectory: current,
    parentArtifactDirectory: parent, workflowsSource, plannerSource, referencePath: path.join(current, 'investigator-reference.json'), allowedObservations };
}

function validateScope(scope: EvidenceScopeManifest): EvidenceScopeManifest {
  const validated = evidenceScopeFromContext({ id: scope.campaignId }, {
    id: scope.variantId, campaignId: scope.campaignId, parentVariantId: path.basename(scope.parentArtifactDirectory),
  }, scope.plannerSource, scope.currentArtifactDirectory, { artifacts: {
    current: scope.currentArtifactDirectory, parent: scope.parentArtifactDirectory, workflowsSource: scope.workflowsSource,
    priorExperiments: (scope.allowedObservations ?? []).map((item) => ({ id: item.variantId, directory: path.join(scope.artifactRoot, scope.campaignId, item.variantId) })),
  } });
  if (scope.version !== 1 || canonical(scope.artifactRoot) !== validated.artifactRoot || canonical(scope.referencePath) !== validated.referencePath) {
    throw new Error('Invalid evidence manifest scope');
  }
  // Preserve the manifest's original registrations; new arms must not silently expand an invocation.
  for (const item of scope.allowedObservations ?? []) {
    const root = path.join(validated.artifactRoot, scope.campaignId, idSchema.parse(item.variantId));
    scopedPath(item.artifactDirectory, item.arm === 'standard' ? root : path.join(root, 'target-excluded', item.arm));
    if (!['standard', 'control', 'excluded'].includes(item.arm)) throw new Error('Invalid observation arm');
    if (item.sourceRoot) {
      if (item.arm !== 'excluded') throw new Error('Only excluded observations may override their frozen source');
      scopedPath(item.sourceRoot, path.join(path.dirname(validated.plannerSource), 'target-excluded-workflows'));
    }
  }
  new EvidenceStore(scope);
  return structuredClone(scope);
}

/** For the trusted helper only. Docker context is never forwarded to the model's container. */
export function evidenceHelperEnvironment(environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'HARNESS_RESEARCH_IMAGE'].flatMap((name) => environment[name] ? [[name, environment[name]!]] : []));
}

const ManifestSchema = z.object({ version: z.literal(1), scope: z.custom<EvidenceScopeManifest>((value) => !!value && typeof value === 'object'),
  turn: z.number().int().min(0).max(999_999), invocationId: z.string().uuid(), createdAt: z.string(), allowedHttpHosts: z.array(z.string()).max(64),
  runtimeSourceHashes: z.record(z.string(), shaSchema), referenceSha256: shaSchema.nullable() }).strict();
type InvocationManifest = z.infer<typeof ManifestSchema>;

async function immutable(filename: string, value: unknown): Promise<string> {
  const text = JSON.stringify(value);
  await writeFile(filename, text, { flag: 'wx', mode: 0o400 });
  return hash(text);
}
async function safeBytes(filename: string, maxBytes: number): Promise<Buffer> {
  if (canonical(filename) !== filename) throw new Error('Noncanonical evidence audit path');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Evidence audit file is not a bounded regular file');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || before.mtimeMs !== after.mtimeMs || canonical(filename) !== filename) throw new Error('Evidence audit changed while reading');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
async function referenceHash(scope: EvidenceScopeManifest): Promise<string | null> {
  try { return hash(await safeBytes(scope.referencePath, 32 * 1_024 * 1_024)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function prepareEvidenceInvocation(scope: EvidenceScopeManifest, turn: number): Promise<{
  manifestPath: string; store: EvidenceStore; auditDirectory: string;
}> {
  scope = validateScope(scope);
  z.number().int().min(0).max(999_999).parse(turn);
  const allowedHttpHosts = [...new Set([...defaultHosts, ...(process.env.HARNESS_RESEARCH_HTTP_HOSTS === undefined ? [] :
    process.env.HARNESS_RESEARCH_HTTP_HOSTS.split(',').map((host) => host.trim().toLowerCase()))])];
  validateResearchHosts(allowedHttpHosts);
  const manifest: InvocationManifest = ManifestSchema.parse({ version: 1, scope, turn, invocationId: randomUUID(), createdAt: new Date().toISOString(), allowedHttpHosts,
    runtimeSourceHashes: Object.fromEntries(await Promise.all(runtimeFiles.map(async (name) => [name, hash(await readFile(path.join(runtimeDirectory, name)))]))),
    referenceSha256: await referenceHash(scope) });
  // EvidenceStore deliberately skips .data: audit writes must not change catalog snapshots/cursors,
  // and research input copies must never be rediscovered as original planner observations.
  const turnDirectory = path.join(scope.currentArtifactDirectory, 'evidence-access', `turn-${String(turn).padStart(3, '0')}`, '.data');
  scopedPath(turnDirectory, turnDirectory);
  await mkdir(turnDirectory, { recursive: true, mode: 0o700 });
  const auditDirectory = path.join(turnDirectory, manifest.invocationId);
  await mkdir(auditDirectory, { mode: 0o700 });
  await Promise.all(['calls', 'index', 'bundles', 'scratch'].map((name) => mkdir(path.join(auditDirectory, name), { mode: 0o700 })));
  const manifestPath = path.join(auditDirectory, 'manifest.json');
  await immutable(manifestPath, manifest);
  return { manifestPath, store: new EvidenceStore(scope), auditDirectory };
}

export async function queryEvidence(store: EvidenceStore, tool: string, query: unknown): Promise<unknown> {
  switch (tool) {
    case 'list_observations': return store.listObservations(ListObservationsQuerySchema.parse(query));
    case 'compare_trial': return store.compareTrial(CompareTrialQuerySchema.parse(query));
    case 'inspect_unit': return store.inspectUnit(InspectUnitQuerySchema.parse(query));
    case 'read_evidence': return store.readEvidence(ReadEvidenceQuerySchema.parse(query));
    case 'search_source': return store.searchSource(SearchSourceQuerySchema.parse(query));
    default: throw new Error('Only the five read-only evidence tools are available');
  }
}

const resultFor = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
// Include JSON-string escaping and the MCP result envelope, leaving space for JSON-RPC framing.
const fits = (value: CallToolResult) => Buffer.byteLength(JSON.stringify(value)) <= 64 * 1_024 - 1_024;
const SummarySchema = z.object({ id: z.string().regex(/^\d{13}-[a-f0-9-]{36}$/), tool: z.string().max(128),
  scope: z.object({ campaignId: idSchema, variantId: idSchema, turn: z.number().int(), observationRef: observationRef.optional() }).strict(),
  createdAt: z.string().max(64), bytes: z.number().int().nonnegative(), status: z.enum(['ok', 'error']),
  requestRef: z.string().max(1_024), responseRef: z.string().max(1_024) }).strict();
type Summary = z.infer<typeof SummarySchema>;

export class EvidenceAccess {
  readonly store: EvidenceStore;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly research = new Map<string, { observationRef: string; scope: ResearchScope }>();
  constructor(readonly manifest: InvocationManifest, readonly manifestPath: string, readonly manifestSha256: string) {
    this.store = new EvidenceStore(manifest.scope);
  }
  get auditDirectory(): string { return path.dirname(this.manifestPath); }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private async researchScope(ref: string, callId: string): Promise<ResearchScope> {
    const { artifactDirectory, sourceRoots } = await this.serial(async () => {
      const snapshot = await this.store.exportResearchSnapshot(ref);
      const data = JSON.stringify(snapshot.data);
      // The sandbox omits individual files larger than 2 MiB. Fail clearly rather than mount an empty bundle.
      if (Buffer.byteLength(data) > 2 * 1_024 * 1_024) throw new Error('Research observation exceeds the 2 MiB published data.json limit; use paginated evidence tools');
      const bundleHash = hash(data);
      const artifactDirectory = path.join(this.auditDirectory, 'bundles', bundleHash);
      scopedPath(artifactDirectory, artifactDirectory);
      await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
      const filename = path.join(artifactDirectory, 'data.json');
      try { await immutable(filename, snapshot.data); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        if (hash(await safeBytes(filename, 2 * 1_024 * 1_024)) !== bundleHash) throw new Error('Research bundle integrity failure');
      }
      return { artifactDirectory, sourceRoots: snapshot.sourceRoots };
    });
    const scratchDirectory = path.join(this.auditDirectory, 'scratch', callId);
    await mkdir(scratchDirectory, { mode: 0o700 });
    return { worktreePath: this.manifest.scope.plannerSource, sourceRoots,
      artifactDirectory, scratchDirectory, allowedHttpHosts: this.manifest.allowedHttpHosts };
  }
  private async execute(tool: string, args: unknown, callId: string, signal?: AbortSignal): Promise<CallToolResult> {
    if (Object.hasOwn(evidenceReadSchemas, tool)) return this.serial(async () => {
      // Validate the original arguments before imposing a smaller transport budget.
      const schema = evidenceReadSchemas[tool as EvidenceReadTool];
      const query = schema.parse(args);
      let maxBytes = Math.min(query.maxBytes ?? 16_384, 32_768);
      while (true) {
        const result = resultFor(await queryEvidence(this.store, tool, { ...query, maxBytes }));
        if (fits(result)) return result;
        if (maxBytes <= 2_048) throw new Error('Evidence response exceeds the MCP JSON byte limit');
        maxBytes = Math.max(2_048, Math.floor(maxBytes / 2));
      }
    });
    if (tool === 'research_output') {
      const query = evidenceToolSchemas.research_output.parse(args);
      const binding = this.research.get(query.invocationId);
      if (!binding || binding.observationRef !== query.observationRef) throw new Error('Research output is not bound to this observation and invocation');
      return resultFor(await readResearchOutput(binding.scope, { invocationId: query.invocationId, stream: query.stream,
        offset: query.offset ?? 0, limit: Math.min(query.limit ?? 8_192, 8_192) }));
    }
    if (tool !== 'research_shell' && tool !== 'research_http') throw new Error('Unknown evidence tool');
    const query = evidenceToolSchemas[tool].parse(args);
    signal?.throwIfAborted();
    const scope = await this.researchScope(query.observationRef, callId);
    signal?.throwIfAborted();
    let result;
    try {
      const options = { timeoutMs: query.timeoutMs ?? 30_000, ...(signal ? { signal } : {}) };
      result = 'command' in query ? await runResearchShell(scope, { command: query.command, ...options }) :
        await readResearchUrl(scope, { url: query.url, method: query.method ?? 'GET', followRedirects: query.followRedirects ?? true, ...options });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Docker setup|spawn docker|No such image|image must resolve/i.test(message)) {
        throw new Error(`Research prerequisite: a running Docker daemon and an operator-built ainative-planner-research:local image (or HARNESS_RESEARCH_IMAGE) are required. No image is built or pulled automatically. ${message}`);
      }
      throw error;
    }
    this.research.set(result.invocationId, { observationRef: query.observationRef, scope });
    // Raw host paths are not tool capabilities. Pagination uses only the observation and invocation IDs.
    const safe = { ...result, observationRef: query.observationRef, artifacts: Object.fromEntries(Object.entries(result.artifacts)
      .map(([name, filename]) => [name, path.relative(this.manifest.scope.currentArtifactDirectory, filename)])) };
    for (const stream of ['stdout', 'stderr'] as const) {
      const fullPreview = safe[stream];
      if (Buffer.byteLength(fullPreview) > 4_096) {
        safe[stream] = new TextDecoder().decode(Buffer.from(fullPreview).subarray(0, 4_096)).replace(/\ufffd$/, '');
        const totalBytes = safe.pagination.find((page) => page.stream === stream)?.totalBytes ?? Buffer.byteLength(fullPreview);
        safe.pagination = safe.pagination.filter((page) => page.stream !== stream);
        safe.pagination.push({ invocationId: safe.invocationId, stream, nextOffset: Buffer.byteLength(safe[stream]), totalBytes });
        safe.truncated = true;
      }
    }
    return resultFor(safe);
  }
  async callTool(tool: string, args: unknown = {}, signal?: AbortSignal): Promise<CallToolResult> {
    const id = `${Date.now()}-${randomUUID()}`;
    const directory = path.join(this.auditDirectory, 'calls', id);
    validateScope(this.manifest.scope);
    scopedPath(path.dirname(directory), path.dirname(directory));
    await mkdir(directory, { mode: 0o700 });
    const requestSha256 = await immutable(path.join(directory, 'request.json'), { name: tool, arguments: args });
    let response: CallToolResult;
    try {
      if (hash(await safeBytes(this.manifestPath, 1_048_576)) !== this.manifestSha256) throw new Error('Evidence manifest hash changed');
      if (await referenceHash(this.manifest.scope) !== this.manifest.referenceSha256) throw new Error('Evidence reference hash changed');
      signal?.throwIfAborted();
      response = await this.execute(tool, args, id, signal);
      if (!fits(response)) throw new Error('Tool response exceeds the MCP JSON byte limit');
    } catch (error) {
      response = resultFor({ error: redactResearchText(error instanceof Error ? error.message : String(error)).slice(0, 4_000) }, true);
    }
    const responseSha256 = await immutable(path.join(directory, 'response.json'), response);
    const ref = observationRef.safeParse(args && typeof args === 'object' && 'observationRef' in args ? args.observationRef : undefined);
    const summary: Summary = { id, tool: tool.slice(0, 128), scope: { campaignId: this.manifest.scope.campaignId, variantId: this.manifest.scope.variantId, turn: this.manifest.turn,
      ...(ref.success ? { observationRef: ref.data } : {}) }, createdAt: new Date().toISOString(), bytes: Buffer.byteLength(JSON.stringify(response)), status: response.isError ? 'error' : 'ok',
      requestRef: path.relative(this.manifest.scope.currentArtifactDirectory, path.join(directory, 'request.json')),
      responseRef: path.relative(this.manifest.scope.currentArtifactDirectory, path.join(directory, 'response.json')) };
    await immutable(path.join(directory, 'receipt.json'), { ...summary, manifestSha256: this.manifestSha256, requestSha256, responseSha256 });
    await immutable(path.join(this.auditDirectory, 'index', `${id}.json`), summary);
    return response;
  }
}

export async function loadEvidenceInvocation(manifestPath: string, sha256: string): Promise<EvidenceAccess> {
  sha256 = sha256.replace(/^sha256:/, '');
  shaSchema.parse(sha256);
  manifestPath = canonical(manifestPath);
  const bytes = await safeBytes(manifestPath, 1_048_576);
  if (hash(bytes) !== sha256) throw new Error('Evidence manifest SHA256 mismatch');
  const manifest = ManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  validateScope(manifest.scope);
  const expected = path.join(manifest.scope.currentArtifactDirectory, 'evidence-access', `turn-${String(manifest.turn).padStart(3, '0')}`, '.data', manifest.invocationId, 'manifest.json');
  scopedPath(manifestPath, expected);
  validateResearchHosts(manifest.allowedHttpHosts);
  if (Object.keys(manifest.runtimeSourceHashes).sort().join() !== [...runtimeFiles].sort().join()) throw new Error('Evidence runtime source hash set mismatch');
  for (const name of runtimeFiles) {
    if (hash(await readFile(path.join(runtimeDirectory, name))) !== manifest.runtimeSourceHashes[name]) throw new Error(`Evidence runtime source hash mismatch: ${name}`);
  }
  if (await referenceHash(manifest.scope) !== manifest.referenceSha256) throw new Error('Evidence reference hash mismatch');
  return new EvidenceAccess(manifest, manifestPath, sha256);
}

/** Index-only dashboard view. Never reads request/response bodies or rewrites legacy records. */
export async function readEvidenceLedger(scope: EvidenceScopeManifest, query: { cursor?: string; limit?: number } = {}): Promise<{ items: Summary[]; nextCursor: string | null }> {
  const { cursor, limit = 20 } = z.object({ cursor: z.string().max(1_024).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().parse(query);
  let after = '';
  if (cursor) {
    try {
      const parsed = z.object({ campaignId: z.literal(scope.campaignId), variantId: z.literal(scope.variantId), after: SummarySchema.shape.id }).strict()
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
      after = parsed.after;
    } catch { throw new Error('Invalid evidence ledger cursor'); }
  }
  const root = path.join(scope.currentArtifactDirectory, 'evidence-access');
  scopedPath(root, root);
  const directories = async (directory: string) => {
    try { return await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  };
  const files: Array<{ id: string; filename: string }> = [];
  for (const turn of await directories(root)) {
    if (!turn.isDirectory() || !/^turn-\d{3,6}$/.test(turn.name)) continue;
    const turnRoot = path.join(root, turn.name, '.data');
    scopedPath(turnRoot, turnRoot);
    for (const invocation of await directories(turnRoot)) {
      if (!invocation.isDirectory() || !z.string().uuid().safeParse(invocation.name).success) continue;
      const index = path.join(turnRoot, invocation.name, 'index');
      scopedPath(index, index);
      for (const entry of await directories(index)) {
        const id = entry.name.replace(/\.json$/, '');
        if (entry.isFile() && entry.name === `${id}.json` && SummarySchema.shape.id.safeParse(id).success && id > after) files.push({ id, filename: path.join(index, entry.name) });
      }
    }
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  const items: Summary[] = [];
  let scanned = after;
  let more = false;
  for (const file of files) {
    if (items.length === limit) { more = true; break; }
    const item = SummarySchema.parse(JSON.parse((await safeBytes(file.filename, 8_192)).toString('utf8')));
    if (item.id !== file.id || item.scope.campaignId !== scope.campaignId || item.scope.variantId !== scope.variantId) throw new Error('Evidence ledger scope mismatch');
    const callRoot = path.join(path.dirname(path.dirname(file.filename)), 'calls', item.id);
    if (item.requestRef !== path.relative(scope.currentArtifactDirectory, path.join(callRoot, 'request.json')) ||
        item.responseRef !== path.relative(scope.currentArtifactDirectory, path.join(callRoot, 'response.json'))) throw new Error('Evidence ledger reference mismatch');
    if (items.length && Buffer.byteLength(JSON.stringify([...items, item])) > 60_000) { more = true; break; }
    items.push(item); scanned = file.id;
  }
  return { items, nextCursor: more ? Buffer.from(JSON.stringify({ campaignId: scope.campaignId, variantId: scope.variantId, after: scanned })).toString('base64url') : null };
}
