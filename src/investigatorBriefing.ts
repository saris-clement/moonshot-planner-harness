import { createHash } from 'node:crypto';
import type { InvestigationState } from './investigator.js';

type Row = Record<string, unknown>;
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

export interface BriefingOmission {
  field: string;
  reason: 'byte_limit' | 'on_demand' | 'older_actions';
  handle: string;
  handleAvailability: 'registered' | 'not_registered';
  originalBytes: number;
}
export interface InvestigatorBriefing {
  schemaVersion: 1;
  mode: 'initial' | 'delta';
  objective: unknown;
  currentHypothesis: unknown;
  baseline: unknown;
  latestAction: unknown;
  failureSummary: unknown;
  recentActions: Row[];
  unitSamples?: unknown;
  referenceHandles: Row;
  budget: Row;
  omissions: BriefingOmission[];
  interpretation: string;
  /** UTF-8 bytes of compact JSON.stringify(briefing), including this field. */
  byteLength: number;
}

function compactScore(value: unknown): Row | null {
  const score = record(value);
  if (!score.verified && !score.provisional) return null;
  const bucket = (value: unknown) => Object.fromEntries(['labeled', 'correct', 'errors', 'accuracy'].map((key) => {
    const item = record(value)[key];
    return [key, typeof item === 'number' && Number.isFinite(item) ? item : null];
  }));
  return { verified: bucket(score.verified), provisional: bucket(score.provisional) };
}
function counts(value: unknown): Row {
  return Object.fromEntries(Object.entries(record(value)).filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));
}

/** Returns a bounded JSON object, never changes persisted state and never summarizes with an LLM.
 * context.referenceHandles may contain registered EvidenceStore IDs for context/state/feedback,
 * objective/currentHypothesis/baseline. Missing handles are explicitly marked not_registered.
 * context.unitSamples may contain coordinator-selected compareTrial rows; at most six are shown initially.
 */
