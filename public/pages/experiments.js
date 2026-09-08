import {
  element,
  formatAgreement,
  formatDuration,
  formatMeanScore,
  formatMoney,
  formatNumber,
  formatPercent,
  option,
  statusLabel,
  tableCell,
} from '../dom.js';
import {
  effectiveElapsed,
  filterAndSortVariants,
  holdoutState,
  plannerTotals,
  resultState,
  scopedQuestions,
} from '../models.js';
import { campaignHeading, routeLink, sectionHeading } from '../ui.js';
import { investigationSummary } from '../investigation.js';

function readFilters(query) {
  return {
    search: query.get('q') ?? '',
    status: query.get('status') ?? 'all',
    round: query.get('round') ?? 'all',
    lineage: query.get('lineage') ?? 'all',
    result: query.get('result') ?? 'all',
    sort: query.get('sort') ?? 'ordinal',
  };
}

const defaults = { q: '', status: 'all', round: 'all', lineage: 'all', result: 'all', sort: 'ordinal' };

function updateFilter(context, name, value) {
  const next = new URL(location.href);
  if (value === defaults[name]) next.searchParams.delete(name);
  else next.searchParams.set(name, value);
  context.navigate(`${next.pathname}${next.search}`, { replace: true });
}

function selectControl(context, label, name, value, values, prefix = '') {
  const id = `${prefix}filter-${name}`;
  const select = element('select', {
    attributes: { id },
    on: { change: (event) => updateFilter(context, name, event.target.value) },
  });
  for (const [key, text] of values) select.append(option(key, text, key === value));
  return element('label', { attributes: { for: id } }, [
    element('span', { text: `${prefix ? 'Mobile ' : ''}${label}` }),
    select,
  ]);
}

function filterControls(context, filters, rounds, prefix = '') {
  const searchId = `${prefix}filter-search`;
  const search = element('input', {
    attributes: {
      id: searchId,
      type: 'search',
      value: filters.search,
      placeholder: 'ID, title, rationale',
    },
  });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => updateFilter(context, 'q', search.value.trim()), 120);
  });
  return [
    element('label', { attributes: { for: searchId } }, [element('span', { text: `${prefix ? 'Mobile ' : ''}Search experiments` }), search]),
    selectControl(context, 'Lifecycle', 'status', filters.status, [
      ['all', 'All lifecycle states'],
      ['active', 'Group · Active'],
      ['review', 'Review'],
      ['finished', 'Group · Finished'],
      ['failed', 'Group · Failed / stopped'],
      ['queued', 'Queued'],
      ['mutating', 'Mutating'],
      ['gating', 'Gating'],
      ['building', 'Building'],
      ['starting', 'Starting'],
      ['running', 'Running'],
      ['judging', 'Judging'],
      ['completed', 'Completed'],
      ['rejected', 'Rejected'],
      ['stopped', 'Stopped'],
    ], prefix),
    selectControl(context, 'Round', 'round', filters.round, [
      ['all', 'All rounds'],
      ...rounds.map((round) => [String(round), `Round ${round}`]),
    ], prefix),
    selectControl(context, 'Lineage scope', 'lineage', filters.lineage, [
      ['all', 'All lineage'],
      ['current-branch', 'Current branch'],
      ['roots', 'Roots'],
      ['current-candidates', 'Current candidates'],
    ], prefix),
    selectControl(context, 'Result state', 'result', filters.result, [
      ['all', 'All results'],
      ['consensus', 'Consensus'],
      ['live', 'Live'],
      ['unscored', 'Unscored'],
      ['failed', 'Failed'],
    ], prefix),
    selectControl(context, 'Sort', 'sort', filters.sort, [
      ['ordinal', 'Ordinal'],
      ['activity', 'Recent activity'],
      ['verified', 'Verified accuracy'],
      ['provisional', 'Provisional accuracy'],
      ['agreement', 'Agreement'],
      ['elapsed', 'Elapsed'],
      ['tokens', 'Planner tokens'],
      ['cost', 'Planner cost'],
    ], prefix),
  ];
}

function clearFilters(context) {
  context.navigate(location.pathname, { replace: true });
}

function filterPanels(context, filters, rounds, count) {
  const clear = element('button', {
    className: 'button button-ghost clear-filters',
    text: 'Clear filters',
    attributes: { type: 'button', disabled: count === 0 },
    on: { click: () => clearFilters(context) },
  });
  const desktop = element('aside', { className: 'filter-rail', attributes: { 'aria-label': 'Experiment filters' } }, [
    element('div', { className: 'filter-title' }, [element('h2', { text: 'Filters' }), element('span', { className: 'filter-count', text: count })]),
    ...filterControls(context, filters, rounds),
    clear,
  ]);
  const mobile = element('details', { className: 'mobile-filters' }, [
    element('summary', {}, [element('span', { text: 'Filters' }), element('span', { className: 'filter-count', text: count })]),
    element('div', { className: 'mobile-filter-fields' }, [
      ...filterControls(context, filters, rounds, 'mobile-'),
      element('button', {
        className: 'button button-ghost clear-filters',
        text: 'Clear filters',
        attributes: { type: 'button', disabled: count === 0 },
        on: { click: () => clearFilters(context) },
      }),
    ]),
  ]);
  return [desktop, mobile];
}

