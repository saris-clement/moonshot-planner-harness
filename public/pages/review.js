import { api } from '../api.js';
import { element, option, statusLabel, tableCell, text } from '../dom.js';
import { clearReviewDraft, setReviewDraft, state } from '../state.js';
import { experimentHeading, routeLink, sectionHeading } from '../ui.js';

const filters = [
  ['all', 'All units'],
  ['unverified', 'Needs review'],
  ['errors', 'Decision differs'],
  ['build', 'Build'],
  ['reuse', 'Reuse'],
  ['extend', 'Extend'],
];

const sourceReferencePattern = /(?<![a-z0-9_.\/-])((?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|json|kt|kts|md|php|py|rb|rs|sh|sql|toml|ts|tsx|yaml|yml))(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?/gi;

function sourceUrl(campaign, sourcePath, ranges) {
  const query = new URLSearchParams({ path: sourcePath });
  if (ranges) query.set('lines', ranges);
  const firstLine = ranges?.match(/^\d+/)?.[0];
  return `/campaigns/${encodeURIComponent(campaign.id)}/source?${query}${firstLine ? `#L${firstLine}` : ''}`;
}

function linkedSourceText(campaign, value) {
  const children = [];
  let cursor = 0;
  for (const match of value.matchAll(sourceReferencePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) children.push(text(value.slice(cursor, index)));
    const [label, sourcePath, ranges] = match;
    children.push(element('a', {
      className: 'source-reference',
      text: label,
      attributes: {
        href: sourceUrl(campaign, sourcePath, ranges),
        target: '_blank',
        rel: 'noopener',
        title: `Open ${sourcePath}${ranges ? ` at lines ${ranges}` : ''} from the frozen campaign source`,
      },
    }));
    cursor = index + label.length;
  }
  if (cursor < value.length) children.push(text(value.slice(cursor)));
  return children.length ? children : [text(value)];
}

function sourceReferenceList(campaign, values, separator) {
  const children = [];
  values.forEach((value, index) => {
    if (index > 0) children.push(text(separator));
    children.push(...linkedSourceText(campaign, value));
  });
  return children;
}

function evaluationFor(variant, benchmark, primaryName) {
  return benchmark === primaryName
    ? { facts: variant.facts, judgment: variant.judgment }
    : { facts: variant.holdoutFacts?.[benchmark], judgment: variant.holdoutJudgments?.[benchmark] };
}

function reviewUrl(campaign, variant, values) {
  const query = new URLSearchParams({ benchmark: values.benchmark, filter: values.filter });
  if (values.unit) query.set('unit', values.unit);
  return `/campaigns/${encodeURIComponent(campaign.id)}/review/${encodeURIComponent(variant.id)}?${query}`;
}

function expectedFor(unit, label, suggestion) {
  return label?.expectedDecision ?? suggestion?.expectedDecision ?? null;
}

function visibleUnits(units, filter, labels, suggestions) {
  return units.filter((unit) => {
    const label = labels.get(unit.key);
    const suggestion = suggestions.get(unit.key);
    if (filter === 'unverified') return label?.status !== 'verified';
    if (filter === 'errors') return expectedFor(unit, label, suggestion) !== unit.decision;
    if (['build', 'reuse', 'extend'].includes(filter)) return unit.decision === filter;
    return true;
  });
}

function selectWithOptions(name, label, values, selected) {
  const id = `review-${name}`;
  const select = element('select', { attributes: { id, name } });
  for (const [value, title] of values) select.append(option(value, title, value === selected));
  return element('label', { attributes: { for: id } }, [element('span', { text: label }), select]);
}

function isJsonCollection(value) {
  return value !== null && typeof value === 'object';
}

function jsonCollectionParts(value) {
  if (Array.isArray(value)) {
    return {
      entries: value.map((item, index) => [String(index), item]),
      opening: '[',
      closing: ']',
      description: `${value.length} ${value.length === 1 ? 'item' : 'items'}`,
    };
  }
  const entries = Object.entries(value);
  return {
    entries,
    opening: '{',
    closing: '}',
    description: `${entries.length} ${entries.length === 1 ? 'property' : 'properties'}`,
  };
}

function appendJsonKey(code, name) {
  if (name === undefined) return;
  code.append(
    element('span', { className: 'json-viewer-key', text: JSON.stringify(name) }),
    element('span', { className: 'json-viewer-punctuation', text: ': ' }),
  );
}

function jsonEntry(value, name, trailingComma) {
  const parts = isJsonCollection(value) ? jsonCollectionParts(value) : null;
  if (!parts || parts.entries.length === 0) {
    const code = element('code');
    appendJsonKey(code, name);
    if (parts) {
      code.append(element('span', { className: 'json-viewer-punctuation', text: `${parts.opening}${parts.closing}` }));
    } else {
      const kind = value === null ? 'null' : typeof value;
      code.append(
        element('span', {
          className: `json-viewer-value json-viewer-value-${kind}`,
          text: kind === 'string' ? JSON.stringify(value) : String(value),
        }),
      );
    }
    if (trailingComma) code.append(element('span', { className: 'json-viewer-punctuation', text: ',' }));
    return element('div', { className: 'json-viewer-line' }, [code]);
  }

  const summaryCode = element('code');
  appendJsonKey(summaryCode, name);
  summaryCode.append(
    element('span', { className: 'json-viewer-punctuation', text: parts.opening }),
    element('span', { className: 'json-viewer-preview', text: `…${parts.closing}` }),
  );
  if (trailingComma) {
    summaryCode.append(element('span', { className: 'json-viewer-summary-comma', text: ',' }));
  }
  summaryCode.append(element('span', { className: 'json-viewer-count', text: parts.description }));
  const toggleLabel = name ?? (Array.isArray(value) ? 'root array' : 'root object');
  const summary = element('summary', { attributes: { 'aria-label': `Toggle ${toggleLabel}` } }, [summaryCode]);
  const children = element('div', { className: 'json-viewer-children' });
  parts.entries.forEach(([key, item], index) => {
    children.append(jsonEntry(item, Array.isArray(value) ? undefined : key, index < parts.entries.length - 1));
  });
  const closingCode = element('code', {}, [
    element('span', { className: 'json-viewer-punctuation', text: parts.closing }),
    trailingComma ? element('span', { className: 'json-viewer-punctuation', text: ',' }) : null,
  ]);
  children.append(element('div', { className: 'json-viewer-line json-viewer-closing' }, [closingCode]));
  return element('details', { className: 'json-viewer-node', attributes: { open: true } }, [summary, children]);
}

function requirementSemantics(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return element('p', { text: value });
  }
  const description = isJsonCollection(parsed) ? jsonCollectionParts(parsed).description : 'JSON value';
  return element('figure', { className: 'json-viewer', attributes: { 'aria-label': 'Requirement JSON' } }, [
    element('figcaption', { className: 'json-viewer-header' }, [
      element('span', { text: 'JSON' }),
      element('span', { text: description }),
    ]),
    element('div', { className: 'json-viewer-body' }, [jsonEntry(parsed, undefined, false)]),
  ]);
}

