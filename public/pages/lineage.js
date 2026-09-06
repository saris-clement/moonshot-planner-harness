import {
  element,
  formatDuration,
  formatNumber,
  formatPercent,
  option,
  statusLabel,
} from '../dom.js';
import {
  currentPathIds,
  effectiveElapsed,
  holdoutState,
  plannerTotals,
  siblingScoreRanks,
} from '../models.js';
import { campaignHeading, routeLink, sectionHeading } from '../ui.js';

function lineageCard(campaign, variants, variant, rank, onPath) {
  const usage = plannerTotals(campaign, variant);
  const card = element('article', {
    className: `lineage-card${onPath ? ' current-path' : ''}${variant.id === campaign.currentParentVariantId ? ' current-head' : ''}`,
    attributes: { 'data-lineage-id': variant.id, 'data-parent-id': variant.parentVariantId ?? '' },
  }, [
    element('div', { className: 'lineage-card-top' }, [
      element('span', { className: 'lineage-ordinal', text: `#${String(variant.ordinal).padStart(3, '0')}` }),
      statusLabel(variant.status),
    ]),
    routeLink(
      variant.hypothesis.title,
      `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}`,
      'lineage-card-title',
    ),
    element('p', { className: 'identifier', text: variant.id }),
    element('dl', { className: 'lineage-metrics' }, [
      element('div', {}, [element('dt', { text: 'Sibling rank' }), element('dd', { text: rank ? `${rank}` : 'Unscored' })]),
      element('div', {}, [element('dt', { text: 'Verified' }), element('dd', { text: `${formatPercent(variant.score?.verified.accuracy)} · ${variant.score?.verified.labeled ?? 0}/${variant.facts?.unitCount ?? 0}` })]),
      element('div', {}, [element('dt', { text: 'Provisional' }), element('dd', { text: `${formatPercent(variant.score?.provisional.accuracy)} · ${variant.score?.provisional.labeled ?? 0}` })]),
      element('div', {}, [element('dt', { text: 'Agreement' }), element('dd', { text: formatPercent(variant.facts?.decisionAgreement) })]),
      element('div', {}, [element('dt', { text: 'Holdout' }), element('dd', { text: holdoutState(campaign, variant, variants) })]),
      element('div', {}, [element('dt', { text: 'Cohort drift' }), element('dd', { text: variant.score ? (variant.score.cohortMismatches?.length ? variant.score.cohortMismatches.join(', ') : 'None observed') : 'Not evaluated' })]),
      element('div', {}, [element('dt', { text: 'Elapsed' }), element('dd', { text: formatDuration(effectiveElapsed(variant.elapsedMs, variant.startedAt, variant.completedAt)) })]),
      element('div', {}, [element('dt', { text: 'Planner tokens' }), element('dd', { text: formatNumber(usage.observations ? usage.totalTokens : null) })]),
    ]),
    variant.id === campaign.currentParentVariantId
      ? element('div', { className: 'head-flag', text: 'Current campaign head' })
      : null,
  ]);
  return card;
}

function drawConnectors(canvas, svg, pathIds) {
  if (!canvas.isConnected) return;
  const canvasBounds = canvas.getBoundingClientRect();
  const cards = new Map(
    [...canvas.querySelectorAll('[data-lineage-id]')].map((card) => [card.dataset.lineageId, card]),
  );
  svg.replaceChildren();
  svg.setAttribute('width', String(canvas.scrollWidth));
  svg.setAttribute('height', String(canvas.scrollHeight));
  svg.setAttribute('viewBox', `0 0 ${canvas.scrollWidth} ${canvas.scrollHeight}`);
  for (const card of cards.values()) {
    const parent = cards.get(card.dataset.parentId);
    if (!parent) continue;
    const parentBounds = parent.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    const x1 = parentBounds.right - canvasBounds.left;
    const y1 = parentBounds.top - canvasBounds.top + parentBounds.height / 2;
    const x2 = cardBounds.left - canvasBounds.left;
    const y2 = cardBounds.top - canvasBounds.top + cardBounds.height / 2;
    const midpoint = x1 + Math.max(20, (x2 - x1) / 2);
    svg.append(
      element('path', {
        className: pathIds.has(parent.dataset.lineageId) && pathIds.has(card.dataset.lineageId)
          ? 'connector current-path-connector'
          : 'connector',
        attributes: { d: `M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}` },
      }),
    );
  }
}

