import { api } from './api.js';
import { element } from './dom.js';
import { ACTIVE_STATUSES } from './models.js';
import { navigate, parseRoute, startRouter } from './router.js';
import { renderShell } from './shell.js';
import { clearReviewDraft, hasDirtyDraft, state } from './state.js';
import { campaignsPage } from './pages/campaigns.js';
import { experimentPage, invalidateExperimentMarkdown } from './pages/experiment.js';
import { experimentsPage } from './pages/experiments.js';
import { lineagePage } from './pages/lineage.js';
import { newCampaignPage } from './pages/newCampaign.js';
import { overviewPage } from './pages/overview.js';
import { reviewPage } from './pages/review.js';

const REFRESH_VARIANT_STATUSES = new Set(ACTIVE_STATUSES);
let renderToken = 0;
let noticeTimer;

function notify(message) {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('visible'), 3_200);
}

async function copyText(value, label) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    notify(`${label[0].toUpperCase()}${label.slice(1)} copied`);
  } catch (error) {
    notify(error.message);
  }
}

function guardDirtyDraft() {
  if (!hasDirtyDraft()) return true;
  const discard = window.confirm('Discard the unsaved human-review draft?');
  if (discard) clearReviewDraft();
  return discard;
}

async function reloadCampaigns() {
  state.campaigns = await api('/api/campaigns');
}

async function loadCampaign(campaignId) {
  if (state.campaign?.id === campaignId) return;
  const details = await api(`/api/campaigns/${encodeURIComponent(campaignId)}`);
  state.campaign = {
    ...details.campaign,
    variants: details.variants,
    labels: details.labels,
    targetExcludedConfig: details.targetExcludedConfig,
    targetExcludedEvaluations: details.targetExcludedEvaluations,
    targetExcludedLabels: details.targetExcludedLabels,
  };
  state.eventCursor = details.eventCursor ?? 0;
  state.campaigns = state.campaigns.map((campaign) =>
    campaign.id === campaignId ? { ...state.campaign } : campaign,
  );
  connectEvents();
}

async function refreshCurrent() {
  if (!state.campaign) return;
  if (state.refreshRunning) {
    state.refreshQueued = true;
    return;
  }
  state.refreshRunning = true;
  try {
    const campaignId = state.campaign.id;
    const details = await api(`/api/campaigns/${encodeURIComponent(campaignId)}`);
    if (state.campaign?.id !== campaignId) return;
    state.campaign = {
      ...details.campaign,
      variants: details.variants,
      labels: details.labels,
      targetExcludedConfig: details.targetExcludedConfig,
      targetExcludedEvaluations: details.targetExcludedEvaluations,
      targetExcludedLabels: details.targetExcludedLabels,
    };
    state.eventCursor = details.eventCursor ?? state.eventCursor;
    state.campaigns = state.campaigns.map((campaign) =>
      campaign.id === campaignId ? { ...state.campaign } : campaign,
    );
    if (!hasDirtyDraft()) await renderCurrent();
  } catch (error) {
    notify(error.message);
  } finally {
    state.refreshRunning = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      queueMicrotask(refreshCurrent);
    }
  }
}

function connectEvents() {
  state.events?.close();
  if (!state.campaign) return;
  const source = new EventSource(
    `/api/campaigns/${encodeURIComponent(state.campaign.id)}/events?after=${state.eventCursor}`,
  );
  state.events = source;
  source.onopen = () => {
    state.connection = 'Live ledger';
    const value = document.querySelector('.connection-state span:last-child');
    if (value && !hasDirtyDraft()) value.textContent = state.connection;
  };
  source.onerror = () => {
    state.connection = 'Reconnecting';
    const value = document.querySelector('.connection-state span:last-child');
    if (value && !hasDirtyDraft()) value.textContent = state.connection;
  };
  for (const eventName of [
    'campaign.updated',
    'campaign.resumed',
    'variant.updated',
    'variant.created',
    'variant.promoted',
    'label.updated',
    'operation.failed',
    'campaign.operation_failed',
    'artifacts.collection_failed',
    'stack.teardown_failed',
    'target_excluded.configured',
    'target_excluded.created',
    'target_excluded.updated',
    'target_excluded.question_waiting',
    'target_excluded.label_updated',
  ]) source.addEventListener(eventName, refreshCurrent);
  source.addEventListener('reports.refreshed', () => {
    if (state.campaign) invalidateExperimentMarkdown(state.campaign.id);
    void refreshCurrent();
  });
}

async function runAction(action, message) {
  if (state.pendingAction || !guardDirtyDraft()) return;
  state.pendingAction = true;
  await renderCurrent();
  try {
    await action();
    notify(message);
    await refreshCurrent();
  } catch (error) {
    notify(error.message);
  } finally {
    state.pendingAction = false;
    await renderCurrent();
  }
}

