import type { JsonValue } from './types.js';

type JsonRecord = Record<string, unknown>;

export interface LangfuseLineage {
  caseId: string;
  runIds: string[];
  requirementUnitIds?: string[];
  requirementOrdinals?: number[];
}

export interface LangfuseLimits {
  maxTraces: number;
  maxObservations: number;
  maxPages: number;
  pageSize: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOutputBytes: number;
}

export interface LangfuseTraceProjection {
  trace: JsonValue;
  observations: JsonValue[];
}

export interface LangfuseCollection {
  status: 'not_configured' | 'complete' | 'partial' | 'failed';
  traces: LangfuseTraceProjection[];
  limitations: string[];
}

const DEFAULT_LIMITS: LangfuseLimits = {
  maxTraces: 30,
  maxObservations: 500,
  maxPages: 20,
  pageSize: 50,
  timeoutMs: 10_000,
  maxResponseBytes: 2 * 1_024 * 1_024,
  maxOutputBytes: 2 * 1_024 * 1_024,
};

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const OPAQUE_SECRET = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}|Basic\s+[A-Za-z0-9+/=]{12,}|Bearer\s+\S+)/gi;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactString(value: string, secrets: readonly string[]): string {
  let safe = value.replace(OPAQUE_SECRET, '[redacted-sensitive-value]');
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted-sensitive-value]');
  }
  return safe.slice(0, 4_000);
}

export function sanitizeLangfuseValue(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): JsonValue {
  if (depth >= 7) return '[truncated-depth]';
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLangfuseValue(item, secrets, depth + 1));
  }
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 100)
      .map(([key, item]) => [
        key.slice(0, 256),
        SENSITIVE_KEY.test(key)
          ? '[redacted-sensitive-value]'
          : sanitizeLangfuseValue(item, secrets, depth + 1),
      ]),
  );
}

function field(record: JsonRecord, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function metadataString(record: JsonRecord, key: string): string | null {
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  return field(metadata, key);
}

function tags(record: JsonRecord): string[] {
  return Array.isArray(record.tags)
    ? record.tags.filter((value): value is string => typeof value === 'string')
    : [];
}

function relevantTrace(trace: JsonRecord, lineage: LangfuseLineage): boolean {
  const caseId =
    field(trace, 'sessionId') ?? metadataString(trace, 'caseId') ?? metadataString(trace, 'sessionId');
  if (caseId !== lineage.caseId && !tags(trace).includes(`case:${lineage.caseId}`)) return false;
  const runId = metadataString(trace, 'runId');
  return !runId || lineage.runIds.length === 0 || lineage.runIds.includes(runId);
}

function relevantObservation(
  observation: JsonRecord,
  traceId: string,
  lineage: LangfuseLineage,
): boolean {
  if (field(observation, 'traceId') !== traceId) return false;
  const caseId = metadataString(observation, 'caseId');
  const runId = metadataString(observation, 'runId');
  if (
    !(
    (!caseId || caseId === lineage.caseId) &&
    (!runId || lineage.runIds.length === 0 || lineage.runIds.includes(runId))
    )
  ) {
    return false;
  }
  const focusedUnits = new Set(lineage.requirementUnitIds ?? []);
  const focusedOrdinals = new Set(lineage.requirementOrdinals ?? []);
  if (focusedUnits.size === 0 && focusedOrdinals.size === 0) return true;
  const unitId = metadataString(observation, 'requirementUnitId');
  if (unitId && focusedUnits.has(unitId)) return true;
  const ordinal = isRecord(observation.metadata) ? observation.metadata.requirementOrdinal : null;
  if (typeof ordinal === 'number' && focusedOrdinals.has(ordinal)) return true;
  const name = field(observation, 'name') ?? '';
  const nameOrdinal = /^adjudicate (\d+)\//.exec(name)?.[1];
  return nameOrdinal !== undefined && focusedOrdinals.has(Number.parseInt(nameOrdinal, 10));
}

function project(record: JsonRecord, keys: readonly string[], secrets: readonly string[]): JsonValue {
  return sanitizeLangfuseValue(
    Object.fromEntries(keys.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]]))),
    secrets,
  );
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maximum) throw new Error('Langfuse response exceeded the configured byte cap');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error('Langfuse response exceeded the configured byte cap');
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as unknown) : null;
}

