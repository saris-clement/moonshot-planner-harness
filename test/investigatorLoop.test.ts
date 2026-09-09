import assert from 'node:assert/strict';
import test from 'node:test';
import { runInvestigatorLoop } from '../src/investigatorLoop.js';
import { parseInvestigatorResponse, type InvestigationState, type InvestigatorAction } from '../src/investigator.js';
import { DiagnosticReviewSchema } from '../src/investigatorDiagnostics.js';

const hypothesis = { title: 'Evidence retention', rationale: 'Observed loss', instructions: 'Replace weaker evidence', expectedImpact: 'Improve source selection', risk: 'Loss of context', findingIds: [], assumptions: ['Later evidence is stronger'] };
const initial = (): InvestigationState => ({ schemaVersion: 1, sessionId: null, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turnCount: 0, agentTokens: 0, agentCostUsd: 0, reason: null, actions: [] });
const limits = { maxTurns: 8, maxPrimaryEvaluations: 2, maxWallTimeMs: 60_000, maxAgentTokens: 10_000 };
const event = (type: string, part: unknown) => JSON.stringify({ type, sessionID: 'ses-one', part });
const output = (request: unknown, tokens: number, cost = 0.25) => [
  event('text', { text: JSON.stringify(request) }), event('step_finish', { reason: 'stop', tokens: { total: tokens }, cost }),
].join('\n');

test('persistent loop returns failed tests to the same session before evaluation and finalization', async () => {
  const actions = ['test', 'test', 'evaluate_primary', 'finalize'] as const;
  const saved: InvestigationState[] = [];
  let turn = 0;
  const result = await runInvestigatorLoop(initial(), limits, {
    save: (state) => { saved.push(structuredClone(state)); },
    stopped: () => false,
    turn: async (state, feedback) => {
      if (turn > 0) assert.equal(state.sessionId, 'ses-one');
      if (turn === 1) assert.match(JSON.stringify(feedback), /fixture failed/);
      return { sessionId: 'ses-one', usage: { tokens: 10, costUsd: 0.1 }, action: { action: actions[turn++]!, rationale: 'Next experiment step', hypothesis } };
    },
    execute: async (_action, record) => {
      if (record.id === 'action-001') throw new Error('fixture failed');
      return { patchHash: 'sha256:patch', artifactDirectory: record.id, result: { passed: true } };
    },
  });
  assert.equal(result.status, 'finalized');
  assert.equal(result.turnCount, 4);
  assert.equal(result.agentTokens, 40);
  assert.deepEqual(result.actions.map((action) => action.status), ['failed', 'completed', 'completed', 'completed']);
  assert.ok(saved.some((state) => state.actions.at(-1)?.status === 'running'));
});

