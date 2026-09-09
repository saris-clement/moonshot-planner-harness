import { api } from './api.js';
import { element, option, titleCase } from './dom.js';
import { liveRegion, updateLiveView } from './live.js';
import { sanitizeDiagnosticValue } from './diagnostics.js';

const tools = [
  ['list_observations', 'List observations'], ['compare_trial', 'Compare trial with frozen parent'],
  ['inspect_unit', 'Inspect unit'], ['read_evidence', 'Read evidence'], ['search_source', 'Search frozen source'],
];
const mountedPanels = new WeakSet();
const display = (value) => value === null || value === undefined ? 'Unknown'
  : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const percent = (value) => Number.isFinite(value) ? `${Number((value * 100).toFixed(1))}%` : 'Unknown';
const availability = (value) => value ? titleCase(value).replace('NextOffset', 'nextOffset') : 'Unknown';
const metrics = (entries) => element('dl', { className: 'evidence-metrics' }, entries.map(([label, value]) =>
  element('div', {}, [element('dt', { text: label }), element('dd', { text: display(value) })]),
));
const metadata = (value, label = 'Record metadata') => element('details', { className: 'evidence-metadata' }, [
  element('summary', { text: label }), element('pre', { text: display(sanitizeDiagnosticValue(value)), attributes: { tabindex: '0' } }),
]);

function distribution(value) {
  if (value === null) return 'Not captured';
  if (!value || typeof value !== 'object') return 'Unknown';
  if (value.availability) return availability(value.availability);
  const choices = Object.entries(value);
  return choices.length ? choices.map(([decision, fraction]) => `${titleCase(decision)} ${percent(fraction)}`).join(' / ') : 'No recorded choice';
}

