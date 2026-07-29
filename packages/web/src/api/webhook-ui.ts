export interface WebhookSaveState {
  includeSensitive: boolean;
  confirmSensitive: boolean;
  eventTypes: string[];
}

/** Form-level guard; the server performs the authoritative validation too. */
export function canSaveWebhook(state: WebhookSaveState): boolean {
  return state.eventTypes.length > 0 && (!state.includeSensitive || state.confirmSensitive);
}

/** A signing secret must leave reactive view state as soon as copying succeeds. */
export function dismissCopiedSecret(_secret: string): null {
  return null;
}
