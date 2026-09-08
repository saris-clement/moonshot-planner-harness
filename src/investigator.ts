import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { HypothesisSchema, type Hypothesis } from './types.js';

const actionFields = {
  rationale: z.string().trim().min(1).max(8_000),
  hypothesis: HypothesisSchema,
};

export const InvestigatorActionSchema = z.discriminatedUnion('action', [
  z.object({
      action: z.literal('test'),
      ...actionFields,
      // These are requests, not executable paths; the coordinator validates its server test allowlist.
      testFiles: z.array(z.string().min(1).max(2_048)).optional(),
    })
    .strict(),
  z.object({ action: z.literal('evaluate_primary'), ...actionFields }).strict(),
  z.object({ action: z.literal('finalize'), ...actionFields }).strict(),
  z.object({ action: z.literal('abandon'), ...actionFields }).strict(),
]);
export type InvestigatorAction = z.output<typeof InvestigatorActionSchema>;

export interface InvestigationActionRecord {
  id: string;
  kind: string;
  hypothesis?: Hypothesis;
  rationale: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt: string | null;
  patchHash: string | null;
  artifactDirectory: string | null;
  result: unknown;
  error: string | null;
}

export interface InvestigationState {
  schemaVersion: 1;
  sessionId: string | null;
  status: 'running' | 'stopped' | 'finalized' | 'abandoned' | 'budget_exhausted' | 'failed';
  startedAt: string;
  updatedAt: string;
  turnCount: number;
  agentTokens: number | null;
  agentCostUsd: number | null;
  reason: string | null;
  actions: InvestigationActionRecord[];
  harnessPins?: Record<string, unknown>;
}

export interface InvestigatorTurnResult {
  sessionId: string;
  action: InvestigatorAction;
  usage: { tokens: number | null; costUsd: number | null };
}

/** Consume OpenCode JSONL without retaining tool payloads or concatenating progress into the answer. */
export class InvestigatorEventParser {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private sessionId: string | null = null;
  private finalText = '';
  private finishReason: string | null = null;
  private steps = 0;
  private tokens: number | null = 0;
  private costUsd: number | null = 0;

  constructor(
    private readonly expectedSessionId: string | null = null,
    private readonly onSession?: (sessionId: string) => void,
  ) {}

  write(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    let end: number;
    while ((end = this.pending.indexOf('\n', start)) !== -1) {
      this.consume(this.pending.slice(start, end));
      start = end + 1;
    }
    this.pending = this.pending.slice(start);
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      event = value as Record<string, unknown>;
    } catch {
      throw new Error('investigator returned invalid or incomplete JSON event output');
    }
    const part =
      event.part && typeof event.part === 'object' ? event.part as Record<string, unknown> : {};
    for (const id of [event.sessionID, part.sessionID]) {
      if (id === undefined) continue;
      if (typeof id !== 'string' || !id.trim()) throw new Error('invalid investigator session ID');
      if (
        (this.sessionId && this.sessionId !== id) ||
        (this.expectedSessionId && this.expectedSessionId !== id)
      ) {
        throw new Error('investigator emitted conflicting or unexpected session IDs');
      }
      if (!this.sessionId) {
        this.sessionId = id;
        this.onSession?.(id);
      }
    }
    if (event.type === 'error') throw new Error('investigator emitted an OpenCode error event');
    if (event.type === 'step_start' || event.type === 'tool_use') {
      this.finalText = '';
      this.finishReason = null;
    }
    if (event.type === 'text') {
      this.finalText = typeof part.text === 'string' ? part.text : '';
      this.finishReason = null;
    }
    if (event.type === 'step_finish') {
      this.steps += 1;
      this.finishReason = typeof part.reason === 'string' ? part.reason : null;
      const tokens =
        part.tokens && typeof part.tokens === 'object' ? part.tokens as Record<string, unknown> : {};
      const cache =
        tokens.cache && typeof tokens.cache === 'object' ? tokens.cache as Record<string, unknown> : {};
      const components = [
        tokens.input, tokens.output, tokens.reasoning ?? 0, cache.read ?? 0, cache.write ?? 0,
      ];
      const total = tokens.total ?? (
        components.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
          ? components.reduce<number>((sum, value) => sum + Number(value), 0)
          : null
      );
      this.tokens =
        this.tokens !== null && typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 &&
        Number.isSafeInteger(this.tokens + total) ? this.tokens + total : null;
      this.costUsd =
        this.costUsd !== null && typeof part.cost === 'number' && Number.isFinite(part.cost) && part.cost >= 0 &&
        Number.isFinite(this.costUsd + part.cost) ? this.costUsd + part.cost : null;
    }
  }

  finish(): InvestigatorTurnResult {
    this.pending += this.decoder.end();
    this.consume(this.pending);
    this.pending = '';
    if (!this.sessionId) throw new Error('investigator output is missing a session ID');
    if (!this.finalText || (this.finishReason !== null && this.finishReason !== 'stop')) {
      throw new Error('investigator returned incomplete final output');
    }
    const text = this.finalText.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1];
    let action: InvestigatorAction;
    try {
      action = InvestigatorActionSchema.parse(JSON.parse(fenced ?? text) as unknown);
    } catch {
      throw new Error('investigator returned invalid structured final output');
    }
    return {
      sessionId: this.sessionId,
      action,
      usage: { tokens: this.steps ? this.tokens : null, costUsd: this.steps ? this.costUsd : null },
    };
  }
}

export function parseInvestigatorResponse(
  stdout: string,
  expectedSessionId: string | null = null,
): InvestigatorTurnResult {
  const parser = new InvestigatorEventParser(expectedSessionId);
  parser.write(stdout);
  return parser.finish();
}