function evidenceItem(item, kind, data, audit, navigateEvidence) {
  const safe = sanitizeDiagnosticValue(audit ? Object.fromEntries([
    'id', 'tool', 'scope', 'createdAt', 'bytes', 'status', 'requestRef', 'responseRef',
  ].map((key) => [key, item[key]])) : item);
  const contents = [];
  const action = (label, tool, query) => element('button', { className: 'button button-outline', text: label,
    attributes: { type: 'button' }, on: { click: () => navigateEvidence(tool, query) } });
  if (audit) {
    contents.push(element('h3', { text: `${safe.tool} / ${safe.status}` }), metrics([
      ['Recorded', safe.createdAt], ['Bytes', safe.bytes], ['Turn', safe.scope?.turn], ['Experiment', safe.scope?.variantId],
    ]));
  } else if (kind === 'compare_trial') {
    contents.push(element('div', { className: 'evidence-item-heading' }, [
      element('h3', { text: safe.unitKey ?? 'Unit reference' }),
      element('span', { className: 'muted', text: safe.changed === true ? 'Changed' : safe.changed === false ? 'Unchanged' : 'Change unknown' }),
    ]), metrics([
      ['Frozen parent decisions', distribution(safe.before)], ['Trial decisions', distribution(safe.after)],
      ['Expected decision', safe.expectedDecision ? titleCase(safe.expectedDecision) : 'Unknown'],
      ['Label basis', safe.labelStatus === 'verified' ? 'Human verified' : safe.labelStatus === 'suggested' ? 'LLM suggestion / unverified' : 'Unknown'],
      ['Parent fixed-label agreement', percent(safe.baselineAgreement)], ['Trial fixed-label agreement', percent(safe.trialAgreement)],
    ]));
  } else if (kind === 'inspect_unit') {
    contents.push(element('h3', { text: `Replicate ${display(safe.replicate)}` }));
    if (safe.availability === 'not_captured') contents.push(element('p', { className: 'muted', text: 'Not captured in this replicate. No decision can be inferred.' }));
    else contents.push(metrics([
      ['Decision', safe.decision ? titleCase(safe.decision) : 'Unknown'], ['Confidence (planner)', safe.confidence ? titleCase(safe.confidence) : 'Unknown'],
      ['Shortlist candidates', safe.shortlistCandidateCount], ['Discovered evidence', safe.discoveredEvidenceCount],
      ['Selected candidates', Array.isArray(safe.selectedCandidateIds) ? safe.selectedCandidateIds.join(', ') || 'None recorded' : availability(safe.selectedCandidateIds?.availability)],
      ['Analysis receipt', availability(safe.rawAnalysis?.availability ?? (safe.rawAnalysis?.evidenceRef ? 'available' : null))],
    ]), element('div', { className: 'evidence-source-list' }, [
      element('h4', { text: 'Source references' }),
      ...(Array.isArray(safe.sourceRefs) ? safe.sourceRefs.map((ref) => element('div', {}, [
        element('span', { text: `${ref.path ?? 'Path not captured'}${ref.symbol ? ` / ${ref.symbol}` : ''}` }),
        ref.evidenceRef ? action('Read source', 'read_evidence', { evidenceRef: ref.evidenceRef })
          : element('span', { className: 'muted', text: availability(ref.availability) }),
      ])) : []),
      !Array.isArray(safe.sourceRefs) || !safe.sourceRefs.length ? element('p', { className: 'muted', text: Array.isArray(safe.sourceRefs) ? 'No source references recorded.' : `Source references: ${availability(safe.sourceRefs?.availability)}` }) : null,
    ]));
  } else if (kind === 'read_evidence') {
    contents.push(element('p', { className: 'muted', text: `UTF-8 bytes ${display(safe.offset)} to ${display(safe.endOffset)}` }),
      element('pre', { className: 'evidence-text', text: safe.text ?? 'Text not captured.', attributes: { tabindex: '0', 'aria-label': 'Evidence excerpt' } }));
  } else if (kind === 'search_source') {
    contents.push(element('h3', { text: safe.path ?? 'Source match' }), element('p', { className: 'muted', text: `Line ${display(safe.line)} / UTF-8 byte offset ${display(safe.offset)}` }));
  } else if (safe.kind === 'observation') {
    contents.push(element('h3', { text: safe.actionId ?? safe.variantId ?? 'Recorded observation' }), metrics([
      ['Benchmark / arm', `${display(safe.benchmark)} / ${display(safe.arm)}`], ['Observation', safe.role],
      ['Replicates', safe.replicateCount], ['Units', safe.unitCount], ['Source', availability(safe.sourceAvailability)],
    ]));
  } else if (safe.kind === 'source') {
    contents.push(element('h3', { text: `${display(safe.arm)} / ${display(safe.role)} source` }), metrics([
      ['Availability', availability(safe.availability)], ['Indexed files', safe.fileCount], ['Source policy', safe.sourcePolicy],
    ]));
  } else if (safe.kind === 'evidence') {
    contents.push(element('h3', { text: safe.name ?? 'Archived evidence' }), metrics([
      ['Evidence type', availability(safe.evidenceKind)], ['Bytes', safe.bytes],
    ]));
  } else contents.push(element('p', { className: 'muted', text: `Record: ${availability(safe.availability)}. See metadata for captured fields.` }));
  const buttons = audit ? [] : [
    item.kind === 'observation' && item.snapshotRef ? action('Compare observation', 'compare_trial', { snapshotRef: item.snapshotRef }) : null,
    item.unitRef && kind === 'compare_trial' ? action('Inspect unit', 'inspect_unit', { unitRef: item.unitRef }) : null,
    item.baselineUnitRef && kind === 'compare_trial' ? action('Inspect parent unit', 'inspect_unit', { unitRef: item.baselineUnitRef }) : null,
    item.evidenceRef ? action('Read evidence', 'read_evidence', { evidenceRef: item.evidenceRef, ...(kind === 'search_source' && Number.isFinite(item.offset) ? { offset: item.offset } : {}) }) : null,
    item.rawAnalysis?.evidenceRef ? action('Read analysis', 'read_evidence', { evidenceRef: item.rawAnalysis.evidenceRef }) : null,
  ].filter(Boolean);
  return element('article', { className: 'evidence-item', attributes: { 'data-live-key': JSON.stringify([kind, data.unitRef, item.id ?? item.unitRef ?? item.snapshotRef ?? item.evidenceRef, item.replicate]) } }, [
    ...contents, buttons.length ? element('div', { className: 'evidence-item-actions' }, buttons) : null, metadata(safe, audit ? 'Access receipt' : 'Record metadata'),
  ]);
}