function graphView(campaign, variants, ranks, pathIds, zoom) {
  const rounds = [...new Set(variants.map((variant) => variant.round))].sort((a, b) => a - b);
  const canvas = element('div', { className: `lineage-canvas zoom-${zoom}` });
  const svg = element('svg', { className: 'lineage-connectors', attributes: { 'aria-hidden': 'true' } });
  const columns = element('div', { className: 'lineage-columns' });
  for (const round of rounds) {
    columns.append(
      element('section', { className: 'lineage-column', attributes: { 'aria-label': `Round ${round}` } }, [
        element('h2', { text: round === 0 ? 'Seed' : `Round ${round}` }),
        ...variants
          .filter((variant) => variant.round === round)
          .map((variant) => lineageCard(campaign, variants, variant, ranks.get(variant.id), pathIds.has(variant.id))),
      ]),
    );
  }
  canvas.append(svg, columns);
  requestAnimationFrame(() => drawConnectors(canvas, svg, pathIds));
  const observer = new ResizeObserver(() => {
    if (!canvas.isConnected) observer.disconnect();
    else drawConnectors(canvas, svg, pathIds);
  });
  observer.observe(columns);
  return element('div', { className: 'lineage-graph-scroll', attributes: { 'data-testid': 'lineage-graph' } }, [canvas]);
}

function listView(campaign, variants, ranks, pathIds) {
  return element('div', { className: 'lineage-list', attributes: { 'data-testid': 'lineage-list' } },
    variants.map((variant) =>
      element('div', { className: 'lineage-list-row' }, [
        element('div', { className: 'lineage-list-parent', text: variant.parentVariantId ? `from ${variant.parentVariantId}` : 'frozen seed' }),
        lineageCard(campaign, variants, variant, ranks.get(variant.id), pathIds.has(variant.id)),
      ]),
    ),
  );
}

function setQuery(context, name, value) {
  const next = new URL(location.href);
  next.searchParams.set(name, value);
  context.navigate(`${next.pathname}${next.search}`, { replace: true });
}

export function lineagePage(context, route) {
  const campaign = context.state.campaign;
  const variants = [...(campaign.variants ?? [])];
  const mobile = matchMedia('(max-width: 700px)').matches;
  const requestedView = route.query.get('view');
  const view = ['graph', 'list'].includes(requestedView) ? requestedView : mobile ? 'list' : 'graph';
  const zoom = ['85', '100', '115'].includes(route.query.get('zoom')) ? route.query.get('zoom') : '100';
  const ranks = siblingScoreRanks(variants);
  const pathIds = currentPathIds(campaign, variants);
  const controls = element('div', { className: 'lineage-controls' }, [
    element('div', { className: 'segmented', attributes: { 'aria-label': 'Lineage view' } }, [
      element('button', {
        className: view === 'graph' ? 'active' : '',
        text: 'Graph',
        attributes: { type: 'button', 'aria-pressed': String(view === 'graph') },
        on: { click: () => setQuery(context, 'view', 'graph') },
      }),
      element('button', {
        className: view === 'list' ? 'active' : '',
        text: 'List',
        attributes: { type: 'button', 'aria-pressed': String(view === 'list') },
        on: { click: () => setQuery(context, 'view', 'list') },
      }),
    ]),
    view === 'graph'
      ? element('label', { className: 'zoom-control' }, [
          element('span', { text: 'Zoom' }),
          element('select', {
            attributes: { 'aria-label': 'Lineage zoom' },
            on: { change: (event) => setQuery(context, 'zoom', event.target.value) },
          }, [option('85', '85%', zoom === '85'), option('100', '100%', zoom === '100'), option('115', '115%', zoom === '115')]),
        ])
      : null,
  ]);
  return element('div', { className: 'page lineage-page' }, [
    campaignHeading(campaign, context),
    element('div', { className: 'lineage-heading' }, [
      sectionHeading('Lineage', `${variants.length} experiment nodes`, 'Sibling rank follows the primary lexicographic score rubric. No composite score is shown.'),
      controls,
    ]),
    view === 'graph'
      ? graphView(campaign, variants, ranks, pathIds, zoom)
      : listView(campaign, variants, ranks, pathIds),
  ]);
}
