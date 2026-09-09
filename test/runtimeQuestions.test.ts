import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citationEvidence,
  matchQuestionConsultations,
  selectedOptionIdForAnswer,
  withRuntimeSourceContext,
  CampaignOrchestrator,
} from '../src/orchestrator.js';
import { AgentRunner } from '../src/agents.js';
import type { CampaignRecord } from '../src/types.js';
import type { PlannerQuestionRecord } from '../src/plannerClient.js';

const question: PlannerQuestionRecord = {
  id: 'question-current',
  createdByRunId: 'run-current',
  responseKind: 'single_select',
  prompt: 'Which behavior is correct?',
  rationale: 'The behavior is ambiguous.',
  context: {},
  options: [
    { id: 'option-current-yes', label: 'Yes', description: 'Enable it.' },
    { id: 'option-current-no', label: 'No', description: 'Disable it.' },
  ],
  status: 'open',
};

test('matchQuestionConsultations excludes cumulative records from earlier runs', () => {
  const previous = {
    intent: {
      request: { ask: 'An earlier question' },
      origin: { runId: 'run-previous' },
    },
    outcome: { resolution: 'answered', answer: 'Wrong answer' },
  };
  const current = {
    intent: {
      request: { ask: question.prompt },
      origin: { runId: question.createdByRunId },
    },
    outcome: { resolution: 'unresolved' },
  };
  const sameRunDifferentQuestion = {
    intent: {
      request: { ask: 'Another question from this run' },
      origin: { runId: question.createdByRunId },
    },
    outcome: { resolution: 'answered', answer: 'Still wrong' },
  };

  assert.deepEqual(
    matchQuestionConsultations([previous, sameRunDifferentQuestion, current], question),
    [current],
  );
  assert.deepEqual(matchQuestionConsultations([], question), []);
});

test('selectedOptionIdForAnswer remaps a cached label to current case option IDs', () => {
  assert.equal(selectedOptionIdForAnswer(question, 'Yes', 'option-previous-yes'), 'option-current-yes');
  assert.equal(selectedOptionIdForAnswer(question, 'No'), 'option-current-no');
  assert.equal(selectedOptionIdForAnswer(question, 'Maybe'), undefined);
});

test('citationEvidence keeps provenance but drops raw source quotes', () => {
  assert.equal(
    citationEvidence({
      entity: 'solution/main',
      anchor: 'checks/source-backed',
      quote: 'customer-specific source excerpt',
    }),
    'solution/main#checks/source-backed',
  );
});

test('source question context uses matching workflow and requirements without altering concurrency pins', async (t) => {
  const input = { ...question, coverageIds: ['unit-current'], requirementRefs: [{ entity: 'solution/main', anchor: 'fields/output_value' }],
    context: { inputSetHash: 'input-pin', decisionSetVersion: 3, anchorHash: 'anchor-pin' } };
  const consultation = (runId: string, workflow: string) => ({ intent: {
    origin: { runId, requirementUnitId: 'unit-current' }, request: { ask: question.prompt, workflow },
  } });
  const contextual = withRuntimeSourceContext(input, [consultation('old-run', 'wrong/workflow'), consultation(question.createdByRunId, 'fixture/workflow')]);
  assert.deepEqual(contextual.sourceContext, { workflow: 'fixture/workflow' });
  assert.deepEqual(contextual.context, input.context);
  assert.equal('sourceContext' in input, false);
  assert.deepEqual(withRuntimeSourceContext(input, []).sourceContext, {});
  assert.deepEqual(withRuntimeSourceContext(input, [consultation(question.createdByRunId, 'one/workflow'), consultation(question.createdByRunId, 'two/workflow')]).sourceContext, {});
  const source = t.mock.method(AgentRunner.prototype, 'answerUpstreamQuestion', async () => ({ resolution: 'unresolved' as const, reason: 'Fixture only.', evidence: [] }));
  const method = (CampaignOrchestrator.prototype as unknown as {
    answerRuntimeQuestionFromImplementation(campaign: CampaignRecord, value: PlannerQuestionRecord, root: string, artifacts: string): Promise<unknown>;
  }).answerRuntimeQuestionFromImplementation;
  await method.call({}, {} as CampaignRecord, contextual, '/frozen', '/artifacts');
  const supplied = source.mock.calls[0]!.arguments[0];
  assert.ok(supplied);
  assert.equal(supplied.rationale, question.rationale);
  assert.deepEqual(supplied.requirementRefs, input.requirementRefs);
  assert.deepEqual(supplied.coverageIds, input.coverageIds);
  assert.equal(supplied.entity, 'solution/main');
  assert.equal(supplied.anchor, 'fields/output_value');
  assert.deepEqual(supplied.context, { workflow: 'fixture/workflow' });
});
