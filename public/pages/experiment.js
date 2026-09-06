import { api, apiText } from '../api.js';
import { element, formatNumber, formatPercent, statusLabel } from '../dom.js';
import { holdoutState, isPromotionEligible, scopedQuestions } from '../models.js';
import {
  experimentHeading,
  externalTraceLink,
  questionEntry,
  replicateTable,
  routeLink,
  scoreSummary,
  sectionHeading,
  usageSummary,
} from '../ui.js';
import { targetExcludedPanel } from './targetExcluded.js';

const tabs = [
  ['summary', 'Summary'],
  ['markdown', 'Markdown'],
  ['runs', 'Runs'],
  ['questions', 'Questions'],
  ['target-excluded', 'Target excluded'],
  ['artifacts', 'Artifacts'],
];

const markdownCache = new Map();
const markdownViewState = new Map();
const reportedMarkdownFailures = new Set();
const appliedMarkdownHashes = new Map();

export function invalidateExperimentMarkdown(campaignId) {
  const prefix = `/api/campaigns/${encodeURIComponent(campaignId)}/`;
  for (const key of markdownCache.keys()) {
    if (key.startsWith(prefix)) markdownCache.delete(key);
  }
  for (const key of reportedMarkdownFailures) {
    if (key.startsWith(prefix)) reportedMarkdownFailures.delete(key);
  }
}

function loadExperimentMarkdown(reportUrl) {
  const cached = markdownCache.get(reportUrl);
  if (cached) return cached;
  const request = apiText(reportUrl);
  markdownCache.set(reportUrl, request);
  return request;
}

function scrollToMarkdownHeading(content, heading, behavior) {
  const top = heading.getBoundingClientRect().top
    - content.getBoundingClientRect().top
    + content.scrollTop
    - 14;
  content.scrollTo({ top, behavior });
}