// Controls and pagination belong to this mounted disclosure, not to the campaign poll.
export function evidenceExplorer(campaign, variant, audit = false) {
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}`;
  const name = audit ? 'Evidence access' : 'Explore evidence';
  const key = audit ? 'evidence-access' : 'evidence-explorer';
  return liveRegion(element('details', { className: key, attributes: { 'data-testid': key, 'data-live-key': `${variant.id}:${key}` } }, [
    element('summary', { text: name }),
  ]), (mounted) => {
    if (mountedPanels.has(mounted)) return;
    mountedPanels.add(mounted);
    let initialized = false;
    mounted.ontoggle = () => {
      if (!mounted.open || initialized) return;
      initialized = true;
      const observations = new Map();
      const sources = new Map();
      let pending = false;
      let next = null;
      let activeTool = 'list_observations';
      const tool = element('select', { attributes: { 'aria-label': 'Evidence tool' } }, tools.map(([value, label]) => option(value, label)));
      const observation = element('select', { attributes: { 'aria-label': 'Observation' } }, [option('', 'Choose a recorded observation')]);
      const reference = element('input', { attributes: { 'aria-label': 'Evidence reference', placeholder: 'Unit or evidence reference', autocomplete: 'off' } });
      const source = element('select', { attributes: { 'aria-label': 'Source scope' } }, [option('', 'Normal frozen source')]);
      const search = element('input', { attributes: { 'aria-label': 'Source search', placeholder: 'Literal source text', autocomplete: 'off' } });
      const field = (label, control) => element('label', {}, [element('span', { text: label }), control]);
      const observationField = field('Observation', observation);
      const referenceField = field('Evidence reference', reference);
      const sourceField = field('Source scope', source);
      const searchField = field('Source search', search);
      const result = element('div', { className: 'evidence-results', attributes: { 'aria-live': 'polite' } });
      const status = element('p', { className: 'muted', attributes: { role: 'status' } });
      const loadButton = element('button', { className: 'button button-outline', text: audit ? 'Refresh access' : 'Load evidence', attributes: { type: 'submit' } });
      const nextButton = element('button', { className: 'button button-outline', text: 'Next page', attributes: { type: 'button', disabled: true }, on: { click: () => load(activeTool, next) } });
      const fields = () => {
        observationField.hidden = tool.value !== 'compare_trial';
        referenceField.hidden = !['inspect_unit', 'read_evidence'].includes(tool.value);
        sourceField.hidden = searchField.hidden = tool.value !== 'search_source';
        reference.placeholder = tool.value === 'inspect_unit' ? 'unitRef from a comparison' : 'evidenceRef from an observation or unit';
      };
      tool.addEventListener('change', fields);
      const form = element('form', { className: 'evidence-controls' }, audit ? [loadButton] : [
        field('Evidence tool', tool), observationField, referenceField, sourceField, searchField, loadButton,
      ]);
      const navigateEvidence = (kind, query) => {
        tool.value = kind;
        if (query.unitRef || query.evidenceRef) reference.value = query.unitRef ?? query.evidenceRef;
        if (query.snapshotRef) observation.value = query.snapshotRef;
        fields();
        load(kind, query);
      };
      const load = async (kind, query) => {
        if (pending || !mounted.isConnected || !query) return;
        pending = true;
        loadButton.disabled = nextButton.disabled = true;
        status.textContent = audit ? 'Loading evidence access...' : 'Loading evidence...';
        try {
          const url = audit ? `${root}/evidence-reads${query.cursor ? `?cursor=${encodeURIComponent(query.cursor)}` : ''}`
            : `${root}/evidence?${new URLSearchParams({ tool: kind, query: JSON.stringify(query) })}`;
          const data = await api(url);
          if (!mounted.isConnected) return;
          activeTool = kind;
          const items = Array.isArray(data.items) ? data.items : [];
          if (!audit && kind === 'list_observations') {
            for (const item of items) {
              if (item.kind === 'observation' && item.snapshotRef && !observations.has(item.snapshotRef)) {
                observations.set(item.snapshotRef, item);
                observation.append(option(item.snapshotRef, [item.actionId ?? item.variantId, item.benchmark, item.arm].filter(Boolean).join(' / ') || item.snapshotRef));
              }
              if (item.kind === 'source' && item.sourceRef && !sources.has(item.sourceRef)) {
                sources.set(item.sourceRef, item);
                source.append(option(item.sourceRef, [item.arm, item.sourcePolicy, item.sourceRef].filter(Boolean).join(' / ')));
              }
            }
          }
          next = data.nextCursor ? { ...query, cursor: data.nextCursor }
            : !audit && kind === 'read_evidence' && Number.isFinite(data.nextOffset) ? { ...query, offset: data.nextOffset } : null;
          const content = element('div', { className: 'evidence-results', attributes: { 'aria-live': 'polite' } }, [
            !audit ? element('div', { className: 'evidence-envelope' }, [
              element('h3', { text: tools.find(([value]) => value === kind)?.[1] ?? kind }),
              element('p', { text: `${display(data.returnedCount)} returned / ${display(data.totalMatched)} ${data.offsetUnit === 'utf8_bytes' ? 'UTF-8 bytes' : 'matched'}. Availability: ${display(data.availability)}` }),
              data.unitKey ? element('h4', { text: data.unitKey }) : null,
              data.sourcePolicy ? element('p', { text: `Source policy: ${display(data.sourcePolicy)}` }) : null,
              kind === 'compare_trial' ? element('div', {}, [
                metrics([
                  ['Changed units', `${display(data.summary?.changedUnitCount)} / ${display(data.summary?.unitCount)}`],
                  ['Aggregate decision histogram', data.summary?.sameAggregateHistogram === true ? 'Unchanged' : data.summary?.sameAggregateHistogram === false ? 'Changed' : 'Unknown'],
                  ['Parent fixed-label agreement', percent(data.summary?.baselineMeanAgreement)], ['Trial fixed-label agreement', percent(data.summary?.trialMeanAgreement)],
                ]),
                element('p', { className: 'muted', text: 'Fixed-label agreement is diagnostic, not consensus stability or a promotion score. Suggested labels remain unverified; the same aggregate histogram can hide unit-level changes.' }),
              ]) : null,
              data.omissions?.length ? element('div', { className: 'evidence-omissions' }, [
                element('h3', { text: 'Omissions / availability limits' }),
                element('ul', {}, data.omissions.map((item) => element('li', { text: typeof item === 'string' ? item : `${String(item.reason ?? 'Unknown').replaceAll('_', ' ')}${Number.isFinite(item.count) ? ` (${item.count})` : ''}` }))),
              ]) : null,
              metadata(Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'items')), 'Snapshot and response metadata'),
            ]) : null,
            ...items.map((item) => evidenceItem(item, kind, data, audit, navigateEvidence)),
            !items.length ? element('p', { className: 'muted', text: audit ? 'No evidence reads recorded yet. Historical reads may not have been captured.' : 'No matching evidence in this page. Missing evidence is not a successful result.' }) : null,
          ]);
          updateLiveView(result, content);
          status.textContent = next ? 'More records available. Continue with Next page.' : 'End of this result.';
        } catch {
          if (mounted.isConnected) status.textContent = `${audit ? 'Evidence access' : 'Evidence'} unavailable. The request failed; any previous result remains below. Retry with ${audit ? 'Refresh access' : 'Load evidence'}.`;
        } finally {
          pending = false;
          loadButton.disabled = false;
          nextButton.disabled = !next;
        }
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        let query = {};
        if (tool.value === 'compare_trial') {
          if (!observation.value) { status.textContent = 'Choose an observation from List observations first.'; return; }
          query = { snapshotRef: observation.value };
        }
        if (['inspect_unit', 'read_evidence'].includes(tool.value)) {
          if (!reference.value.trim()) { status.textContent = 'Choose a unit or evidence reference from the returned records first.'; return; }
          query = { [tool.value === 'inspect_unit' ? 'unitRef' : 'evidenceRef']: reference.value.trim() };
        }
        if (tool.value === 'search_source') {
          if (!search.value.trim()) { status.textContent = 'Enter literal source text to search.'; return; }
          query = { query: search.value, ...(source.value ? { sourceRef: source.value } : {}) };
        }
        load(tool.value, query);
      });
      fields();
      mounted.append(element('div', { className: 'evidence-body' }, [
        element('p', { className: 'muted', text: audit
          ? 'Persisted evidence access: what the agent read, when, and how much. Request and response references are receipts, not raw chat. Older sessions may not have access records.'
          : 'Bounded, read-only archive exploration. Compare a recorded observation against its frozen parent, not the current campaign head. Evidence is not a correctness judgment; unknown fields stay unknown.' }),
        form, status, result, element('div', { className: 'evidence-pagination' }, [nextButton]),
      ]));
      load(activeTool, {});
    };
    if (mounted.open) mounted.ontoggle();
  });
}
