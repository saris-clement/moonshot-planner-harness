import { element, option } from './dom.js';
import { routeLink } from './ui.js';

function campaignNavigation(campaign, route) {
  if (!campaign) return element('nav', { className: 'sidebar-nav', attributes: { 'aria-label': 'Primary navigation' } }, [
    routeLink('Campaigns', '/', route.name === 'campaigns' ? 'active' : ''),
  ]);
  const reviewVariant = campaign.variants?.find((variant) => variant.id === campaign.currentParentVariantId) ??
    [...(campaign.variants ?? [])].reverse().find((variant) => variant.facts);
  const items = [
    ['overview', 'Overview', `/campaigns/${encodeURIComponent(campaign.id)}/overview`],
    ['experiments', 'Experiments', `/campaigns/${encodeURIComponent(campaign.id)}/experiments`],
    ['lineage', 'Lineage', `/campaigns/${encodeURIComponent(campaign.id)}/lineage`],
    ...(reviewVariant
      ? [['review', 'Review', `/campaigns/${encodeURIComponent(campaign.id)}/review/${encodeURIComponent(reviewVariant.id)}`]]
      : []),
  ];
  return element('nav', { className: 'sidebar-nav', attributes: { 'aria-label': 'Campaign navigation' } }, [
    element('p', { className: 'nav-label', text: 'Workspace' }),
    ...items.map(([name, label, href]) =>
      routeLink(
        label,
        href,
        route.name === name || (name === 'experiments' && route.name === 'experiment') ? 'active' : '',
      ),
    ),
    element('p', { className: 'nav-label nav-label-secondary', text: 'Campaign' }),
    routeLink('All campaigns', '/', route.name === 'campaigns' ? 'active' : ''),
    routeLink('New campaign', '/campaigns/new', route.name === 'new-campaign' ? 'active' : ''),
  ]);
}

export function renderShell({ state, route, content, navigate }) {
  const campaign = state.campaign?.id === route.params.campaignId ? state.campaign : null;
  const collapsed = localStorage.getItem('planner-sidebar-collapsed') === 'true';
  const app = element('div', { className: `app-shell${collapsed ? ' sidebar-collapsed' : ''}` });
  const mobileToggle = element('button', {
    className: 'icon-button mobile-menu-button',
    text: 'Menu',
    attributes: { type: 'button', 'aria-label': 'Open navigation', 'aria-expanded': 'false' },
  });
  const campaignSelect = element('select', {
    attributes: { 'aria-label': 'Campaign' },
    on: {
      change: (event) => {
        const moved = navigate(`/campaigns/${encodeURIComponent(event.target.value)}/overview`);
        if (!moved) event.target.value = campaign?.id ?? '';
      },
    },
  });
  if (state.campaigns.length) {
    for (const item of state.campaigns) {
      campaignSelect.append(option(item.id, item.id, item.id === campaign?.id));
    }
  } else {
    campaignSelect.append(option('', 'No campaigns', true));
    campaignSelect.disabled = true;
  }
  const header = element('header', { className: 'topbar' }, [
    mobileToggle,
    routeLink('PE', '/', 'brand-mark'),
    element('div', { className: 'campaign-switcher' }, [
      element('label', { text: 'Campaign', attributes: { for: 'shell-campaign-select' } }),
      campaignSelect,
    ]),
    element('div', { className: 'topbar-spacer' }),
    element('div', { className: 'connection-state' }, [
      element('span', { className: 'connection-dot' }),
      element('span', { text: state.reviewDraft?.dirty ? 'Review draft open' : state.connection }),
    ]),
    routeLink('New campaign', '/campaigns/new', 'button button-secondary topbar-new'),
  ]);
  campaignSelect.id = 'shell-campaign-select';

  const sidebar = element('aside', { className: 'sidebar', attributes: { id: 'application-sidebar' } }, [
    element('div', { className: 'sidebar-title' }, [
      element('div', {}, [element('strong', { text: 'Planner Eval' }), element('span', { text: 'Research console' })]),
      element('button', {
        className: 'icon-button collapse-button',
        text: collapsed ? '›' : '‹',
        attributes: { type: 'button', 'aria-label': collapsed ? 'Expand sidebar' : 'Collapse sidebar' },
        on: {
          click: () => {
            const next = !app.classList.contains('sidebar-collapsed');
            app.classList.toggle('sidebar-collapsed', next);
            localStorage.setItem('planner-sidebar-collapsed', String(next));
          },
        },
      }),
    ]),
    campaignNavigation(campaign, route),
    element('p', { className: 'sidebar-foot', text: 'Local · immutable inputs' }),
  ]);
  const scrim = element('button', {
    className: 'drawer-scrim',
    text: 'Close navigation',
    attributes: { type: 'button', 'aria-label': 'Close navigation' },
  });
  const closeDrawer = () => {
    app.classList.remove('drawer-open');
    mobileToggle.setAttribute('aria-expanded', 'false');
  };
  mobileToggle.addEventListener('click', () => {
    const open = app.classList.toggle('drawer-open');
    mobileToggle.setAttribute('aria-expanded', String(open));
    if (open) sidebar.querySelector('a')?.focus();
  });
  scrim.addEventListener('click', closeDrawer);
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeDrawer();
  });
  app.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !app.classList.contains('drawer-open')) return;
    closeDrawer();
    mobileToggle.focus();
  });
  const contentClass = route.name === 'review' ? 'content content-review' : 'content';
  app.append(header, sidebar, scrim, element('main', { className: contentClass }, [content]));
  document.querySelector('#app').replaceChildren(app);
}