function ledger(campaign, variants) {
  const body = element('tbody');
  for (const variant of variants) {
    const usage = plannerTotals(campaign, variant);
    const mean = campaign.config.investigator?.enabled || variant.score?.metricMode === 'replicate_mean';
    body.append(
      element('tr', { attributes: { 'data-testid': `experiment-row-${variant.id}` } }, [
        tableCell(String(variant.ordinal).padStart(3, '0'), 'mono'),
        element('td', { className: 'experiment-cell' }, [
          routeLink(
            variant.hypothesis.title,
            `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}`,
            'ledger-title',
          ),
          element('small', { text: variant.hypothesis.expectedImpact }),
          element('span', { className: 'identifier', text: variant.id }),
          variant.investigation ? routeLink(
            investigationSummary(variant.investigation),
            `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=investigation`,
            'ledger-investigation',
          ) : null,
        ]),
        tableCell(`R${variant.round} · ${variant.parentVariantId ?? 'seed'}`, 'mono'),
        element('td', {}, [statusLabel(variant.status)]),
        element('td', {}, [
          element('span', { text: resultState(variant) === 'consensus' ? 'Consensus decisions' : resultState(variant) }),
          mean ? element('small', { className: 'score-basis', text: 'Score: replicate mean' }) : null,
        ]),
        tableCell(mean ? formatMeanScore(variant.score?.verified) : `${formatPercent(variant.score?.verified.accuracy)} · ${variant.score?.verified.labeled ?? 0}`, 'mono'),
        tableCell(mean ? formatMeanScore(variant.score?.provisional) : `${formatPercent(variant.score?.provisional.accuracy)} · ${variant.score?.provisional.labeled ?? 0}`, 'mono'),
        tableCell(formatAgreement(variant.facts), 'mono'),
        tableCell(holdoutState(campaign, variant, campaign.variants)),
        tableCell(formatNumber(scopedQuestions(variant).length), 'mono numeric'),
        tableCell(formatDuration(effectiveElapsed(variant.elapsedMs, variant.startedAt, variant.completedAt)), 'mono'),
        tableCell(formatNumber(usage.observations ? usage.totalTokens : null), 'mono numeric'),
        tableCell(formatMoney(usage.observations ? usage.costUsd : null), 'mono numeric'),
      ]),
    );
  }
  if (!variants.length) {
    const cell = tableCell('No experiments match the active filters.');
    cell.colSpan = 13;
    body.append(element('tr', {}, [cell]));
  }
  return element('div', { className: 'table-scroll ledger-scroll' }, [
    element('table', { className: 'experiment-ledger' }, [
      element('caption', { text: 'Filterable planner experiment ledger' }),
      element('thead', {}, [element('tr', {}, [
        '#', 'Experiment', 'Lineage', 'Lifecycle', 'Result', 'Verified', 'Provisional', 'Agreement',
        'Holdout', 'Questions', 'Elapsed', 'Tokens', 'Cost',
      ].map((label) => element('th', { text: label, attributes: { scope: 'col' } })))]),
      body,
    ]),
  ]);
}

export function experimentsPage(context, route) {
  const campaign = context.state.campaign;
  const variants = campaign.variants ?? [];
  const filters = readFilters(route.query);
  const rounds = [...new Set(variants.map((variant) => variant.round))].sort((a, b) => a - b);
  const filtered = filterAndSortVariants(campaign, [...variants], filters);
  const activeCount = [filters.search, filters.status !== 'all', filters.round !== 'all', filters.lineage !== 'all', filters.result !== 'all', filters.sort !== 'ordinal']
    .filter(Boolean).length;
  const [desktopFilters, mobileFilters] = filterPanels(context, filters, rounds, activeCount);
  return element('div', { className: 'page' }, [
    campaignHeading(campaign, context),
    mobileFilters,
    element('div', { className: 'ledger-layout' }, [
      desktopFilters,
      element('section', { className: 'ledger-content' }, [
        sectionHeading('Experiments', `${filtered.length} of ${variants.length} variants`, 'Correctness dimensions remain separate from runtime and cost.'),
        ledger(campaign, filtered),
      ]),
    ]),
  ]);
}
