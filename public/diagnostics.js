import { api } from './api.js';
import { element } from './dom.js';
import { liveRegion, updateLiveView } from './live.js';
import { canRetryExcludedBaseline, executionHealth, langfuseUrlForCase } from './models.js';

// The server supplies normalized, sanitized records. Bound and redact again before display/copy;
// never copy a variant, raw logs, or arbitrary response fields as diagnostics.
export function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 7) return '[truncated]';
  if (typeof value === 'string') return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s;,]+|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}/gi, '[redacted]')
    .replace(/((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 65536);
  if (Array.isArray(value)) return value.slice(0, 125).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key.slice(0, 256), /authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential/i.test(key)
      ? '[redacted]' : sanitizeDiagnosticValue(item, depth + 1),
  ]));
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

function normalizedDiagnostics(value) {
  return sanitizeDiagnosticValue({
    status: value.status, counts: value.counts, standardAvailable: value.standardAvailable,
    failures: (value.failures ?? []).map((item) => ({
      scope: item.scope, benchmark: item.benchmark, replicate: item.replicate,
      caseId: item.caseId, runId: item.runId, progress: item.progress,
      failure: item.failure ? Object.fromEntries([
        'origin', 'code', 'message', 'occurredAt', 'failedRequirementUnitIds', 'lastCheckpointStage',
        'providerRetryBudgetAvailable', 'httpStatus', 'details', 'provenance',
      ].filter((key) => item.failure[key] !== undefined).map((key) => [key, item.failure[key]])) : null,
    })),
  });
}

const panels = new WeakMap();

