import { api } from "./client";

export type WebhookState = "active" | "paused" | "disabled";
export type WebhookDeliveryState = "queued" | "leased" | "delivered" | "failed" | "dropped";

export interface WebhookSubscription {
  id: number;
  label: string;
  destination: string;
  eventTypes: string[];
  radioIds: number[] | null;
  includeSensitive: boolean;
  state: WebhookState;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookInput {
  label: string;
  destination: string;
  eventTypes: string[];
  radioIds: number[] | null;
  includeSensitive: boolean;
  confirmSensitive?: true;
}

export interface WebhookDeliveryFailure {
  state: WebhookDeliveryState;
  attemptCount: number;
  responseStatus: number | null;
  responseClass: string | null;
  errorSummary: string | null;
}

export function safeDeliveryFailure(value: Record<string, unknown>): WebhookDeliveryFailure {
  return {
    state: value.state as WebhookDeliveryState,
    attemptCount: typeof value.attemptCount === "number" ? value.attemptCount : 0,
    responseStatus: typeof value.responseStatus === "number" ? value.responseStatus : null,
    responseClass: typeof value.responseClass === "string" ? value.responseClass : null,
    errorSummary: typeof value.errorSummary === "string" ? value.errorSummary : null,
  };
}

export const webhookApi = {
  list: () => api<{ subscriptions: WebhookSubscription[] }>("/webhooks"),
  eventCatalog: () => api<{ eventTypes: string[] }>("/event-catalog"),
  create: (input: WebhookInput) =>
    api<{ subscription: WebhookSubscription; signingSecret: string }>("/webhooks", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: number, input: Partial<WebhookInput> & { state?: "active" | "paused" }) =>
    api<{ subscription: WebhookSubscription }>(`/webhooks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  remove: (id: number) => api<{ ok: true }>(`/webhooks/${id}`, { method: "DELETE" }),
  rotate: (id: number) => api<{ signingSecret: string }>(`/webhooks/${id}/rotate-secret`, { method: "POST" }),
  test: (id: number) => api<{ accepted: true }>(`/webhooks/${id}/test`, { method: "POST" }),
  deliveries: async (id: number, state?: WebhookDeliveryState) => {
    const query = state ? `?state=${encodeURIComponent(state)}` : "";
    const { deliveries } = await api<{ deliveries: Record<string, unknown>[] }>(`/webhooks/${id}/deliveries${query}`);
    return deliveries.map(safeDeliveryFailure);
  },
};
