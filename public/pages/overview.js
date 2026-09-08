import { element } from '../dom.js';
import { ACTIVE_STATUSES, primaryScreening } from '../models.js';
import { investigationStatus } from '../investigation.js';
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
  const investigations = variants.filter((variant) => variant.investigation);
  const investigator = element('section', { className: 'section investigator-overview' }, [
    sectionHeading('Agent research', 'Autonomous investigator', 'Session budgets cover investigator work, not planner usage. Test passes are not correctness judgments.'),
    ...investigations.map((variant) => element('article', { className: 'investigator-row', attributes: { 'data-live-key': `${variant.id}:investigator` } }, [
      routeLink(variant.hypothesis.title, `/campaigns/${encodeURIComponent(campaign.id)}/experiments/${encodeURIComponent(variant.id)}?tab=investigation`, 'active-variant-title'),
      investigationStatus(campaign, variant),
    ])),
    !investigations.length ? element('p', { className: 'empty-row', text: campaign.config.investigator?.enabled
      ? 'Enabled. No investigator sessions recorded yet; the baseline remains a separate evaluation.'
      : 'Not enabled for this campaign. Existing planner evaluation behavior is unchanged.' }) : null,
  ]);
  const runtime = element('section', { className: 'section active-evaluations', attributes: { 'aria-live': 'polite' } }, [
    sectionHeading(
      'Runtime',
      'Active variant matrices',
      'Replicate slots follow the current phase: primary screening or final cohorts. Live decisions are the latest accepted checkpoint, not consensus.',
    ),
  ]);
  if (!active.length) {
    runtime.append(element('div', { className: 'empty-row', text: 'No active evaluations. Completed experiments remain in the ledger.' }));
  }
  for (const variant of active) {
    const screening = primaryScreening(campaign, variant);
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
        screening.active ? element('p', { className: 'muted', text: `Full-primary screening: ${screening.replicateCount} ${screening.countSource} replicate(s). Planner usage below belongs to the latest trial, not the final cohorts.` }) : null,
        replicateTable(campaign, variant, { includeTargetExcluded: true }),
      ]),
    );
  }
  return element('div', { className: 'page' }, [
    campaignHeading(campaign, context, campaignActions(campaign, context)),
    frozenMetadata(campaign),
    investigator,
    runtime,
  ]);
}
