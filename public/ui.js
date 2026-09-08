import {
  element,
  formatAgreement,
  formatDuration,
  formatMeanScore,
  formatMoney,
  formatNumber,
  formatPercent,
  shortSha,
  statusLabel,
  tableCell,
  text,
  titleCase,
} from './dom.js';
import {
  effectiveElapsed,
  executionHealth,
  experimentDescription,
  langfuseUrlForVariant,
  plannerTotals,
  replicateMatrix,
  targetExcludedReplicateMatrix,
} from './models.js';
import { helpButton } from './help.js';
import { sanitizeDiagnosticValue } from './diagnostics.js';

export function routeLink(label, href, className = '') {
  return element('a', {
    className,
    text: label,
    attributes: { href, 'data-route': '' },
  });
}

export function pageHeading(kicker, title, description, actions = []) {
  return element('header', { className: 'page-heading' }, [
    element('div', {}, [
      element('p', { className: 'overline', text: kicker }),
      element('h1', { text: title }),
      description ? element('p', { className: 'lede', text: description }) : null,
    ]),
    actions.length ? element('div', { className: 'heading-actions' }, actions) : null,
  ]);
}

export function descriptionControl(summary, value, copyLabel, context) {
  const details = element('details', { className: 'description-details' }, [
    element('summary', { text: summary }),
    element('p', { className: 'description-copy', text: value }),
  ]);
  const copy = element('button', {
    className: 'button button-ghost button-compact',
    text: 'Copy',
    attributes: { type: 'button', 'aria-label': `Copy ${copyLabel}` },
    on: { click: () => context.copyText(value, copyLabel) },
  });
  return element('div', { className: 'description-control' }, [details, copy]);
}

export function runButtonLabel(campaign, variants) {
  const stopped = campaign.status.startsWith('stopped');
  const baseline = variants.some((variant) => variant.round === 0 && variant.status === 'completed');
  if (stopped) return 'Resume campaign';
  if (!baseline) return 'Run baseline';
  return campaign.config.mode === 'automatic' ? 'Run automatic search' : 'Run next round';
}

export function campaignActions(campaign, context) {
  const variants = campaign.variants ?? [];
  const runLabel = runButtonLabel(campaign, variants);
  const run = element('button', {
    className: 'button button-primary',
    text: runLabel,
    attributes: {
      type: 'button',
      disabled:
        context.state.pendingAction ||
        campaign.status.startsWith('running') ||
        campaign.status === 'awaiting_review',
    },
    on: { click: () => context.runCampaign() },
  });
  const stop = element('button', {
    className: 'button button-destructive-outline',
    text: 'Stop',
    attributes: {
      type: 'button',
      disabled: context.state.pendingAction || campaign.status.startsWith('stopped'),
    },
    on: { click: () => context.stopCampaign() },
  });
  return campaign.status === 'baseline_target_failed' ? [stop] : [run, stop];
}

export function campaignHeading(campaign, context, actions = []) {
  return element('header', { className: 'page-heading campaign-heading' }, [
    element('div', {}, [
      element('p', { className: 'overline', text: 'Campaign' }),
      element('h1', { text: campaign.id.replaceAll('-', ' ') }),
      descriptionControl('Campaign description', campaign.config.goal, 'campaign description', context),
    ]),
    actions.length ? element('div', { className: 'heading-actions' }, actions) : null,
  ]);
}

export function frozenMetadata(campaign) {
  const values = [
    ['Status', titleCase(campaign.status)],
    ['Mode', titleCase(campaign.config.mode)],
    ['Planner seed', shortSha(campaign.seedSha)],
    ['Workflows', shortSha(campaign.workflowsSha)],
    [campaign.config.investigator?.enabled ? 'Baseline/final replicates' : 'Replicates', `${campaign.config.evaluation.replicates} / benchmark`],
    ['Search', `${campaign.config.limits.concurrency} wide · ${campaign.config.limits.maxVariants} max`],
    ['Harness agent', campaign.config.agent.model],
    ['Created', new Date(campaign.createdAt).toLocaleString()],
  ];
  const list = element('dl', { className: 'metadata-strip', attributes: { 'aria-label': 'Frozen campaign metadata' } });
  for (const [label, value] of values) {
    list.append(element('div', {}, [element('dt', { text: label }), element('dd', { text: value })]));
  }
  return list;
}