export function failureBanner(campaign, variant, context) {
  const health = executionHealth(campaign, variant);
  if (health.status !== 'blocked') return null;
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}`;
  const version = JSON.stringify([variant.updatedAt, health, campaign.targetExcludedEvaluations?.find((item) => item.variantId === variant.id)?.updatedAt]);
  const identity = JSON.stringify(health.failures.map(({ scope, benchmark, replicate, caseId, runId }) => [scope, benchmark, replicate, caseId, runId]));
  const disclosure = liveRegion(element('details', { className: 'failure-diagnostics', attributes: { 'data-live-key': `${variant.id}:diagnostics` } }, [
    element('summary', { text: 'Failure diagnostics' }),
  ]), (mounted) => {
    let state = panels.get(mounted);
    if (!state) { state = { generation: 0, version: null, data: null }; panels.set(mounted, state); }
    const render = () => {
      const data = state.data ?? normalizedDiagnostics(health);
      const content = element('div', { className: 'diagnostic-content' }, [
        element('p', { className: 'muted', text: state.error ? 'Diagnostics unavailable. Snapshot evidence remains below; exact details may be absent from older records.'
          : state.loading ? 'Loading archived diagnostics...' : 'Normalized execution evidence. Missing values are unknown, not zero.' }),
        element('p', { className: 'mono', text: `Diagnostic status: ${data.status ?? 'unknown'} / ${data.counts?.completed ?? 'Unknown'} completed / ${data.counts?.total ?? 'Unknown'} total` }),
        ...data.failures.map((item) => {
          const failure = item.failure;
          const trace = langfuseUrlForCase(item.caseId);
          return element('section', { className: 'diagnostic-failure', attributes: { 'data-live-key': `${item.scope}:${item.benchmark}:${item.replicate}` } }, [
            element('h3', { text: `${item.scope} / ${item.benchmark} / replicate ${item.replicate}` }),
            element('p', { className: 'identifier', text: `Case: ${item.caseId ?? 'Unknown'} / Run: ${item.runId ?? 'Unknown'}` }),
            element('p', { text: item.progress ? `Last accepted progress: ${item.progress.completedUnits} / ${item.progress.totalUnits}` : 'Last accepted progress: Unknown' }),
            failure ? element('div', {}, [
              element('p', { className: 'diagnostic-code', text: `${failure.origin ?? 'Unknown origin'} / ${failure.code ?? 'Unknown code'}` }),
              element('p', { text: failure.message ?? 'Exact failure message was not recorded.' }),
              element('p', { text: `Failed requirement units: ${failure.failedRequirementUnitIds?.length ? failure.failedRequirementUnitIds.join(', ') : 'Unknown'}` }),
              element('p', { text: `Last checkpoint: ${failure.lastCheckpointStage ?? 'Unknown'} / HTTP status: ${failure.httpStatus ?? 'Unknown'}` }),
              element('p', { text: `Occurred: ${failure.occurredAt ?? 'Unknown'} / Provider retry budget: ${failure.providerRetryBudgetAvailable === true ? 'Available' : failure.providerRetryBudgetAvailable === false ? 'Unavailable' : 'Unknown'}` }),
              failure.details || failure.provenance ? element('details', {}, [
                element('summary', { text: 'Exact details and provenance (sanitized)' }),
                element('pre', { text: JSON.stringify({ details: failure.details, provenance: failure.provenance }, null, 2), attributes: { tabindex: '0' } }),
              ]) : element('p', { className: 'muted', text: 'Exact details and provenance were not captured in this record.' }),
            ]) : element('p', { className: 'muted', text: 'Exact failure details were not recorded. No error code or cause can be inferred.' }),
            trace ? element('a', { text: 'Failed run trace', attributes: { href: trace, target: '_blank', rel: 'noreferrer' } }) : null,
          ]);
        }),
        !data.failures.length ? element('p', { text: 'No per-run failure record is available. The evaluation remains blocked; inspect the archived evaluation.' }) : null,
        element('div', { className: 'diagnostic-actions' }, [
          element('button', { className: 'button button-outline', text: 'Copy diagnostics JSON', attributes: { type: 'button' },
            on: { click: () => context.copyText(JSON.stringify(data, null, 2), 'diagnostics JSON') } }),
          state.error ? element('button', { className: 'button button-outline', text: 'Reload diagnostics', attributes: { type: 'button' },
            on: { click: () => { state.version = null; load(); } } }) : null,
        ]),
      ]);
      if (mounted.children[1]) updateLiveView(mounted.children[1], content);
      else mounted.append(content);
    };
    const load = () => {
      if (!mounted.open || !mounted.isConnected) return;
      if (state.version === version) return;
      state.version = version;
      if (state.identity !== identity) state.data = null;
      state.identity = identity;
      const generation = ++state.generation;
      state.loading = true;
      state.error = false;
      render();
      api(`${root}/diagnostics`).then((value) => {
        if (!mounted.isConnected || generation !== state.generation) return;
        state.data = normalizedDiagnostics(value);
      }).catch(() => {
        if (generation === state.generation) state.error = true;
      }).finally(() => {
        if (!mounted.isConnected || generation !== state.generation) return;
        state.loading = false;
        render();
      });
    };
    mounted.ontoggle = load;
    load();
  });
  return element('section', { className: 'failure-banner', attributes: { 'data-testid': `failure-banner-${variant.id}`, 'data-live-key': `${variant.id}:failure-banner`, 'aria-label': `${variant.id} execution failure` } }, [
    element('div', { className: 'failure-banner-heading' }, [
      element('h2', { text: health.label }),
      element('span', { className: 'mono', text: `${health.counts.completed} completed / ${health.counts.total} total; ${health.counts.failed} failed; ${health.counts.pending} pending` }),
    ]),
    element('p', { text: health.standardAvailable ? 'Standard results remain available. This blocked evaluation does not establish promotion eligibility.' : 'Completed runs remain available individually. This evaluation is incomplete; no aggregate success is inferred.' }),
    element('a', { text: 'Inspect run matrix', attributes: { href: `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=runs`, 'data-route': '' } }),
    canRetryExcludedBaseline(campaign, variant) ? element('div', { className: 'diagnostic-retry' }, [
      element('p', { text: 'Retry replaces both excluded baseline runs, including any successful excluded sibling. Completed standard primary and holdout results are preserved.' }),
      element('button', { className: 'button button-secondary', text: 'Retry excluded baseline (2 runs)', attributes: { type: 'button', disabled: context.state.pendingAction },
        on: { click: () => context.retryExcludedBaseline(variant.id) } }),
    ]) : null,
    disclosure,
  ]);
}
