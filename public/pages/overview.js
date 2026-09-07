import { element } from '../dom.js';
import { ACTIVE_STATUSES } from '../models.js';
import {
  campaignActions,
  campaignHeading,
  frozenMetadata,
  replicateTable,
  routeLink,
  sectionHeading,
  usageSummary,
} from '../ui.js';

export function overviewPage(context) {
  const campaign = context.state.campaign;
  const variants = campaign.variants ?? [];
  const active = variants.filter((variant) => ACTIVE_STATUSES.has(variant.status));
  const runtime = element('section', { className: 'section active-evaluations', attributes: { 'aria-live': 'polite' } }, [
    sectionHeading(
      'Runtime',
      'Active variant matrices',
      'Every configured benchmark and replicate remains visible. Live decisions are the latest accepted checkpoint, not consensus.',
    ),
  ]);
  if (!active.length) {
    runtime.append(element('div', { className: 'empty-row', text: 'No active evaluations. Completed experiments remain in the ledger.' }));
  }
  for (const variant of active) {
    runtime.append(
      element('article', { className: 'active-variant', attributes: { 'data-testid': `active-variant-${variant.id}` } }, [
        element('div', { className: 'active-variant-heading' }, [
          element('div', {}, [
            routeLink(
              variant.hypothesis.title,
              `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=runs`,
              'active-variant-title',
            ),
            element('p', { className: 'identifier', text: `${variant.id} · round ${variant.round}` }),
          ]),
          usageSummary(campaign, variant),
        ]),
        replicateTable(campaign, variant, { includeTargetExcluded: true }),
      ]),
    );
  }
  return element('div', { className: 'page' }, [
    campaignHeading(campaign, context, campaignActions(campaign, context)),
    frozenMetadata(campaign),
    runtime,
  ]);
}