function decisionsContent(row) {
  const decisions = row.facts?.decisions ?? row.execution?.decisions;
  if (!decisions || row.state === 'pending') return [text('—')];
  const values = [
    ['build', 'B', decisions.build],
    ['reuse', 'R', decisions.reuse],
    ['extend', 'E', decisions.extend],
    ['defer', 'D', decisions.defer],
    ['question', 'Q', decisions.question],
  ];
  return values.flatMap(([decision, label, count], index) => [
    ...(index === 0 ? [] : [element('span', { className: 'decision-separator', text: ' · ' })]),
    element('span', {
      className: `decision-code decision-code-${decision}`,
      text: `${label} ${count ?? 0}`,
    }),
  ]);
}

function progressContent(row) {
  if (row.state === 'pending') return [text('—')];
  if (!row.stableProgress || !row.execution?.progress) {
    return [element('span', { className: 'muted', text: row.state === 'current' ? 'Waiting for checkpoint' : '—' })];
  }
  const progress = row.execution.progress;
  return [
    element('progress', {
      attributes: {
        max: progress.totalUnits,
        value: progress.completedUnits,
        'aria-label': `${row.benchmark} replicate ${row.replicate} adjudication progress`,
      },
    }),
    element('span', { className: 'progress-value', text: `${progress.completedUnits} / ${progress.totalUnits}` }),
    row.state === 'failed' ? element('small', { className: 'muted', text: 'Last accepted' }) : null,
  ];
}

function rowState(row) {
  if (row.state !== 'current') return row.state;
  return row.execution?.stage ?? row.execution?.status ?? 'current';
}