test('evaluation budget prevents dispatch while allowing finalization or abandonment', async () => {
  let calls = 0;
  const result = await runInvestigatorLoop(initial(), { ...limits, maxPrimaryEvaluations: 1 }, {
    save: () => {}, stopped: () => false,
    turn: async () => ({ sessionId: 'ses-one', usage: { tokens: null, costUsd: null }, action: { action: calls < 2 ? 'evaluate_primary' : 'abandon', rationale: 'No useful gain', hypothesis } }),
    execute: async () => { calls += 1; return { patchHash: null, artifactDirectory: null, result: {} }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.agentTokens, null);
});

test('a failed primary attempt consumes its quota and the refusal is fed back before abandonment', async () => {
  let turns = 0;
  const dispatched: string[] = [];
  const result = await runInvestigatorLoop(initial(), { ...limits, maxPrimaryEvaluations: 1 }, {
    save: () => {}, stopped: () => false,
    turn: async (state, feedback) => {
      turns += 1;
      if (turns > 1) assert.equal(state.sessionId, 'ses-one');
      if (turns === 3) assert.match(JSON.stringify(feedback), /Primary evaluation budget exhausted/);
      return { sessionId: 'ses-one', usage: { tokens: 1, costUsd: 0 },
        action: { action: turns < 3 ? 'evaluate_primary' : 'abandon', rationale: 'No further useful experiment', hypothesis } };
    },
    execute: async (action) => {
      dispatched.push(action.action);
      if (action.action === 'evaluate_primary') throw new Error('primary execution failed');
      return { patchHash: null, artifactDirectory: null, result: {} };
    },
  });
  assert.deepEqual(dispatched, ['evaluate_primary', 'abandon']);
  assert.equal(result.status, 'abandoned');
  assert.equal(result.actions[0]?.status, 'failed');
  assert.equal(result.turnCount, 3);
});

test('interrupted action is recorded, not silently executed again', async () => {
  const state = initial();
  state.sessionId = 'ses-one';
  state.turnCount = 1;
  state.actions.push({ id: 'action-001', kind: 'test', rationale: 'Previous request', status: 'running', startedAt: state.startedAt, completedAt: null, patchHash: null, artifactDirectory: null, result: null, error: null });
  const result = await runInvestigatorLoop(state, limits, {
    save: () => {}, stopped: () => false,
    turn: async (_state, feedback) => {
      assert.match(JSON.stringify(feedback), /interrupted/);
      return { sessionId: 'ses-one', usage: { tokens: 1, costUsd: 0 }, action: { action: 'abandon', rationale: 'Stop this hypothesis', hypothesis } };
    },
    execute: async (action: InvestigatorAction) => { assert.equal(action.action, 'abandon'); return { patchHash: null, artifactDirectory: null, result: {} }; },
  });
  assert.equal(result.actions[0]!.status, 'interrupted');
  assert.equal(result.status, 'abandoned');
  assert.equal(result.actions[1]!.id, 'action-002');
});

test('diagnostic admission rejection is archived without spending a primary execution slot', async () => {
  let turn = 0;
  const result = await runInvestigatorLoop(initial(), { ...limits, maxPrimaryEvaluations: 1 }, {
    save: () => {}, stopped: () => false,
    turn: async (_state, feedback) => {
      if (turn === 1) assert.match(JSON.stringify(feedback), /diagnostic review/);
      return { sessionId: 'ses-one', usage: { tokens: 1, costUsd: 0 }, action: {
        action: ++turn <= 2 ? 'evaluate_primary' : 'abandon', rationale: 'Inspect before executing', hypothesis,
      } };
    },
    execute: async (_action, record) => {
      if (turn === 1) { record.admitted = false; throw new Error('A diagnostic review is required'); }
      return { patchHash: null, artifactDirectory: record.id, result: {} };
    },
  });
  assert.equal(result.status, 'abandoned');
  assert.equal(result.turnCount, 3);
  assert.deepEqual(result.actions.map(({ status }) => status), ['failed', 'completed', 'completed']);
  assert.equal(result.actions[0]!.admitted, false);
});

test('missing and malformed raw reviews reach admission rejection without losing measured usage', async (t) => {
  for (const kind of ['probe', 'evaluate_primary'] as const) {
    for (const review of [undefined, { examples: [] }]) {
      await t.test(`${kind}: ${review === undefined ? 'missing' : 'malformed'} review`, async () => {
        let turns = 0;
        let executions = 0;
        const result = await runInvestigatorLoop(initial(), limits, {
          save: () => {}, stopped: () => false,
          turn: async (state, feedback) => {
            turns += 1;
            if (turns > 1) {
              assert.equal(state.agentTokens, 10);
              assert.match(JSON.stringify(feedback), /Diagnostic review required/);
            }
            return parseInvestigatorResponse(output(turns === 1
              ? { action: kind, rationale: 'Inspect before execution', hypothesis, review,
                  ...(kind === 'probe' ? { testFiles: ['server/test/evidence.test.ts'] } : {}) }
              : { action: 'abandon', rationale: 'Stop after admission feedback', hypothesis }, 10));
          },
          execute: async (action, record) => {
            if (action.action === 'probe' || action.action === 'evaluate_primary') {
              try { DiagnosticReviewSchema.parse(action.review); }
              catch { record.admitted = false; throw new Error('Diagnostic review required before execution'); }
              executions += 1;
            }
            return { patchHash: null, artifactDirectory: record.id, result: {} };
          },
        });
        assert.equal(result.status, 'abandoned');
        assert.equal(result.turnCount, 2);
        assert.equal(result.agentTokens, 20);
        assert.equal(result.agentCostUsd, 0.5);
        assert.equal(result.actions[0]!.kind, kind);
        assert.equal(result.actions[0]!.status, 'failed');
        assert.equal(result.actions[0]!.admitted, false);
        assert.equal(executions, 0);
      });
    }
  }
});

test('invalid final actions cannot erase reported usage or dispatch another turn past the token budget', async (t) => {
  const request = { action: 'test', rationale: 'Check the boundary', hypothesis };
  for (const [name, invalid] of [
    ['discriminator', { ...request, action: 'shell' }],
    ['missing probe testFiles', { ...request, action: 'probe' }],
    ['malformed testFiles', { ...request, testFiles: [42] }],
    ['hypothesis', { ...request, hypothesis: {} }],
    ['unknown outer field', { ...request, command: 'curl remote' }],
    ['non-object JSON', 'not a request'],
  ] as const) {
    await t.test(name, async () => {
      let turns = 0;
      let executed = 0;
      const result = await runInvestigatorLoop(initial(), { ...limits, maxAgentTokens: 100 }, {
        save: () => {}, stopped: () => false,
        turn: async () => {
          turns += 1;
          assert.ok(turns <= 2, 'no extra model turn after the invalid 110-token response');
          return parseInvestigatorResponse(output(turns === 1 ? request : invalid, turns === 1 ? 90 : 110));
        },
        execute: async () => { executed += 1; return { patchHash: null, artifactDirectory: null, result: {} }; },
      });
      assert.equal(result.status, 'budget_exhausted');
      assert.equal(result.agentTokens, 200);
      assert.equal(result.agentCostUsd, 0.5);
      assert.equal(result.turnCount, 2);
      assert.equal(turns, 2);
      assert.equal(result.sessionId, 'ses-one');
      assert.match(result.reason!, /token budget exhausted/i);
      assert.match(result.reason!, /invalid structured final output/i);
      assert.equal(executed, 1);
      assert.equal(result.actions.length, 1);
    });
  }
});

test('output validation feedback preserves session and accumulated known usage below the budget', async () => {
  let turns = 0;
  const result = await runInvestigatorLoop({ ...initial(), agentTokens: 90, agentCostUsd: 0.5, latestHypothesis: hypothesis }, limits, {
    save: () => {}, stopped: () => false,
    turn: async (state, feedback) => {
      turns += 1;
      if (turns === 1) return parseInvestigatorResponse(output({ action: 'invalid' }, 10));
      assert.equal(state.sessionId, 'ses-one', 'retain parser metadata even without an onSession callback');
      assert.equal(state.agentTokens, 100);
      assert.equal(state.agentCostUsd, 0.75);
      assert.deepEqual(state.latestHypothesis, hypothesis);
      assert.match(JSON.stringify(feedback), /validation.*invalid structured final output/i);
      return parseInvestigatorResponse(output({ action: 'abandon', rationale: 'Stop after validation feedback', hypothesis }, 10));
    },
    execute: async () => ({ patchHash: null, artifactDirectory: null, result: {} }),
  });
  assert.equal(result.status, 'abandoned');
  assert.equal(result.turnCount, 2);
  assert.equal(result.agentTokens, 110);
  assert.equal(result.agentCostUsd, 1);
  assert.deepEqual(result.actions.map(({ id }) => id), ['action-002']);
});

test('interrupted and model or tool stream failures still make previously known usage unknown', async (t) => {
  const partial = output({ action: 'test', rationale: 'Progress only', hypothesis }, 90);
  for (const [name, suffix] of [
    ['provider error', event('error', { message: 'provider failure' })],
    ['unfinished tool', event('tool_use', { status: 'running' })],
    ['unfinished step', event('step_start', {})],
    ['unreported invalid final text', event('text', { text: 'not JSON' })],
    ['truncated event', '{"type":"text",'],
    ['transport error', null],
  ] as const) {
    await t.test(name, async () => {
      let turns = 0;
      const result = await runInvestigatorLoop({ ...initial(), agentTokens: 90, agentCostUsd: 0.5 }, limits, {
        save: () => {}, stopped: () => false,
        turn: async (state, feedback, onSession) => {
          if (++turns === 1) {
            onSession('ses-one');
            if (suffix === null) throw new Error('model transport interrupted');
            return parseInvestigatorResponse(`${partial}\n${suffix}`);
          }
          assert.equal(state.agentTokens, null);
          assert.equal(state.agentCostUsd, null);
          assert.equal(state.sessionId, 'ses-one');
          assert.match(JSON.stringify(feedback), /failed/i);
          return parseInvestigatorResponse(output({ action: 'abandon', rationale: 'Stop after interrupted consumption', hypothesis }, 10));
        },
        execute: async () => ({ patchHash: null, artifactDirectory: null, result: {} }),
      });
      assert.equal(result.status, 'abandoned');
      assert.equal(result.agentTokens, null);
      assert.equal(result.agentCostUsd, null);
    });
  }
});

test('lease failures during invalid-output handling escape without another turn or feedback save', async () => {
  const leaseError = new Error('investigator coordinator lease lost');
  let active = true;
  let turns = 0;
  const saved: InvestigationState[] = [];
  await assert.rejects(runInvestigatorLoop(initial(), limits, {
    save: (state) => { saved.push(state); }, stopped: () => false,
    assertActive: () => { if (!active) throw leaseError; },
    turn: async () => {
      turns += 1;
      active = false;
      return parseInvestigatorResponse(output({ action: 'invalid' }, 110));
    },
    execute: async () => { throw new Error('must not execute'); },
  }), (error) => error === leaseError);
  assert.equal(turns, 1);
  assert.ok(saved.every((state) => state.reason === null));
});

test('a reserved interrupted turn retains its session, reports unknown usage, and never reuses its action ID', async () => {
  const state = initial();
  state.sessionId = 'ses-one';
  state.turnCount = 2;
  state.agentTokens = 20;
  state.actions.push({ id: 'action-001', kind: 'test', hypothesis, rationale: 'Previous completed test',
    status: 'completed', startedAt: state.startedAt, completedAt: state.updatedAt,
    patchHash: 'sha256:patch', artifactDirectory: 'action-001', result: { passed: true }, error: null });
  const result = await runInvestigatorLoop(state, limits, {
    save: () => {}, stopped: () => false,
    turn: async (current, feedback) => {
      assert.equal(current.sessionId, 'ses-one');
      assert.equal(current.turnCount, 2);
      assert.equal(current.agentTokens, null);
      assert.match(JSON.stringify(feedback), /interrupted.*turn|turn.*interrupted/i);
      return { sessionId: 'ses-one', usage: { tokens: 1, costUsd: 0 },
        action: { action: 'abandon', rationale: 'Stop after reviewing the interruption', hypothesis } };
    },
    execute: async (_action, record) => {
      assert.equal(record.id, 'action-003');
      return { patchHash: null, artifactDirectory: null, result: {} };
    },
  });
  assert.equal(result.status, 'abandoned');
  assert.equal(result.agentTokens, null);
  assert.deepEqual(result.actions[0], state.actions[0]);
});

test('cooperative stop consumes no new turn', async () => {
  const result = await runInvestigatorLoop(initial(), limits, {
    save: () => {}, stopped: () => true,
    turn: async () => { throw new Error('must not call agent'); },
    execute: async () => { throw new Error('must not dispatch'); },
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.turnCount, 0);
});

test('time and token budgets are checked after the agent returns before an expensive action', async (t) => {
  for (const budget of ['time', 'tokens'] as const) {
    const state = initial();
    const clock = Date.now();
    const now = t.mock.method(Date, 'now', () => clock);
    let executed = false;
    const result = await runInvestigatorLoop(state, limits, {
      save: () => {}, stopped: () => false,
      turn: async () => {
        if (budget === 'time') now.mock.mockImplementation(() => clock + limits.maxWallTimeMs);
        return { sessionId: 'ses-one', usage: { tokens: limits.maxAgentTokens, costUsd: 0 },
          action: { action: 'evaluate_primary', rationale: 'Request expensive evaluation', hypothesis } };
      },
      execute: async () => { executed = true; return { patchHash: null, artifactDirectory: null, result: {} }; },
    });
    assert.equal(executed, false, budget);
    assert.equal(result.status, 'budget_exhausted');
    assert.match(result.reason!, new RegExp(budget === 'time' ? 'wall.time' : 'token', 'i'));
    assert.equal(result.turnCount, 1);
    assert.equal(result.sessionId, 'ses-one');
    assert.deepEqual(result.actions, []);
    now.mock.restore();
  }
});

test('the last allowed turn can execute; unknown usage stays unknown and is bounded by turns', async () => {
  const result = await runInvestigatorLoop(initial(), { ...limits, maxTurns: 1 }, {
    save: () => {}, stopped: () => false,
    turn: async () => ({ sessionId: 'ses-one', usage: { tokens: null, costUsd: null },
      action: { action: 'test', rationale: 'Last allowed turn', hypothesis } }),
    execute: async () => { throw new Error('trusted regression failed'); },
  });
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.agentTokens, null);
  assert.equal(result.actions[0]?.status, 'failed');
  assert.match(result.reason!, /turn budget/i);
  assert.match(result.reason!, /trusted regression failed/);
});

test('cooperative stop after a turn saves usage and session without executing its request', async () => {
  let stopped = false;
  const result = await runInvestigatorLoop(initial(), limits, {
    save: () => {}, stopped: () => stopped,
    turn: async () => {
      stopped = true;
      return { sessionId: 'ses-one', usage: { tokens: 5, costUsd: 0.1 },
        action: { action: 'evaluate_primary', rationale: 'Must not run after stop', hypothesis } };
    },
    execute: async () => { throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.agentTokens, 5);
  assert.equal(result.sessionId, 'ses-one');
  assert.deepEqual(result.actions, []);
});

test('invalid clocks fail closed without reserving an agent turn', async () => {
  const result = await runInvestigatorLoop({ ...initial(), startedAt: 'invalid' }, limits, {
    save: () => {}, stopped: () => false,
    turn: async () => { throw new Error('must not call agent'); },
    execute: async () => { throw new Error('must not execute'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.turnCount, 0);
  assert.match(result.reason!, /invalid.*start/i);
});
