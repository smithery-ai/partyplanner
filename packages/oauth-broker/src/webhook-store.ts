// Storage interface for webhook subscriptions. Each backend (D1, PGlite, etc.)
// provides its own implementation. A subscription maps an external webhook
// provider to a specific workflow deployment and input.

export type WebhookSubscription = {
  id: string;
  tenantId: string;
  providerId: string;
  deploymentId: string;
  inputId: string;
  // Filter to specific event types (e.g. ["message", "reaction_added"]).
  // Null means all events are forwarded.
  eventTypes: string[] | null;
  // Provider-specific configuration (e.g. channel filter, repo filter).
  config: Record<string, unknown>;
  // "create_run" starts a new workflow run per event (default).
  // "submit_to_run" is reserved for future use (e.g. submitting to a
  // long-running run that's waiting for an input).
  mode: "create_run" | "submit_to_run";
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
};

export interface WebhookSubscriptionStore {
  create(subscription: WebhookSubscription): Promise<void>;
  get(id: string): Promise<WebhookSubscription | undefined>;
  list(tenantId?: string): Promise<WebhookSubscription[]>;
  delete(id: string): Promise<void>;
}

export function createInMemoryWebhookSubscriptionStore(): WebhookSubscriptionStore {
  const subscriptions = new Map<string, WebhookSubscription>();

  return {
    async create(subscription) {
      subscriptions.set(subscription.id, subscription);
    },
    async get(id) {
      return subscriptions.get(id);
    },
    async list(tenantId) {
      const all = Array.from(subscriptions.values());
      if (tenantId) return all.filter((s) => s.tenantId === tenantId);
      return all;
    },
    async delete(id) {
      subscriptions.delete(id);
    },
  };
}