function reviewDetail(context, campaign, variant, benchmark, unit, suggestion, label) {
  if (!unit) {
    return element('aside', { className: 'review-detail empty-detail' }, [
      element('p', { className: 'overline', text: 'Requirement review' }),
      element('h2', { text: 'Select a requirement' }),
      element('p', { text: 'Inspect measured output and the blind-judge suggestion before recording human truth.' }),
    ]);
  }
  const draftKey = `${campaign.id}\u0000${variant.id}\u0000${benchmark}\u0000${unit.key}`;
  const draft = state.reviewDraft?.key === draftKey ? state.reviewDraft : null;
  const expectedDecision = draft?.expectedDecision ?? label?.expectedDecision ?? suggestion?.expectedDecision ?? 'build';
  const classification = draft?.classification ?? label?.classification ?? suggestion?.classification ?? 'uncertain';
  const rationale = draft?.rationale ?? (label?.status === 'verified' ? label.rationale : '');
  const form = element('form', { className: 'label-form' });
  const decisionField = selectWithOptions(
    'expectedDecision',
    'Expected disposition',
    ['build', 'reuse', 'extend', 'defer', 'question'].map((value) => [value, value]),
    expectedDecision,
  );
  const classificationField = selectWithOptions(
    'classification',
    'Gap classification',
    ['system_error', 'real_gap', 'uncertain'].map((value) => [value, value.replaceAll('_', ' ')]),
    classification,
  );
  const rationaleInput = element('textarea', {
    text: rationale,
    attributes: { id: 'review-rationale', name: 'rationale', required: true, placeholder: 'Record why the source proves this disposition' },
  });
  const updateDraft = () => {
    const values = new FormData(form);
    setReviewDraft({
      key: draftKey,
      expectedDecision: values.get('expectedDecision'),
      classification: values.get('classification'),
      rationale: values.get('rationale'),
    });
    document.querySelector('.connection-state span:last-child').textContent = 'Review draft open';
  };
  form.append(
    decisionField,
    classificationField,
    element('label', { attributes: { for: 'review-rationale' } }, [element('span', { text: 'Human rationale' }), rationaleInput]),
    element('button', { className: 'button button-primary', text: 'Save verified truth', attributes: { type: 'submit' } }),
  );
  form.addEventListener('input', updateDraft);
  form.addEventListener('change', updateDraft);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    try {
      await api(`/api/campaigns/${encodeURIComponent(campaign.id)}/label`, {
        method: 'PUT',
        body: JSON.stringify({
          benchmark,
          unitKey: unit.key,
          expectedDecision: values.get('expectedDecision'),
          classification: values.get('classification'),
          rationale: values.get('rationale'),
        }),
      });
      clearReviewDraft();
      context.notify('Verified label saved');
      await context.refreshCurrent();
    } catch (error) {
      context.notify(error.message);
    }
  });
  const refs = unit.sourceRefs.map((item) => item.path ?? item.capabilityId).filter(Boolean);
  return element('aside', { className: 'review-detail' }, [
    element('p', { className: 'overline', text: unit.ref.entity }),
    element('div', { className: 'review-unit-anchor' }, [
      element('h2', { text: unit.ref.anchor }),
      element('button', {
        className: 'button button-ghost button-compact unit-anchor-copy',
        text: 'Copy',
        attributes: { type: 'button', 'aria-label': 'Copy unit anchor' },
        on: { click: () => context.copyText(unit.ref.anchor, 'unit anchor') },
      }),
    ]),
    requirementSemantics(unit.semantics),
    element('div', { className: 'fact-pills' }, [
      element('span', { text: `Observed ${unit.decision}` }),
      element('span', { text: `${unit.confidence} confidence` }),
      element('span', { text: `${unit.shortlistCandidateCount} candidates` }),
      element('span', { text: `${unit.discoveredEvidenceCount} discoveries` }),
    ]),
    element('section', { className: 'evidence-block' }, [
      element('h3', { text: 'Planner rationale · measured output' }),
      element('p', { text: unit.rationale }),
      element('p', { className: 'muted source-evidence' }, [
        text('Source references: '),
        ...(refs.length ? sourceReferenceList(campaign, refs, ', ') : [text('none')]),
      ]),
    ]),
    element('section', { className: 'evidence-block suggestion' }, [
      element('h3', { text: 'Blind judge · suggestion' }),
      element('p', { text: suggestion?.rationale ?? 'No suggestion available.' }),
      suggestion?.evidence?.length
        ? element('p', { className: 'muted source-evidence' }, sourceReferenceList(campaign, suggestion.evidence, ' · '))
        : null,
    ]),
    form,
  ]);
}

