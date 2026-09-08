import {
  element,
  formatAgreement,
  formatDuration,
  formatMeanScore,
  formatNumber,
  formatPercent,
  option,
  statusLabel,
} from '../dom.js';
import {
  currentPathIds,
  effectiveElapsed,
  executionHealth,
  holdoutState,
  plannerTotals,
  siblingScoreRanks,
} from '../models.js';
import { campaignHeading, routeLink, sectionHeading } from '../ui.js';
import { liveRegion, updateLiveView } from '../live.js';
import { sanitizeDiagnosticValue } from '../diagnostics.js';

const graphPanels = new WeakMap();

function lineageCard(campaign, variants, variant, rank, onPath) {
  const usage = plannerTotals(campaign, variant);
  // Screening is a preview of a specific immutable trial, never a replacement promotion score.
  const finalEvaluation = variant.score && variant.facts;
  const trial = finalEvaluation ? null : variant.investigation?.actions?.findLast((action) =>
    action.kind === 'evaluate_primary' && action.status === 'completed' && action.result?.score,
  );
  const score = finalEvaluation ? variant.score : trial?.result.score;
  const facts = finalEvaluation ? variant.facts : trial?.result.facts;
  const mean = Boolean(trial) || campaign.config.investigator?.enabled || score?.metricMode === 'replicate_mean';
  const baselineAccuracy = trial?.result.baselineScore?.provisional?.accuracy;
  const accuracy = score?.provisional?.accuracy;
  const delta = Number.isFinite(baselineAccuracy) && Number.isFinite(accuracy) ? (accuracy - baselineAccuracy) * 100 : null;
  const differentRevision = trial && (
    (variant.patchHash && trial.patchHash && variant.patchHash !== trial.patchHash) ||
    (trial.hypothesis && JSON.stringify(variant.hypothesis) !== JSON.stringify(trial.hypothesis))
  );
  const reason = variant.investigation?.reason || variant.error;
  const abandoned = variant.investigation?.status === 'abandoned';
  const investigationUrl = `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=investigation`;
  const card = element('article', {
    className: `lineage-card${onPath ? ' current-path' : ''}${variant.id === campaign.currentParentVariantId ? ' current-head' : ''}`,
    attributes: { 'data-live-key': variant.id, 'data-lineage-id': variant.id, 'data-parent-id': variant.parentVariantId ?? '' },
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
    executionHealth(campaign, variant).label ? element('p', { className: 'failure-status', text: executionHealth(campaign, variant).label }) : null,
    element('div', { className: 'lineage-measurement' }, [
      element('p', { className: 'overline', text: trial ? `Latest screening: ${trial.id}` : finalEvaluation ? variant.round === 0 ? 'Baseline evaluation' : 'Final evaluation' : 'No evaluation recorded' }),
      trial ? element('p', { text: trial.hypothesis?.title ?? 'Recorded screening hypothesis' }) : null,
      differentRevision ? element('p', { className: 'muted', text: 'Latest revision not evaluated. Metrics below belong to the earlier trial.' }) : null,
    ]),
    element('dl', { className: 'lineage-metrics' }, [
      element('div', {}, [element('dt', { text: 'Sibling rank' }), element('dd', { text: rank ? `${rank}` : 'Unranked' })]),
      element('div', {}, [element('dt', { text: 'Verified' }), element('dd', { className: mean ? 'mean-score' : '', text: !score ? 'Not measured' : score.verified?.labeled === 0 ? 'No reviewed labels' : mean ? formatMeanScore(score.verified) : `${formatPercent(score.verified?.accuracy)} · ${score.verified?.labeled ?? 0}/${facts?.unitCount ?? 0}` })]),
      element('div', {}, [element('dt', { text: 'Provisional' }), element('dd', { className: mean ? 'mean-score' : '', text: !score ? 'Not measured' : mean ? formatMeanScore(score.provisional) : `${formatPercent(score.provisional?.accuracy)} · ${score.provisional?.labeled ?? 0}` })]),
      element('div', {}, [element('dt', { text: 'Agreement' }), element('dd', { className: 'agreement-value', text: formatAgreement(facts, trial?.result.replicateFacts?.length || facts?.sampleSize) })]),
      element('div', {}, [element('dt', { text: 'Holdout' }), element('dd', { text: !finalEvaluation && abandoned ? 'Not run' : holdoutState(campaign, variant, variants) })]),
      element('div', {}, [element('dt', { text: 'Cohort drift' }), element('dd', { text: score ? (score.cohortMismatches?.length ? score.cohortMismatches.join(', ') : 'None observed') : 'Not evaluated' })]),
      element('div', {}, [element('dt', { text: variant.investigation ? 'Investigation time' : 'Elapsed' }), element('dd', { text: formatDuration(variant.investigation
        ? effectiveElapsed(null, variant.investigation.startedAt, variant.investigation.status === 'running' ? null : variant.investigation.updatedAt)
        : effectiveElapsed(variant.elapsedMs, variant.startedAt, variant.completedAt)) })]),
      element('div', {}, [element('dt', { text: 'Planner tokens' }), element('dd', { text: formatNumber(usage.observations ? usage.totalTokens : null) })]),
    ]),
    delta !== null ? element('p', { className: 'lineage-comparison', text: `Baseline ${formatPercent(baselineAccuracy)} · ${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp provisional` }) : null,
    reason ? element('section', { className: 'lineage-outcome' }, [
      element('h3', { text: abandoned && !finalEvaluation ? 'Abandoned before final evaluation' : 'Recorded outcome' }),
      element('p', { className: 'muted', text: variant.investigation?.reason ? 'Agent explanation, not verified causality' : 'Coordinator record' }),
      element('p', { text: sanitizeDiagnosticValue(reason) }),
    ]) : null,
    variant.investigation ? routeLink('View investigation', investigationUrl, 'lineage-investigation-link') : null,
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
  const next = svg.cloneNode(false);
  next.setAttribute('width', String(canvas.clientWidth));
  next.setAttribute('height', String(canvas.clientHeight));
  next.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
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
    const connector = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    connector.setAttribute('data-live-key', card.dataset.lineageId);
    connector.setAttribute('class', pathIds.has(parent.dataset.lineageId) && pathIds.has(card.dataset.lineageId)
      ? 'connector current-path-connector' : 'connector');
    connector.setAttribute('d', `M ${x1} ${y1} C ${midpoint} ${y1}, ${midpoint} ${y2}, ${x2} ${y2}`);
    next.append(connector);
  }
  updateLiveView(svg, next);
}

function graphView(campaign, variants, ranks, pathIds, zoom) {
  const rounds = [...new Set(variants.map((variant) => variant.round))].sort((a, b) => a - b);
  const canvas = element('div', { className: `lineage-canvas zoom-${zoom}` });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'lineage-connectors');
  svg.setAttribute('aria-hidden', 'true');
  const columns = element('div', { className: 'lineage-columns' });
  for (const round of rounds) {
    columns.append(
      element('section', { className: 'lineage-column', attributes: { 'aria-label': `Round ${round}`, 'data-live-key': `round-${round}` } }, [
        element('h2', { text: round === 0 ? 'Seed' : `Round ${round}` }),
        ...variants
          .filter((variant) => variant.round === round)
          .map((variant) => lineageCard(campaign, variants, variant, ranks.get(variant.id), pathIds.has(variant.id))),
      ]),
    );
  }
  canvas.append(svg, columns);
  return liveRegion(element('div', {
    className: 'lineage-graph-scroll',
    attributes: { 'data-testid': 'lineage-graph', 'data-live-key': `lineage-${campaign.id}` },
  }, [canvas]), (region) => {
    if (!region.isConnected) return;
    let state = graphPanels.get(region);
    if (!state) {
      state = { generation: 0, frame: null, pathIds, routeKey: '', schedule: null };
      graphPanels.set(region, state);
      const observer = new ResizeObserver(() => state.schedule());
      state.schedule = () => {
        cancelAnimationFrame(state.frame);
        if (!region.isConnected || `${location.pathname}${location.search}` !== state.routeKey) {
          observer.disconnect();
          state.generation++;
          graphPanels.delete(region);
          return;
        }
        const generation = state.generation;
        state.frame = requestAnimationFrame(() => {
          if (!region.isConnected || `${location.pathname}${location.search}` !== state.routeKey) {
            state.schedule();
            return;
          }
          if (generation !== state.generation) return;
          const mountedCanvas = region.querySelector('.lineage-canvas');
          drawConnectors(mountedCanvas, mountedCanvas.querySelector('.lineage-connectors'), state.pathIds);
        });
      };
      // Observing the scroll root also delivers its removal, so this observer can disconnect.
      observer.observe(region);
      observer.observe(region.querySelector('.lineage-columns'));
    }
    state.pathIds = pathIds;
    state.routeKey = `${location.pathname}${location.search}`;
    state.generation++;
    const mountedCanvas = region.querySelector('.lineage-canvas');
    const scrollTop = region.scrollTop;
    const scrollLeft = region.scrollLeft;
    const focused = document.activeElement;
    const focusedHere = region.contains(focused);
    mountedCanvas.className = `lineage-canvas zoom-${zoom}`;
    updateLiveView(mountedCanvas.querySelector('.lineage-columns'), columns);
    if (focusedHere && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    region.scrollTop = scrollTop;
    region.scrollLeft = scrollLeft;
    state.schedule();
  });
}

function listView(campaign, variants, ranks, pathIds) {
  return element('div', { className: 'lineage-list', attributes: { 'data-testid': 'lineage-list' } },
    variants.map((variant) =>
      element('div', { className: 'lineage-list-row', attributes: { 'data-live-key': variant.id } }, [
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
      sectionHeading('Lineage', `${variants.length} experiment nodes`, campaign.config.investigator?.enabled
        ? 'Rank uses baseline/final scores only. Screening previews identify the measured trial and do not score an unevaluated revision. Agreement measures consistency across replicas.'
        : 'Sibling rank follows the primary lexicographic score rubric. No composite score is shown.'),
      controls,
    ]),
    view === 'graph'
      ? graphView(campaign, variants, ranks, pathIds, zoom)
      : listView(campaign, variants, ranks, pathIds),
  ]);
}