function pageData(value: unknown): JsonRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Langfuse returned an invalid paginated response');
  }
  return value.data.filter(isRecord);
}

function hasNextPage(value: unknown, page: number, itemCount: number, pageSize: number): boolean {
  if (!isRecord(value)) return false;
  const meta = isRecord(value.meta) ? value.meta : {};
  const totalPages = typeof meta.totalPages === 'number' ? meta.totalPages : null;
  if (totalPages !== null) return page < totalPages;
  return itemCount >= pageSize;
}

export class LangfuseReadClient {
  private readonly limits: LangfuseLimits;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    options: { limits?: Partial<LangfuseLimits>; fetcher?: typeof fetch } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.fetcher = options.fetcher ?? fetch;
  }

  async collect(lineages: readonly LangfuseLineage[]): Promise<LangfuseCollection> {
    const baseUrlValue = this.environment.LANGFUSE_BASE_URL;
    const publicKey = this.environment.LANGFUSE_PUBLIC_KEY;
    const secretKey = this.environment.LANGFUSE_SECRET_KEY;
    if (!baseUrlValue && !publicKey && !secretKey) {
      return {
        status: 'not_configured',
        traces: [],
        limitations: ['Langfuse was not configured in the frozen campaign environment.'],
      };
    }
    if (!baseUrlValue || !publicKey || !secretKey) {
      return {
        status: 'failed',
        traces: [],
        limitations: ['Langfuse configuration in the frozen campaign environment was incomplete.'],
      };
    }

    let baseUrl: URL;
    try {
      baseUrl = new URL(baseUrlValue);
      if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
        throw new Error('invalid URL');
      }
    } catch {
      return {
        status: 'failed',
        traces: [],
        limitations: ['Langfuse base URL was invalid; durable planner facts remain usable.'],
      };
    }

    const secrets = [publicKey, secretKey];
    const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    const limitations: string[] = [];
    const collected: LangfuseTraceProjection[] = [];
    let observationCount = 0;

    const requestPage = async (
      endpoint: 'traces' | 'observations',
      query: Record<string, string>,
    ): Promise<unknown> => {
      const url = new URL(`/api/public/${endpoint}`, baseUrl);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await this.fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: auth },
        signal: AbortSignal.timeout(this.limits.timeoutMs),
      });
      if (!response.ok) throw new Error(`Langfuse ${endpoint} query failed with HTTP ${response.status}`);
      return await readBoundedJson(response, this.limits.maxResponseBytes);
    };

    try {
      const uniqueLineages = new Map<string, LangfuseLineage>();
      for (const lineage of lineages) {
        const current = uniqueLineages.get(lineage.caseId);
        uniqueLineages.set(lineage.caseId, {
          caseId: lineage.caseId,
          runIds: [...new Set([...(current?.runIds ?? []), ...lineage.runIds])].sort(),
          requirementUnitIds: [
            ...new Set([...(current?.requirementUnitIds ?? []), ...(lineage.requirementUnitIds ?? [])]),
          ].sort(),
          requirementOrdinals: [
            ...new Set([...(current?.requirementOrdinals ?? []), ...(lineage.requirementOrdinals ?? [])]),
          ].sort((left, right) => left - right),
        });
      }
      const seenTraceIds = new Set<string>();
      for (const lineage of [...uniqueLineages.values()].sort((left, right) =>
        left.caseId.localeCompare(right.caseId),
      )) {
        for (let page = 1; page <= this.limits.maxPages; page += 1) {
          const response = await requestPage('traces', {
            sessionId: lineage.caseId,
            page: String(page),
            limit: String(this.limits.pageSize),
          });
          const traces = pageData(response).filter((trace) => relevantTrace(trace, lineage));
          for (const trace of traces) {
            const traceId = field(trace, 'id');
            if (!traceId || seenTraceIds.has(traceId)) continue;
            if (collected.length >= this.limits.maxTraces) {
              limitations.push(`Langfuse trace collection stopped at the cap of ${this.limits.maxTraces}.`);
              break;
            }
            seenTraceIds.add(traceId);
            const observations: JsonValue[] = [];
            for (let observationPage = 1; observationPage <= this.limits.maxPages; observationPage += 1) {
              if (observationCount >= this.limits.maxObservations) {
                limitations.push(
                  `Langfuse observation collection stopped at the cap of ${this.limits.maxObservations}.`,
                );
                break;
              }
              const observationResponse = await requestPage('observations', {
                traceId,
                page: String(observationPage),
                limit: String(this.limits.pageSize),
              });
              const candidates = pageData(observationResponse).filter((observation) =>
                relevantObservation(observation, traceId, lineage),
              );
              for (const observation of candidates) {
                if (observationCount >= this.limits.maxObservations) {
                  limitations.push(
                    `Langfuse observation collection stopped at the cap of ${this.limits.maxObservations}.`,
                  );
                  break;
                }
                observations.push(
                  project(
                    observation,
                    [
                      'id',
                      'traceId',
                      'name',
                      'type',
                      'startTime',
                      'endTime',
                      'model',
                      'input',
                      'output',
                      'metadata',
                      'usage',
                    ],
                    secrets,
                  ),
                );
                observationCount += 1;
              }
              if (
                !hasNextPage(
                  observationResponse,
                  observationPage,
                  pageData(observationResponse).length,
                  this.limits.pageSize,
                )
              ) {
                break;
              }
              if (observationPage === this.limits.maxPages) {
                limitations.push('Langfuse observation pagination reached its page cap.');
              }
            }
            const projection = {
              trace: project(
                trace,
                [
                  'id',
                  'name',
                  'sessionId',
                  'tags',
                  'timestamp',
                  'createdAt',
                  'updatedAt',
                  'input',
                  'output',
                  'metadata',
                ],
                secrets,
              ),
              observations,
            };
            let outputTruncated = false;
            while (
              projection.observations.length > 0 &&
              Buffer.byteLength(JSON.stringify([...collected, projection])) > this.limits.maxOutputBytes
            ) {
              projection.observations.pop();
              observationCount -= 1;
              outputTruncated = true;
            }
            if (Buffer.byteLength(JSON.stringify([...collected, projection])) > this.limits.maxOutputBytes) {
              limitations.push(
                `Langfuse output stopped at the byte cap of ${this.limits.maxOutputBytes}.`,
              );
              return { status: 'partial', traces: collected, limitations };
            }
            collected.push(projection);
            if (outputTruncated) {
              limitations.push(
                `Langfuse output stopped at the byte cap of ${this.limits.maxOutputBytes}.`,
              );
              return { status: 'partial', traces: collected, limitations };
            }
          }
          if (collected.length >= this.limits.maxTraces) break;
          if (!hasNextPage(response, page, pageData(response).length, this.limits.pageSize)) break;
          if (page === this.limits.maxPages) limitations.push('Langfuse trace pagination reached its page cap.');
        }
        if (collected.length >= this.limits.maxTraces) break;
      }
      return {
        status: limitations.length > 0 ? 'partial' : 'complete',
        traces: collected,
        limitations,
      };
    } catch (error) {
      const message = error instanceof Error ? redactString(error.message, secrets) : 'unknown failure';
      return {
        status: collected.length > 0 ? 'partial' : 'failed',
        traces: collected,
        limitations: [`Langfuse read failed (${message}); durable planner facts remain usable.`],
      };
    }
  }
}