export function replicateTable(campaign, variant, options = {}) {
  const body = element('tbody');
  const targetConfig = campaign.targetExcludedConfig;
  const usesStandardPrimaryControl = Boolean(
    options.includeTargetExcluded &&
      (targetConfig?.protocol ?? campaign.config.targetExcluded?.protocol) === 'standard-primary-v2',
  );
  const appendRow = (row, group) => {
    const traceCell = element('td');
    if (row.traceUrl) {
      traceCell.append(
        element('a', {
          className: 'link',
          text: 'Trace',
          attributes: { href: row.traceUrl, target: '_blank', rel: 'noreferrer' },
        }),
      );
    } else traceCell.textContent = '—';
    body.append(
      element('tr', {
        attributes: {
          'data-testid': `replicate-${variant.id}-${row.benchmark}-${row.replicate}`,
          'data-replicate-group': group,
          'data-replicate-state': row.state,
        },
      }, [
        element('td', {}, [element('b', { text: row.benchmark }), element('small', { text: row.role })]),
        tableCell(`${row.replicate} / ${row.replicateCount}`, 'mono'),
        element('td', {}, [statusLabel(rowState(row)),
          row.state === 'failed' && row.execution?.failure?.code ? element('small', { className: 'replicate-failure-code', text: sanitizeDiagnosticValue(row.execution.failure.code) }) : null,
        ]),
        element('td', { className: 'progress-cell' }, progressContent(row)),
        element('td', { className: 'mono decision-cell' }, decisionsContent(row)),
        tableCell(
          row.state === 'pending'
            ? '—'
            : formatDuration(effectiveElapsed(
                row.execution?.elapsedMs,
                row.execution?.startedAt,
                row.execution?.completedAt ?? (row.state === 'failed' ? row.execution?.failure?.occurredAt ?? row.execution?.updatedAt : null),
              )),
          'mono',
        ),
        tableCell(row.state === 'pending' ? '—' : formatDuration(row.usage?.durationMs), 'mono'),
        tableCell(row.state === 'pending' ? '—' : formatNumber(row.usage?.calls), 'mono numeric'),
        tableCell(row.state === 'pending' ? '—' : formatNumber(row.usage?.inputTokens), 'mono numeric'),
        tableCell(row.state === 'pending' ? '—' : formatNumber(row.usage?.outputTokens), 'mono numeric'),
        tableCell(row.state === 'pending' ? '—' : formatNumber(row.usage?.totalTokens), 'mono numeric'),
        tableCell(row.state === 'pending' ? '—' : formatMoney(row.usage?.costUsd), 'mono numeric'),
        tableCell(row.state === 'pending' ? '—' : formatNumber(row.questions.length), 'mono numeric'),
        traceCell,
      ]),
    );
  };
  for (const row of replicateMatrix(campaign, variant)) {
    appendRow(
      usesStandardPrimaryControl && row.role === 'primary'
        ? { ...row, role: 'primary · comparison control' }
        : row,
      'standard',
    );
  }
  const targetRows = options.includeTargetExcluded
    ? targetExcludedReplicateMatrix(campaign, variant)
    : [];
  if (targetRows.length) {
    const evaluation = (campaign.targetExcludedEvaluations ?? []).find(
      (candidate) => candidate.variantId === variant.id,
    );
    body.append(
      element('tr', {
        className: 'replicate-group-row',
        attributes: { 'data-testid': `replicate-group-${variant.id}-target-excluded` },
      }, [
        element('th', { attributes: { colspan: '14', scope: 'rowgroup' } }, [
          element('div', { className: 'replicate-group-heading' }, [
            element('span', { className: 'replicate-group-title', text: 'Target-excluded guard' }),
            statusLabel(evaluation?.status ?? 'pending'),
            element('span', {
              className: 'replicate-group-note',
              text: usesStandardPrimaryControl
                ? 'Standard primary runs are the control; target-excluded planner usage is excluded from standard totals.'
                : 'Dedicated control + policy-hidden target · Excluded from totals',
            }),
          ]),
        ]),
      ]),
    );
    for (const row of targetRows) appendRow(row, 'target-excluded');
  }
  return element('div', { className: 'table-scroll replicate-table-wrap', attributes: { 'data-live-key': `${variant.id}:replicates` } }, [
    element('table', { className: 'replicate-table' }, [
      element('caption', { text: `${variant.hypothesis.title} benchmark replicate matrix` }),
      element('thead', {}, [
        element('tr', {}, [
          'Benchmark',
          'Replicate',
          'State',
          'Progress',
          'Latest accepted decisions',
          'Wall elapsed',
          'Model duration',
          'Calls',
          'Input',
          'Output',
          'Total tokens (incl. reasoning)',
          'Cost',
          'Questions',
          'Langfuse',
        ].map((label) => element('th', { text: label, attributes: { scope: 'col' } },
          ['Wall elapsed', 'Model duration'].includes(label) ? [helpButton(label)] : [],
        ))),
      ]),
      body,
    ]),
  ]);
}

export function usageSummary(campaign, variant) {
  const usage = plannerTotals(campaign, variant);
  const observed = usage.observations > 0;
  const values = [
    ['End-to-end', formatDuration(effectiveElapsed(variant.elapsedMs, variant.startedAt, variant.completedAt))],
    ['Phase 2', formatDuration(effectiveElapsed(variant.phase2ElapsedMs, variant.phase2StartedAt, variant.phase2CompletedAt))],
    ['Planner duration', formatDuration(observed ? usage.durationMs : null)],
    ['Planner calls', formatNumber(observed ? usage.calls : null)],
    ['Input tokens', formatNumber(observed ? usage.inputTokens : null)],
    ['Output tokens', formatNumber(observed ? usage.outputTokens : null)],
    ['Total tokens', observed ? `${formatNumber(usage.totalTokens)} incl. reasoning` : '—'],
    ['Planner cost', formatMoney(observed ? usage.costUsd : null)],
  ];
  return element('dl', { className: 'metric-summary', attributes: { 'aria-label': 'Experiment timing and planner usage' } },
    values.map(([label, value]) =>
      element('div', {}, [element('dt', { text: label },
        ['End-to-end', 'Phase 2', 'Planner duration'].includes(label) ? [helpButton(label)] : [],
      ), element('dd', { text: value })]),
    ),
  );
}