export function reviewPage(context, route) {
  const campaign = context.state.campaign;
  const variant = campaign.variants.find((candidate) => candidate.id === route.params.variantId);
  if (!variant) return element('div', { className: 'empty-state', text: 'Experiment not found in this campaign.' });
  const primaryName = campaign.config.benchmarks.find((item) => item.role === 'primary')?.name;
  const benchmark = campaign.config.benchmarks.some((item) => item.name === route.query.get('benchmark'))
    ? route.query.get('benchmark')
    : primaryName;
  const filter = filters.some(([value]) => value === route.query.get('filter')) ? route.query.get('filter') : 'all';
  const selectedUnit = route.query.get('unit');
  const evaluation = evaluationFor(variant, benchmark, primaryName);
  const units = evaluation.facts?.units ?? [];
  const labels = new Map(
    campaign.labels.filter((item) => item.benchmark === benchmark).map((item) => [item.unitKey, item]),
  );
  const suggestions = new Map((evaluation.judgment?.verdicts ?? []).map((item) => [item.unitKey, item]));
  const visible = visibleUnits(units, filter, labels, suggestions);
  const toolbar = element('div', { className: 'review-toolbar' });
  const benchmarkSelect = element('select', { attributes: { 'aria-label': 'Select benchmark' } });
  for (const item of campaign.config.benchmarks) {
    benchmarkSelect.append(option(item.name, `${item.name} · ${item.role}`, item.name === benchmark));
  }
  benchmarkSelect.addEventListener('change', (event) => {
    const moved = context.navigate(reviewUrl(campaign, variant, { benchmark: event.target.value, filter, unit: '' }));
    if (!moved) context.render();
  });
  const filterSelect = element('select', { attributes: { 'aria-label': 'Filter requirement units' } });
  for (const [value, label] of filters) filterSelect.append(option(value, label, value === filter));
  filterSelect.addEventListener('change', (event) => {
    const moved = context.navigate(reviewUrl(campaign, variant, { benchmark, filter: event.target.value, unit: '' }));
    if (!moved) context.render();
  });
  toolbar.append(benchmarkSelect, filterSelect);

  const body = element('tbody');
  for (const unit of visible) {
    const label = labels.get(unit.key);
    const suggestion = suggestions.get(unit.key);
    const truth = label?.status ?? (suggestion ? 'suggested' : 'unreviewed');
    const button = element('button', {
      className: 'unit-select',
      attributes: { type: 'button', 'aria-pressed': String(unit.key === selectedUnit) },
      on: {
        click: () => context.navigate(reviewUrl(campaign, variant, { benchmark, filter, unit: unit.key })),
      },
    }, [element('b', { text: `${unit.kind} · ${unit.ref.anchor}` }), element('span', { text: unit.semantics })]);
    body.append(element('tr', { className: unit.key === selectedUnit ? 'selected' : '' }, [
      element('td', { className: 'review-unit-cell' }, [button]),
      tableCell(unit.decision, `decision-${unit.decision}`),
      tableCell(expectedFor(unit, label, suggestion) ?? '—'),
      element('td', {}, [statusLabel(truth)]),
    ]));
  }
  if (!visible.length) {
    const cell = tableCell('No requirement units match this filter.');
    cell.colSpan = 4;
    body.append(element('tr', {}, [cell]));
  }
  const unit = units.find((candidate) => candidate.key === selectedUnit);
  const back = routeLink(
    'Back to experiment',
    `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=summary`,
    'button button-ghost',
  );
  return element('div', { className: 'page review-page' }, [
    experimentHeading(campaign, variant, context, [back]),
    element('div', { className: 'review-title-row' }, [
      sectionHeading('Human truth', 'Requirement review', 'Measured output and model suggestions remain distinct from saved verification.'),
      toolbar,
    ]),
    element('div', { className: 'review-workspace' }, [
      element('div', { className: 'table-scroll review-unit-list' }, [
        element('table', {}, [
          element('caption', { text: 'Requirement-unit decisions and review status' }),
          element('thead', {}, [element('tr', {}, ['Unit', 'Observed', 'Expected', 'Truth'].map((label) => element('th', { text: label })))]),
          body,
        ]),
      ]),
      reviewDetail(context, campaign, variant, benchmark, unit, suggestions.get(selectedUnit), labels.get(selectedUnit)),
    ]),
  ]);
}