function renderMarkdownContents(content, navigationLinks, html, focusedTarget, reportKey) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  content.replaceChildren(...parsed.body.childNodes);
  const headings = [...content.querySelectorAll('[data-markdown-level="1"], [data-markdown-level="2"], [data-markdown-level="3"]')];
  for (const heading of headings) heading.setAttribute('tabindex', '-1');
  const links = headings.map((heading) => {
    const level = heading.getAttribute('data-markdown-level') ?? '1';
    return element('a', {
      className: `markdown-toc-link markdown-toc-level-${level}`,
      text: heading.textContent,
      attributes: { href: `#${heading.id}` },
      on: {
        click: (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          const hash = `#${heading.id}`;
          if (location.hash !== hash) {
            history.pushState(history.state, '', `${location.pathname}${location.search}${hash}`);
          }
          appliedMarkdownHashes.set(reportKey, hash);
          heading.focus({ preventScroll: true });
          scrollToMarkdownHeading(
            content,
            heading,
            matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          );
        },
      },
    });
  });
  navigationLinks.replaceChildren(...links);
  const updateActiveSection = () => {
    const contentTop = content.getBoundingClientRect().top;
    let active = 0;
    for (const [index, heading] of headings.entries()) {
      if (heading.getBoundingClientRect().top - contentTop <= 28) active = index;
    }
    for (const [index, link] of links.entries()) {
      link.classList.toggle('active', index === active);
      if (index === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    const activeLink = links[active];
    const navigation = navigationLinks.parentElement;
    if (activeLink && navigation) {
      const linkBox = activeLink.getBoundingClientRect();
      const navigationBox = navigation.getBoundingClientRect();
      if (linkBox.top < navigationBox.top) navigation.scrollTop -= navigationBox.top - linkBox.top;
      else if (linkBox.bottom > navigationBox.bottom) {
        navigation.scrollTop += linkBox.bottom - navigationBox.bottom;
      }
    }
  };
  content.addEventListener('scroll', updateActiveSection, { passive: true });
  updateActiveSection();
  const hashHeading = headings.find((heading) => `#${heading.id}` === location.hash);
  const useHashNavigation = Boolean(
    hashHeading && appliedMarkdownHashes.get(reportKey) !== location.hash,
  );
  if (hashHeading && useHashNavigation) {
    appliedMarkdownHashes.set(reportKey, location.hash);
    queueMicrotask(() => {
      hashHeading.focus({ preventScroll: true });
      scrollToMarkdownHeading(content, hashHeading, 'auto');
    });
  }
  if (focusedTarget.tocHref || focusedTarget.contentHref || focusedTarget.headingId) {
    queueMicrotask(() => {
      if (focusedTarget.tocHref) {
        links.find((link) => link.getAttribute('href') === focusedTarget.tocHref)?.focus();
      } else if (focusedTarget.contentHref) {
        [...content.querySelectorAll('a')]
          .filter((link) => link.getAttribute('href') === focusedTarget.contentHref)
          [focusedTarget.contentOccurrence]
          ?.focus();
      } else if (focusedTarget.headingId) {
        headings.find((heading) => heading.id === focusedTarget.headingId)?.focus();
      }
    });
  }
  return useHashNavigation;
}

function markdownPanel(campaign, variant, context) {
  const reportUrl = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}/report`;
  const renderedUrl = `${reportUrl}?format=html`;
  const previous = document.querySelector('.experiment-markdown');
  const previousIsSameReport = previous?.getAttribute('data-report-url') === renderedUrl;
  const restoreFocus = previousIsSameReport && document.activeElement === previous;
  const activeElement = document.activeElement;
  const focusedTocHref = previousIsSameReport
    ? document.querySelector('.markdown-toc a:focus')?.getAttribute('href')
    : null;
  const focusedContentHref = previousIsSameReport && activeElement?.closest('.markdown-body')
    ? activeElement.getAttribute('href')
    : null;
  const focusedContentOccurrence = focusedContentHref
    ? [...previous.querySelectorAll('a')]
      .filter((link) => link.getAttribute('href') === focusedContentHref)
      .indexOf(activeElement)
    : -1;
  const focusedHeadingId = previousIsSameReport && activeElement?.matches('[data-markdown-level]')
    ? activeElement.id
    : null;
  const restoreRawFocus = previousIsSameReport && activeElement?.classList.contains('markdown-raw-link');
  if (previousIsSameReport && previous.getAttribute('aria-busy') !== 'true') {
    markdownViewState.set(renderedUrl, {
      scrollTop: previous.scrollTop,
    });
  } else if (reportedMarkdownFailures.has(renderedUrl)) {
    markdownCache.delete(renderedUrl);
    reportedMarkdownFailures.delete(renderedUrl);
  }
  const viewState = markdownViewState.get(renderedUrl) ?? { scrollTop: 0 };
  const content = element('article', {
    className: 'experiment-markdown markdown-body',
    attributes: {
      'aria-busy': 'true',
      'aria-label': 'Rendered experiment Markdown',
      'data-report-url': renderedUrl,
      'data-testid': 'experiment-markdown',
      tabindex: '0',
    },
    on: {
      scroll: () => markdownViewState.set(renderedUrl, {
        scrollTop: content.scrollTop,
      }),
    },
  }, [element('p', { className: 'muted', text: 'Loading experiment Markdown…' })]);
  const navigationLinks = element('div', { className: 'markdown-toc-links' }, [
    element('p', { className: 'muted', text: 'Loading sections…' }),
  ]);
  const navigation = element('nav', {
    className: 'markdown-toc',
    attributes: { 'aria-label': 'On this page' },
  }, [element('p', { className: 'overline', text: 'On this page' }), navigationLinks]);
  const restoreViewState = () => {
    content.scrollTop = viewState.scrollTop;
    if (restoreFocus) content.focus({ preventScroll: true });
  };
  queueMicrotask(restoreViewState);
  const markdownRequest = loadExperimentMarkdown(renderedUrl);
  markdownRequest
    .then((html) => {
      const usedHashNavigation = renderMarkdownContents(content, navigationLinks, html, {
        tocHref: focusedTocHref,
        contentHref: focusedContentHref,
        contentOccurrence: focusedContentOccurrence,
        headingId: focusedHeadingId,
      }, renderedUrl);
      content.setAttribute('aria-busy', 'false');
      if (!usedHashNavigation) {
        restoreViewState();
        requestAnimationFrame(restoreViewState);
      }
    })
    .catch((error) => {
      if (markdownCache.get(renderedUrl) !== markdownRequest) return;
      markdownCache.delete(renderedUrl);
      const message = 'Experiment Markdown is unavailable.';
      content.replaceChildren(element('code', { className: 'error-text', text: message }));
      content.setAttribute('aria-busy', 'false');
      navigationLinks.replaceChildren();
      if (!reportedMarkdownFailures.has(renderedUrl)) {
        reportedMarkdownFailures.add(renderedUrl);
        context.notify(`${message} ${error.message}`);
      }
    });
  const rawLink = element('a', {
    className: 'button button-outline markdown-raw-link',
    text: 'Open raw Markdown',
    attributes: { href: reportUrl, target: '_blank', rel: 'noreferrer' },
  });
  if (restoreRawFocus) queueMicrotask(() => rawLink.focus());
  return element('section', { className: 'markdown-panel' }, [
    sectionHeading(
      'Research record',
      'Experiment Markdown',
      'Assumptions and model interpretations remain labeled separately from measured and human-verified evidence.',
    ),
    element('div', { className: 'artifact-toolbar' }, [rawLink]),
    element('div', { className: 'markdown-layout' }, [navigation, content]),
  ]);
}

function tabNavigation(campaign, variant, current, questionCount) {
  return element('nav', { className: 'tabs', attributes: { 'aria-label': 'Experiment detail sections' } },
    tabs.map(([tab, label]) => {
      const link = routeLink(
        tab === 'questions' ? `${label} (${questionCount})` : label,
        `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=${tab}`,
        current === tab ? 'active' : '',
      );
      if (current === tab) link.setAttribute('aria-current', 'page');
      return link;
    }),
  );
}

function summaryPanel(campaign, variant) {
  const relationship = element('dl', { className: 'definition-list' }, [
    element('div', {}, [element('dt', { text: 'Lifecycle' }), element('dd', {}, [statusLabel(variant.status)])]),
    element('div', {}, [element('dt', { text: 'Parent' }), element('dd', {}, [
      variant.parentVariantId
        ? routeLink(variant.parentVariantId, `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.parentVariantId)}`)
        : document.createTextNode('Frozen seed'),
    ])]),
    element('div', {}, [element('dt', { text: 'Current campaign head' }), element('dd', { text: variant.id === campaign.currentParentVariantId ? 'Yes' : 'No' })]),
    element('div', {}, [element('dt', { text: 'Holdout' }), element('dd', { text: holdoutState(campaign, variant, campaign.variants) })]),
    element('div', {}, [element('dt', { text: 'Artifact collection' }), element('dd', { text: variant.artifactCollectionComplete ? 'Complete' : 'Incomplete' })]),
    element('div', {}, [element('dt', { text: 'Replicate sample' }), element('dd', { text: formatNumber(variant.facts?.sampleSize) })]),
  ]);
  return element('div', { className: 'summary-grid' }, [
    element('section', {}, [sectionHeading('Rubric', 'Accuracy and agreement'), scoreSummary(variant)]),
    element('section', {}, [sectionHeading('Telemetry', 'End-to-end and planner-only'), usageSummary(campaign, variant)]),
    element('section', { className: 'summary-wide' }, [sectionHeading('Provenance', 'Experiment position'), relationship]),
    variant.error
      ? element('section', { className: 'error-panel summary-wide' }, [element('h2', { text: 'Recorded failure' }), element('p', { text: variant.error })])
      : null,
  ]);
}

function questionsPanel(variant) {
  const questions = scopedQuestions(variant);
  if (!questions.length) {
    return element('div', { className: 'empty-state compact' }, [
      element('h2', { text: 'No planner questions' }),
      element('p', { text: 'No questions were sent to the harness for any benchmark replicate.' }),
    ]);
  }
  return element('div', { className: 'question-list' }, questions.map(questionEntry));
}

function artifactsPanel(campaign, variant, context) {
  const target = element('div', { className: 'artifact-content' }, [
    element('p', { className: 'muted', text: 'Loading experiment archive…' }),
  ]);
  const root = `/api/campaigns/${encodeURIComponent(campaign.id)}/variants/${encodeURIComponent(variant.id)}`;
  api(`${root}/artifacts`)
    .then((artifacts) => {
      const files = artifacts.files.map((file) =>
        element('a', {
          attributes: {
            href: `${root}/artifacts?path=${encodeURIComponent(file.path)}`,
            target: '_blank',
            rel: 'noreferrer',
          },
        }, [element('span', { text: file.path }), element('small', { text: `${Math.ceil(file.size / 1024)} KiB` })]),
      );
      target.replaceChildren(
        element('div', { className: 'artifact-toolbar' }, [
          element('a', {
            className: 'button button-outline',
            text: 'Open experiment Markdown',
            attributes: { href: artifacts.reportUrl, target: '_blank', rel: 'noreferrer' },
          }),
        ]),
        element('div', { className: 'artifact-list' }, files.length ? files : [element('p', { text: 'No raw artifacts have been written yet.' })]),
      );
    })
    .catch((error) => {
      target.replaceChildren(element('p', { className: 'error-text', text: error.message }));
      context.notify(error.message);
    });
  return target;
}

export function experimentPage(context, route) {
  const campaign = context.state.campaign;
  const variant = campaign.variants.find((candidate) => candidate.id === route.params.variantId);
  if (!variant) return element('div', { className: 'empty-state', text: 'Experiment not found in this campaign.' });
  const selectedTab = tabs.some(([name]) => name === route.query.get('tab')) ? route.query.get('tab') : 'summary';
  const primary = campaign.config.benchmarks.find((benchmark) => benchmark.role === 'primary');
  const actions = [
    externalTraceLink(variant),
    routeLink(
      'Review requirements',
      `/campaigns/${encodeURIComponent(campaign.id)}/review/${encodeURIComponent(variant.id)}?benchmark=${encodeURIComponent(primary?.name ?? '')}&filter=all`,
      'button button-secondary',
    ),
  ].filter(Boolean);
  if (isPromotionEligible(campaign, campaign.variants, variant)) {
    actions.push(element('button', {
      className: 'button button-primary',
      text: 'Promote experiment',
      attributes: { type: 'button', disabled: context.state.pendingAction },
      on: { click: () => context.promoteVariant(variant.id) },
    }));
  }
  const questionCount = scopedQuestions(variant).length;
  const panel = selectedTab === 'runs'
    ? element('section', {}, [
        sectionHeading('Replicates', 'Configured run matrix', 'Planner totals count each primary and holdout execution exactly once.'),
        usageSummary(campaign, variant),
        replicateTable(campaign, variant),
      ])
    : selectedTab === 'markdown'
      ? markdownPanel(campaign, variant, context)
      : selectedTab === 'questions'
      ? questionsPanel(variant)
      : selectedTab === 'target-excluded'
        ? targetExcludedPanel(context, campaign, variant)
      : selectedTab === 'artifacts'
        ? artifactsPanel(campaign, variant, context)
        : summaryPanel(campaign, variant);
  return element('div', { className: 'page' }, [
    experimentHeading(campaign, variant, context, actions),
    tabNavigation(campaign, variant, selectedTab, questionCount),
    element('div', { className: 'tab-panel' }, [panel]),
  ]);
}