export function scoreSummary(variant, campaign) {
  const basis = campaign?.config.investigator?.enabled || variant.score?.metricMode === 'replicate_mean' ? ' (replicate mean)' : '';
  const values = [
    [`Verified${basis}`, basis ? formatMeanScore(variant.score?.verified) : `${formatPercent(variant.score?.verified?.accuracy)} · ${variant.score?.verified?.labeled ?? 0} labeled`],
    [`Provisional${basis}`, basis ? formatMeanScore(variant.score?.provisional) : `${formatPercent(variant.score?.provisional?.accuracy)} · ${variant.score?.provisional?.labeled ?? 0} suggested`],
    [basis ? 'Consensus agreement' : 'Agreement', formatAgreement(variant.facts)],
    ['Cohort drift', variant.score ? (variant.score.cohortMismatches?.length ? variant.score.cohortMismatches.join(', ') : 'None observed') : 'Not evaluated'],
  ];
  return element('dl', { className: 'metric-summary metric-summary-scores', attributes: { 'aria-label': 'Truthful score dimensions' } },
    values.map(([label, value]) =>
      element('div', {}, [element('dt', { text: label }), element('dd', { text: value })]),
    ),
  );
}

export function experimentHeading(campaign, variant, context, actions = []) {
  return element('header', { className: 'page-heading experiment-heading' }, [
    element('div', {}, [
      element('p', { className: 'overline', text: `Experiment ${String(variant.ordinal).padStart(3, '0')} · Round ${variant.round}` }),
      element('h1', { text: variant.hypothesis.title }),
      element('p', { className: 'identifier', text: variant.id }),
      executionHealth(campaign, variant).label ? element('p', { className: 'failure-status', text: executionHealth(campaign, variant).label }) : null,
      descriptionControl(
        'Experiment description',
        experimentDescription(variant),
        'experiment description',
        context,
      ),
    ]),
    actions.length ? element('div', { className: 'heading-actions' }, actions) : null,
  ]);
}

export function externalTraceLink(variant, label = 'Open in Langfuse') {
  const url = langfuseUrlForVariant(variant);
  return url
    ? element('a', {
        className: 'button button-outline',
        text: label,
        attributes: { href: url, target: '_blank', rel: 'noreferrer' },
      })
    : null;
}

export function sectionHeading(kicker, title, description = '', help = null) {
  return element('div', { className: 'section-heading' }, [
    element('div', {}, [element('p', { className: 'overline', text: kicker }), element('h2', { text: title })]),
    help ? element('div', { className: 'section-heading-description' }, [element('p', { text: description }), help])
      : description ? element('p', { text: description }) : null,
  ]);
}

export function questionEntry(question) {
  const answer = question.answer
    ? element('div', { className: 'question-answer' }, [
        element('b', { text: `Answer · ${titleCase(question.resolution ?? 'resolution unknown')}` }),
        element('p', { text: question.answer }),
        question.evidence?.length
          ? element('p', { className: 'question-evidence', text: `Evidence: ${question.evidence.join(' · ')}` })
          : null,
      ])
    : element('div', { className: 'question-answer question-pending' }, [
        element('b', { text: 'Awaiting answer' }),
        element('p', { text: 'The harness has not persisted an answer yet.' }),
      ]);
  return element('article', {
    className: 'question-entry',
    attributes: {
      'data-question-scope': `${question.benchmark}:${question.replicate}:${question.id}`,
      'data-live-key': JSON.stringify([question.benchmark, question.replicate, question.id]),
    },
  }, [
    element('div', { className: 'question-meta' }, [
      element('span', { text: `${question.benchmark} · replicate ${question.replicate}` }),
      element('span', { text: `${question.type} · ${question.ownerRole}` }),
      element('span', { text: `${question.priority} · ${question.status}` }),
      element('span', { text: question.id }),
    ]),
    element('div', { className: 'question-body' }, [
      element('h3', { text: question.prompt }),
      element('p', { className: 'muted', text: question.rationale || 'No rationale recorded.' }),
      answer,
    ]),
  ]);
}
