import { element, titleCase } from '../dom.js';
import { pageHeading, routeLink } from '../ui.js';

export function campaignsPage(context) {
  const { campaigns } = context.state;
  const list = element('div', { className: 'campaign-list' });
  for (const campaign of campaigns) {
    list.append(
      element('article', { className: 'campaign-row' }, [
        element('div', {}, [
          routeLink(
            campaign.id,
            `/campaigns/${encodeURIComponent(campaign.id)}/overview`,
            'campaign-row-title',
          ),
          element('p', { text: campaign.config.goal }),
        ]),
        element('dl', {}, [
          element('div', {}, [element('dt', { text: 'Status' }), element('dd', { text: titleCase(campaign.status) })]),
          element('div', {}, [element('dt', { text: 'Experiments' }), element('dd', { text: campaign.variants?.length ?? 0 })]),
          element('div', {}, [element('dt', { text: 'Updated' }), element('dd', { text: new Date(campaign.updatedAt).toLocaleString() })]),
        ]),
      ]),
    );
  }
  if (!campaigns.length) {
    list.append(
      element('div', { className: 'empty-state' }, [
        element('h2', { text: 'No frozen campaigns' }),
        element('p', { text: 'Create a campaign to pin the planner, source, packs, model, and execution limits.' }),
        routeLink('Create campaign', '/campaigns/new', 'button button-primary'),
      ]),
    );
  }
  return element('div', { className: 'page' }, [
    pageHeading(
      'Local archive',
      'Evaluation campaigns',
      'Durable experiment state from this coordinator.',
      campaigns.length ? [routeLink('Create campaign', '/campaigns/new', 'button button-primary')] : [],
    ),
    list,
  ]);
}
