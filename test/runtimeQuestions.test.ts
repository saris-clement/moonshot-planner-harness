import assert from 'node:assert/strict';
import test from 'node:test';
import {
  citationEvidence,
  matchQuestionConsultations,
  selectedOptionIdForAnswer,
} from '../src/orchestrator.js';
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
