import { element, formatNumber, formatPercent, statusLabel } from '../dom.js';
import { routeLink, sectionHeading } from '../ui.js';

function decisionRows(facts) {
  if (!facts) return element('p', { className: 'muted', text: 'No excluded facts are available.' });
  return element('div', { className: 'counterfactual-decisions' },
    Object.entries(facts.decisions).map(([decision, count]) =>
      element('div', { className: 'decision-cell' }, [
        element('span', {
          className: `decision-code decision-code-${decision}`,
          text: `${decision[0].toUpperCase()}${decision.slice(1)}`,
        }),
        element('strong', {
          className: `decision-code decision-code-${decision}`,
          text: formatNumber(count),
        }),
      ]),
    ),
  );
}

function configurePanel(context, campaign, variant) {
  const form = element('form', { className: 'counterfactual-config' });
  const input = element('input', {
    attributes: {
      name: 'targetImplementationWorkflow',
      required: true,
      pattern: '[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+',
      placeholder: 'client/workflow',
      autocomplete: 'off',
    },
  });
  form.append(
    element('label', {}, [
      element('span', { text: 'Exact target workflow' }),
      input,
    ]),
    element('p', {
      className: 'muted',
      text: `This one-time setting binds ${variant.id} as the two-run protocol baseline. It cannot be edited later.`,
    }),
    element('button', {
      className: 'button button-primary',
      text: 'Freeze target protocol',
      attributes: { type: 'submit', disabled: context.state.pendingAction },
    }),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = new FormData(form).get('targetImplementationWorkflow');
    if (typeof value === 'string') context.configureTargetExcluded(variant.id, value.trim());
  });
  return element('section', { className: 'counterfactual-empty' }, [
    sectionHeading(
      'Counterfactual guard',
      'Exclude one proved target',
      'The planner still sees the same requirements, source revision, model, and knowledge snapshot; only the selected implementation is hidden by policy.',
    ),
    form,
  ]);
}

function questionPanel(context, campaign, variant, evaluation) {
  const usesStandardPrimary = campaign.targetExcludedConfig?.protocol === 'standard-primary-v2';
  const primary = campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary');
  const standardExecutions = usesStandardPrimary
    ? (variant.executionState?.executions ?? []).filter(
        (execution) => execution.role === 'primary' && execution.benchmark === primary?.name,
      )
    : [];
  const executions = [
    ...standardExecutions,
    ...(evaluation.executionState?.executions ?? []),
  ];
  const byScope = new Map();
  for (const execution of executions) {
    for (const question of execution.questions ?? []) {
      if (question.status !== 'open') continue;
      const key = `${execution.benchmark}\u0000${execution.replicate}\u0000${question.id}`;
      if (!byScope.has(key)) {
        byScope.set(key, {
          ...question,
          benchmark: execution.benchmark,
          replicate: execution.replicate,
        });
      }
    }
  }
  const questions = [...byScope.values()];
  if (!questions.length) return null;
  return element('section', { className: 'counterfactual-questions' }, [
    sectionHeading('Input required', 'Resolve blocked analysis'),
    ...questions.map((question) => {
      const scopeId = `${encodeURIComponent(question.benchmark)}-${question.replicate}-${encodeURIComponent(question.id)}`;
      const answerId = `target-answer-${scopeId}`;
      const optionId = `target-option-${scopeId}`;
      const form = element('form', {
        className: 'counterfactual-question',
        attributes: {
          'data-question-benchmark': question.benchmark,
          'data-question-replicate': question.replicate,
          'data-question-id': question.id,
        },
      });
      const answer = element('textarea', {
        attributes: {
          id: answerId,
          name: 'answer',
          required: true,
          placeholder: 'Record the source-independent answer',
        },
      });
      let optionSelect = null;
      if (question.responseKind === 'single_select' && question.options?.length) {
        optionSelect = element('select', { attributes: { id: optionId, name: 'selectedOptionId', required: true } },
          question.options.map((option) =>
            element('option', { text: option.label, attributes: { value: option.id } }),
          ),
        );
      }
      form.append(
        element('p', {
          className: 'question-meta',
          text: `${question.benchmark} · replicate ${question.replicate} · ${question.id}`,
        }),
        element('p', { text: question.prompt }),
        optionSelect
          ? element('label', { attributes: { for: optionId } }, [
              element('span', { text: 'Select an answer' }),
              optionSelect,
            ])
          : null,
        element('label', { attributes: { for: answerId } }, [
          element('span', { text: 'Answer and rationale' }),
          answer,
        ]),
        element('button', {
          className: 'button button-primary',
          text: 'Resume analysis',
          attributes: { type: 'submit', disabled: context.state.pendingAction },
        }),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const values = new FormData(form);
        context.answerTargetExcludedQuestion(
          variant.id,
          question.id,
          String(values.get('answer') ?? ''),
          optionSelect ? String(values.get('selectedOptionId') ?? '') : undefined,
          question.benchmark,
          question.replicate,
        );
      });
      return form;
    }),
  ]);
}

