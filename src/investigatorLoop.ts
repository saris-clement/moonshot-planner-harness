import { InvestigatorOutputParseError, type InvestigationActionRecord, type InvestigationState, type InvestigatorAction, type InvestigatorTurnResult } from './investigator.js';

export async function runInvestigatorLoop(
  initial: InvestigationState,
  limits: { maxTurns: number; maxPrimaryEvaluations: number; maxWallTimeMs: number; maxAgentTokens: number },
  dependencies: {
    save: (state: InvestigationState) => void;
    stopped: () => boolean;
    assertActive?: () => void;
    turn: (state: InvestigationState, feedback: unknown, onSession: (id: string) => void) => Promise<InvestigatorTurnResult>;
    execute: (action: InvestigatorAction, record: InvestigationActionRecord, state: InvestigationState) => Promise<{
      patchHash: string | null; artifactDirectory: string | null; result: unknown;
    }>;
  },
): Promise<InvestigationState> {
  let state = structuredClone(initial);
  const save = () => {
    dependencies.assertActive?.();
    state.updatedAt = new Date().toISOString();
    dependencies.save(structuredClone(state));
  };
  if (['finalized', 'abandoned', 'budget_exhausted'].includes(state.status)) return state;
  if (!Number.isFinite(Date.parse(state.startedAt))) {
    state.status = 'failed';
    state.reason = 'Invalid investigation start time; no agent turn or action was dispatched.';
    save();
    return state;
  }
  const budgetReason = (includeTurns: boolean): string | null => {
    if (Date.now() - Date.parse(state.startedAt) >= limits.maxWallTimeMs) return 'Investigation wall-time budget exhausted.';
    if (state.agentTokens !== null && state.agentTokens >= limits.maxAgentTokens) return 'Investigation token budget exhausted.';
    if (includeTurns && state.turnCount >= limits.maxTurns) return 'Investigation turn budget exhausted.';
    return null;
  };
  const exhaust = (reason: string) => {
    state.status = 'budget_exhausted';
    state.reason = `${reason} Archived trials remain available.${state.reason ? ` Last diagnostic: ${state.reason}` : ''}`;
  };
  const interruptedTurn = state.status === 'running' && state.turnCount > 0 &&
    !state.actions.some((action) => action.id === `action-${String(state.turnCount).padStart(3, '0')}`);
  if (interruptedTurn) {
    state.agentTokens = null;
    state.agentCostUsd = null;
    state.reason = 'Previous agent turn was interrupted before an action was recorded. Its usage is unknown and the turn was not replayed.';
  }
  state.status = 'running';
  for (const action of state.actions) {
    if (action.status !== 'running') continue;
    action.status = 'interrupted';
    action.completedAt = new Date().toISOString();
    action.error = 'Coordinator interrupted. This action was not replayed; inspect archived evidence before requesting another.';
  }
  let feedback: unknown = interruptedTurn
    ? { message: state.reason, previousAction: state.actions.at(-1) ?? null }
    : state.actions.at(-1) ?? {
        message: state.reason ?? 'Investigate the baseline and request trusted tests for your first treatment.',
      };
  save();
  while (true) {
    dependencies.assertActive?.();
    if (dependencies.stopped()) {
      state.status = 'stopped'; state.reason = 'Stopped by operator before the next action.'; break;
    }
    const beforeTurnBudget = budgetReason(true);
    if (beforeTurnBudget) { exhaust(beforeTurnBudget); break; }
    const previous = structuredClone(state);
    state.turnCount += 1;
    save(); // Reserve the turn before dispatch so restarts cannot overwrite its transcript.
    let response: InvestigatorTurnResult;
    try {
      response = await dependencies.turn(previous, feedback, (id) => { state.sessionId = id; save(); });
      dependencies.assertActive?.();
      state.sessionId = response.sessionId;
      state.latestHypothesis = response.action.hypothesis;
      state.agentTokens = state.agentTokens !== null && response.usage.tokens !== null ? state.agentTokens + response.usage.tokens : null;
      state.agentCostUsd = state.agentCostUsd !== null && response.usage.costUsd !== null ? state.agentCostUsd + response.usage.costUsd : null;
    } catch (error) {
      // Lease/fence failures are coordinator failures, not model feedback to retry.
      dependencies.assertActive?.();
      if (error instanceof InvestigatorOutputParseError) {
        state.sessionId = error.sessionId;
        state.agentTokens = state.agentTokens !== null && error.usage.tokens !== null ? state.agentTokens + error.usage.tokens : null;
        state.agentCostUsd = state.agentCostUsd !== null && error.usage.costUsd !== null ? state.agentCostUsd + error.usage.costUsd : null;
        state.reason = `Agent output validation failed: ${error.message}`;
      } else {
        state.reason = `Agent turn failed: ${error instanceof Error ? error.message : String(error)}`;
        // Failed streams can have unreported consumption; never report a partial sum as complete.
        state.agentTokens = null; state.agentCostUsd = null;
      }
      feedback = { error: state.reason, instruction: 'Inspect the previous turn. Return one valid coordinator request.' };
      save();
      continue;
    }
    save();
    if (dependencies.stopped()) { state.status = 'stopped'; state.reason = 'Stopped before executing the returned request.'; break; }
    // The last allowed turn may execute, but elapsed time and tokens can expire during that turn.
    const afterTurnBudget = budgetReason(false);
    if (afterTurnBudget) { exhaust(afterTurnBudget); break; }
    const action = response.action;
    if (action.action === 'evaluate_primary' && state.actions.filter((item) => item.kind === 'evaluate_primary' && item.admitted !== false).length >= limits.maxPrimaryEvaluations) {
      state.reason = 'Primary evaluation budget exhausted. Finalize an already evaluated unchanged patch, or abandon.';
      feedback = { error: state.reason };
      save();
      continue;
    }
    const record: InvestigationActionRecord = {
      id: `action-${String(state.turnCount).padStart(3, '0')}`, kind: action.action,
      hypothesis: action.hypothesis, rationale: action.rationale, status: 'running',
      startedAt: new Date().toISOString(), completedAt: null, patchHash: null,
      artifactDirectory: null, result: null, error: null,
    };
    state.actions.push(record);
    save();
    try {
      const result = await dependencies.execute(action, record, structuredClone(state));
      Object.assign(record, result, { status: 'completed', completedAt: new Date().toISOString() });
      state.reason = null;
      if (action.action === 'finalize') state.status = 'finalized';
      if (action.action === 'abandon') { state.status = 'abandoned'; state.reason = action.rationale; }
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = new Date().toISOString();
      state.reason = `Action ${record.id} (${record.kind}) failed: ${record.error}`;
    }
    feedback = structuredClone(record);
    save();
    if (state.status !== 'running') return state;
  }
  save();
  return state;
}
