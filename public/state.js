export const state = {
  campaigns: [],
  campaign: null,
  events: null,
  eventCursor: 0,
  connection: 'Local archive',
  pendingAction: false,
  refreshRunning: false,
  refreshQueued: false,
  reviewDraft: null,
};

export function setReviewDraft(input) {
  state.reviewDraft = { ...input, dirty: true };
}

export function clearReviewDraft() {
  state.reviewDraft = null;
}

export function hasDirtyDraft() {
  return Boolean(state.reviewDraft?.dirty);
}