function runTable(evaluation) {
  const executions = evaluation.executionState?.executions ?? [];
  if (!executions.length) return element('p', { className: 'muted', text: 'No run telemetry yet.' });
  return element('div', { className: 'table-scroll' }, [
    element('table', { className: 'target-run-table' }, [
      element('caption', { text: 'Target-excluded guard execution runs' }),
      element('thead', {}, [element('tr', {}, ['Arm', 'Run', 'Status', 'Progress', 'Build'].map((text) =>
        element('th', { text, attributes: { scope: 'col' } }),
      ))]),
      element('tbody', {}, executions.map((execution) => element('tr', {}, [
        element('th', {
          className: 'target-run-row-heading',
          text: execution.benchmark,
          attributes: { scope: 'row' },
        }),
        element('td', { text: `${execution.replicate}/${execution.replicateCount}` }),
        element('td', {}, [statusLabel(execution.status)]),
        element('td', { text: execution.progress ? `${execution.progress.completedUnits}/${execution.progress.totalUnits}` : '—' }),
        element('td', { text: formatNumber(execution.decisions?.build) }),
      ]))),
    ]),
  ]);
}

export function targetExcludedPanel(context, campaign, variant) {
  const config = campaign.targetExcludedConfig;
  if (!config && campaign.config.targetExcluded) {
    return element('section', { className: 'counterfactual-empty' }, [
      sectionHeading(
        'Counterfactual guard',
        'V2 guard frozen for the baseline',
        `2 excluded replicates · concurrency 2 against ${campaign.config.targetExcluded.targetImplementationWorkflow}. Standard primary is the comparison control. Runtime evidence will appear when baseline execution starts.`,
      ),
    ]);
  }
  if (!config) return configurePanel(context, campaign, variant);
  const usesStandardPrimary = config.protocol === 'standard-primary-v2';
  const evaluation = (campaign.targetExcludedEvaluations ?? []).find(
    (candidate) => candidate.variantId === variant.id,
  );
  if (!evaluation) {
    return element('section', { className: 'counterfactual-empty' }, [
      sectionHeading(
        'Counterfactual guard',
        variant.id === config.baselineVariantId ? 'Calibrate the excluded baseline' : 'Run the excluded validation',
        usesStandardPrimary
          ? `2 excluded replicates · concurrency 2 against ${config.targetImplementationWorkflow}. Standard primary is the comparison control.`
          : `2 paired replicates per arm · concurrency 2 against ${config.targetImplementationWorkflow}.`,
      ),
      element('button', {
        className: 'button button-primary',
        text: variant.id === config.baselineVariantId ? 'Run full calibration' : 'Run target-excluded guard',
        attributes: { type: 'button', disabled: context.state.pendingAction },
        on: { click: () => context.runTargetExcluded(variant.id) },
      }),
    ]);
  }
  const gate = evaluation.gate;
  const comparisons = evaluation.comparisons ?? [];
  const pendingQuestions = questionPanel(context, campaign, variant, evaluation);
  const retry = evaluation.status === 'failed'
      ? element('button', {
        className: 'button button-secondary counterfactual-retry',
        text: 'Retry complete evaluation',
        attributes: { type: 'button', disabled: context.state.pendingAction },
        on: { click: () => context.runTargetExcluded(variant.id) },
      })
    : null;
  return element('div', { className: 'counterfactual-layout', attributes: { 'aria-live': 'polite' } }, [
    element('section', { className: 'counterfactual-strip' }, [
      element('div', {}, [element('span', { text: 'Target' }), element('strong', { text: config.targetImplementationWorkflow })]),
      element('div', {}, [
        element('span', { text: 'Protocol' }),
        element('strong', {
          text: usesStandardPrimary
            ? '2 excluded replicates · concurrency 2'
            : '2 paired replicates per arm · concurrency 2',
        }),
      ]),
      element('div', {}, [element('span', { text: 'Lifecycle' }), statusLabel(evaluation.status)]),
      element('div', {}, [element('span', { text: 'Promotion gate' }), statusLabel(gate?.status ?? 'pending')]),
    ]),
    element('p', {
      className: 'counterfactual-protocol-note muted',
      text: usesStandardPrimary
        ? 'Standard primary is the comparison control; target-excluded planner usage is separate from standard totals.'
        : 'Dedicated control is compared with the target-excluded arm; this historical V1 protocol records both arms.',
    }),
    retry,
    evaluation.error
      ? element('section', { className: 'error-panel' }, [
          element('h2', { text: 'Recorded target-arm failure' }),
          element('p', { text: evaluation.error }),
        ])
      : null,
    pendingQuestions,
    element('section', {}, [
      sectionHeading(
        'Execution',
        usesStandardPrimary ? 'Excluded guard runs' : 'Control, holdout, and excluded runs',
        usesStandardPrimary ? 'Standard primary run telemetry is the comparison control on the Runs tab.' : '',
      ),
      runTable(evaluation),
    ]),
    element('section', { className: 'counterfactual-results' }, [
      sectionHeading('Excluded facts', 'Disposition profile'),
      decisionRows(evaluation.excludedFacts),
      element('dl', { className: 'definition-list' }, [
        element('div', {}, [element('dt', { text: 'Baseline build rate' }), element('dd', { text: formatPercent(gate?.baselineMeanBuildRate) })]),
        element('div', {}, [element('dt', { text: 'Candidate build rate' }), element('dd', { text: formatPercent(gate?.candidateMeanBuildRate) })]),
        element('div', {}, [element('dt', { text: 'Relative drop' }), element('dd', { text: formatPercent(gate?.buildDropRatio) })]),
        element('div', {}, [element('dt', { text: 'Pair validity' }), element('dd', { text: comparisons.length === config.replicates && comparisons.every((item) => item.valid) ? 'Valid' : 'Pending or invalid' })]),
        element('div', {}, [element('dt', { text: 'Leakage paths' }), element('dd', { text: formatNumber(comparisons.reduce((sum, item) => sum + item.leakagePaths.length, 0)) })]),
      ]),
      gate?.reasons?.length ? element('ul', { className: 'counterfactual-reasons' }, gate.reasons.map((reason) => element('li', { text: reason }))) : null,
      comparisons.some((comparison) => comparison.mismatches.length)
        ? element('ul', { className: 'counterfactual-reasons' },
            comparisons.flatMap((comparison) =>
              comparison.mismatches.map((mismatch) =>
                element('li', { text: `Run ${comparison.replicate}: ${mismatch}` }),
              ),
            ),
          )
        : null,
    ]),
    evaluation.questionResolution?.entries?.some((entry) => entry.arm)
      ? element('section', {}, [
          sectionHeading('Resolved inputs', 'Target-arm question history'),
          element('div', { className: 'question-list' },
            evaluation.questionResolution.entries
              .filter((entry) => entry.arm)
              .map((entry) => element('article', { className: 'question-entry' }, [
                element('p', { className: 'overline', text: `${entry.arm} · ${entry.resolution}` }),
                element('h3', { text: entry.question }),
                element('p', { text: entry.answer }),
              ])),
          ),
        ])
      : null,
    element('section', {}, [
      sectionHeading('Target-blind review', 'Separate evaluation truth', 'These suggestions never enter normal or holdout scoring.'),
      element('p', { text: evaluation.judgment?.summary ?? 'The target-blind judge has not completed.' }),
      evaluation.excludedFacts
        ? routeLink(
            'Review excluded requirements',
            `/campaigns/${encodeURIComponent(campaign.id)}/review/${encodeURIComponent(variant.id)}?scope=target-excluded&filter=all`,
            'button button-secondary',
          )
        : null,
    ]),
  ]);
}