export function buildInvestigatorBriefing(context: unknown, state: InvestigationState, feedback: unknown): InvestigatorBriefing {
  const input = record(context);
  const mode = state.sessionId ? 'delta' : 'initial';
  const limit = mode === 'initial' ? 16_384 : 8_192;
  const referenceHandles = record(input.referenceHandles);
  const omissions: BriefingOmission[] = [];
  const omit = (field: string, value: unknown, source: string, reason: BriefingOmission['reason'] = 'byte_limit') => {
    const serialized = JSON.stringify(value ?? null);
    const registered = referenceHandles[field] ?? referenceHandles[source];
    const handle = typeof registered === 'string' && registered.length <= 256 ? registered :
      `briefing_${createHash('sha256').update(`${source}:${field}:${serialized}`).digest('hex')}`;
    const omission: BriefingOmission = { field, reason, handle, handleAvailability: typeof registered === 'string' && registered.length <= 256 ? 'registered' : 'not_registered', originalBytes: Buffer.byteLength(serialized) };
    omissions.push(omission);
    return { availability: 'omitted', ...omission };
  };
  const bounded = (field: string, value: unknown, source: string, max: number) =>
    bytes(value ?? null) > max ? omit(field, value, source) : value ?? null;
  const latest = state.actions.at(-1);
  const latestResult = record(latest?.result);
  const previousFeedback = record(feedback);
  const failure = previousFeedback.failureSummary ?? previousFeedback.error ?? state.reason ?? latest?.error ?? input.failureSummary ?? previousFeedback.message ?? null;
  const baseline = record(input.baseline);
  const budgetConfig = record(input.budget ?? input.limits);
  const baselineCounts = { decisions: counts(baseline.decisions), evidence: counts(baseline.evidence), shortlist: counts(baseline.shortlist) };
  let recentActions = state.actions.slice(-20).map((action): Row => ({
    id: bounded('actionId', action.id, 'state', 256), kind: bounded('actionKind', action.kind, 'state', 80), status: action.status,
    ...(action.admitted === false ? { admitted: false } : {}),
    patchHash: bounded('patchHash', action.patchHash, 'state', 128),
  }));
  if (bytes(recentActions) > 4_096) {
    // A collapsed header group supersedes its field-level omissions, avoiding duplicate payloads.
    omissions.splice(0, omissions.length);
    recentActions = [omit('recentActions', state.actions.slice(-20).map(({ id, kind, status, patchHash }) => ({ id, kind, status, patchHash })), 'state')];
  }
  if (state.actions.length > 20) omit('olderActions', { count: state.actions.length - 20 }, 'state', 'older_actions');
  const objective = input.objective ?? input.goal ?? null;
  const currentHypothesis = input.currentHypothesis ?? input.hypothesis ?? latest?.hypothesis ?? null;
  const unitSamples = mode === 'initial' && Array.isArray(input.unitSamples) ? input.unitSamples.slice(0, 6)
    .map(record).filter((row) => typeof row.unitRef === 'string' && /^unit_[a-f0-9]{64}$/.test(row.unitRef))
    .map((row) => ({ unitRef: row.unitRef, unitKey: typeof row.unitKey === 'string' ? row.unitKey : null,
      baselineAgreement: typeof row.baselineAgreement === 'number' && Number.isFinite(row.baselineAgreement) ? row.baselineAgreement : null,
      trialAgreement: typeof row.trialAgreement === 'number' && Number.isFinite(row.trialAgreement) ? row.trialAgreement : null,
      changed: typeof row.changed === 'boolean' ? row.changed : null,
      labelStatus: row.labelStatus === 'verified' || row.labelStatus === 'suggested' ? row.labelStatus : null })) : undefined;
  if (unitSamples && (input.unitSamples as unknown[]).length > 6) omit('unitSamples', { omittedRows: (input.unitSamples as unknown[]).length - 6 }, 'context', 'on_demand');
  const briefing: InvestigatorBriefing = {
    schemaVersion: 1, mode,
    objective: bounded('objective', objective, 'context', mode === 'initial' ? 8_192 : 1_024),
    currentHypothesis: bounded('currentHypothesis', currentHypothesis, 'context', mode === 'initial' ? 4_096 : 1_536),
    baseline: { score: compactScore(baseline.score), counts: bounded('baselineCounts', baselineCounts, 'context', 1_024) },
    latestAction: latest ? {
      id: bounded('latestActionId', latest.id, 'state', 256), kind: bounded('latestActionKind', latest.kind, 'state', 80), status: latest.status,
      score: compactScore(latestResult.score), baselineScore: compactScore(latestResult.baselineScore),
      resultSummary: { passed: typeof latestResult.passed === 'boolean' ? latestResult.passed : null,
        executionPassed: typeof latestResult.executionPassed === 'boolean' ? latestResult.executionPassed : null,
        diagnosticReview: bounded('diagnosticReview', latestResult.diagnosticReview, 'feedback', 1_024),
        testsPassed: typeof record(latestResult.tests).passed === 'boolean' ? record(latestResult.tests).passed : null,
        unitCount: typeof record(latestResult.facts).unitCount === 'number' ? record(latestResult.facts).unitCount : null,
        decisions: bounded('latestDecisionCounts', counts(record(latestResult.facts).decisions), 'feedback', 512),
        labelSetHash: bounded('labelSetHash', latestResult.labelSetHash, 'state', 256) },
    } : null,
    failureSummary: bounded('failureSummary', failure, 'feedback', mode === 'initial' ? 2_048 : 1_024),
    recentActions,
    ...(unitSamples ? { unitSamples: bounded('unitSamples', unitSamples, 'context', 2_048) } : {}),
    referenceHandles: Object.fromEntries(Object.entries(referenceHandles).filter(([key, value]) => key.length <= 80 && typeof value === 'string' && value.length <= 256).slice(0, 20)),
    budget: { ...counts(budgetConfig), turnsUsed: state.turnCount, primaryEvaluationsUsed: state.actions.filter((action) => action.kind === 'evaluate_primary' && action.admitted !== false).length,
      agentTokens: state.agentTokens, agentCostUsd: state.agentCostUsd,
      elapsedMsAtLastSave: Number.isFinite(Date.parse(state.updatedAt) - Date.parse(state.startedAt)) ? Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.startedAt)) : null },
    omissions,
    interpretation: 'Measurements are observations. Suggested labels, hypotheses, diagnosis, and reasons are unverified interpretations. Test success is not planner correctness. Query durable evidence on demand; unknown usage is not zero.',
    byteLength: 0,
  };
  // Drop complete fields to handles; never slice a string, identifier, or JSON document.
  for (const field of ['unitSamples', 'objective', 'currentHypothesis', 'failureSummary', 'referenceHandles', 'baseline', 'latestAction', 'budget'] as const) {
    if (bytes(briefing) + 8 <= limit) break;
    const value = briefing[field];
    if (value === undefined) continue;
    (briefing as unknown as Row)[field] = omit(field, value, field === 'latestAction' || field === 'budget' ? 'state' : 'context');
  }
  if (bytes(briefing) + 8 > limit) {
    const actionOmission = omit('recentActions', briefing.recentActions, 'state');
    briefing.recentActions = [actionOmission];
  }
  briefing.byteLength = bytes(briefing);
  briefing.byteLength = bytes(briefing);
  briefing.byteLength = bytes(briefing);
  if (briefing.byteLength > limit) throw new Error('Compact investigator briefing exceeds byte budget');
  return briefing;
}