function runCampaign() {
  const campaign = state.campaign;
  const stopped = campaign.status.startsWith('stopped');
  const baseline = campaign.variants.some(
    (variant) => variant.round === 0 && variant.status === 'completed',
  );
  const operation = stopped ? 'resume' : baseline ? 'round' : 'baseline';
  const message = stopped ? 'Campaign resumed' : baseline ? 'Experiment round admitted' : 'Baseline admitted';
  return runAction(
    () => api(`/api/campaigns/${encodeURIComponent(campaign.id)}/${operation}`, { method: 'POST', body: '{}' }),
    message,
  );
}

function stopCampaign() {
  return runAction(
    () => api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/stop`, { method: 'POST', body: '{}' }),
    'Stop requested',
  );
}

function promoteVariant(variantId) {
  return runAction(
    () => api(
      `/api/campaigns/${encodeURIComponent(state.campaign.id)}/promote/${encodeURIComponent(variantId)}`,
      { method: 'POST', body: '{}' },
    ),
    'Promotion admitted',
  );
}

function configureTargetExcluded(variantId, targetImplementationWorkflow) {
  return runAction(
    () => api(`/api/campaigns/${encodeURIComponent(state.campaign.id)}/target-excluded`, {
      method: 'POST',
      body: JSON.stringify({ baselineVariantId: variantId, targetImplementationWorkflow }),
    }),
    'Target-excluded protocol configured',
  );
}

function runTargetExcluded(variantId) {
  return runAction(
    () => api(
      `/api/campaigns/${encodeURIComponent(state.campaign.id)}/variants/${encodeURIComponent(variantId)}/target-excluded`,
      { method: 'POST', body: '{}' },
    ),
    'Target-excluded evaluation admitted',
  );
}

function answerTargetExcludedQuestion(variantId, questionId, answer, selectedOptionId) {
  return runAction(
    () => api(
      `/api/campaigns/${encodeURIComponent(state.campaign.id)}/variants/${encodeURIComponent(variantId)}/target-excluded/questions/${encodeURIComponent(questionId)}/answer`,
      {
        method: 'PUT',
        body: JSON.stringify({ answer, ...(selectedOptionId ? { selectedOptionId } : {}) }),
      },
    ),
    'Target-excluded question answered',
  );
}

const context = {
  state,
  navigate,
  notify,
  copyText,
  reloadCampaigns,
  refreshCurrent,
  render: () => renderCurrent(),
  runCampaign,
  stopCampaign,
  promoteVariant,
  configureTargetExcluded,
  runTargetExcluded,
  answerTargetExcludedQuestion,
};

function routeTitle(route) {
  const titles = {
    campaigns: 'Campaigns',
    'new-campaign': 'New campaign',
    overview: 'Overview',
    experiments: 'Experiments',
    lineage: 'Lineage',
    experiment: 'Experiment',
    review: 'Review',
  };
  return `${titles[route.name] ?? 'Not found'} · Planner Eval`;
}

async function renderCurrent() {
  const token = ++renderToken;
  const route = parseRoute();
  document.title = routeTitle(route);
  try {
    if (state.campaigns.length === 0) await reloadCampaigns();
    if (route.params.campaignId) await loadCampaign(route.params.campaignId);
    if (token !== renderToken) return;
    let content;
    if (route.name === 'campaigns') content = campaignsPage(context);
    else if (route.name === 'new-campaign') content = newCampaignPage(context);
    else if (route.name === 'overview') content = overviewPage(context);
    else if (route.name === 'experiments') content = experimentsPage(context, route);
    else if (route.name === 'lineage') content = lineagePage(context, route);
    else if (route.name === 'experiment') content = experimentPage(context, route);
    else if (route.name === 'review') content = reviewPage(context, route);
    else content = element('div', { className: 'empty-state' }, [
      element('h1', { text: 'Page not found' }),
      element('p', { text: 'This path is not part of the local evaluation console.' }),
    ]);
    renderShell({ state, route, content, navigate });
  } catch (error) {
    if (token !== renderToken) return;
    renderShell({
      state,
      route,
      navigate,
      content: element('div', { className: 'empty-state error-panel' }, [
        element('h1', { text: 'Unable to load this route' }),
        element('p', { text: error.message }),
      ]),
    });
  }
}

window.addEventListener('beforeunload', (event) => {
  if (!hasDirtyDraft()) return;
  event.preventDefault();
  event.returnValue = '';
});

setInterval(() => {
  if (
    state.campaign?.variants?.some((variant) => REFRESH_VARIANT_STATUSES.has(variant.status)) &&
    !state.refreshRunning
  ) refreshCurrent();
}, 2_000);

startRouter({ render: renderCurrent, allowNavigation: guardDirtyDraft });
