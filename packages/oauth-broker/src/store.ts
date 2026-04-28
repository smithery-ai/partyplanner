// Storage interface for the OAuth broker. Each backend provides its own
// implementation. The broker keeps three
// short-lived kinds of records:
//
//   - Pending: a `state` nonce → callback context. Created on /start, taken
//     on /callback. TTL ~5 min (matches typical user OAuth latency).
//   - Handoff: a one-time `handoff` code → resolved token + run context.
//     Created on /callback, taken on /exchange. TTL ~60 s.
//   - Refresh: long-lived `brokerSessionId` → refresh token. Used by /refresh
//     to rotate access tokens without exposing the refresh token to the
//     runtime. No TTL (provider eventually invalidates).

export type PendingValue = {
  providerId: string;
  // Standalone installs (no workflow context) leave these undefined; the
  // callback then redirects to a static "install complete" page instead of
  // the runtime handoff route.
  runtimeHandoffUrl?: string;
  runId?: string;
  interventionId?: string;
  scopes: string[];
  extra: Record<string, string>;
  // Identity of the runtime that started this flow (today: opaque "anonymous"
  // since auth is a single shared HYLO_API_KEY; will become orgId later).
  appId: string;
  createdAt: number;
};

export type HandoffValue = {
  providerId: string;
  runId?: string;
  interventionId?: string;
  // Provider-shaped token, ready to deliver to the runtime intervention.
  token: unknown;
  appId: string;
  createdAt: number;
};

export type RefreshValue = {
  providerId: string;
  refreshToken: string;
  appId: string;
  createdAt: number;
};

export type TokenIssuedValue = {
  providerId: string;
  pending: PendingValue;
  rawToken: unknown;
  token: unknown;
};

export interface BrokerStore {
  putPending(state: string, value: PendingValue): Promise<void>;
  // Delete-on-read so a state can only be used once.
  takePending(state: string): Promise<PendingValue | undefined>;

  putHandoff(handoff: string, value: HandoffValue): Promise<void>;
  // Delete-on-read so a handoff can only be exchanged once.
  takeHandoff(handoff: string): Promise<HandoffValue | undefined>;

  putRefresh(sessionId: string, value: RefreshValue): Promise<void>;
  getRefresh(sessionId: string): Promise<RefreshValue | undefined>;
  updateRefreshToken(sessionId: string, refreshToken: string): Promise<void>;
}

export type InMemoryBrokerStoreOptions = {
  pendingTtlMs?: number;
  handoffTtlMs?: number;
  // Called when removing expired entries; useful for tests.
  now?: () => number;
};

// Map-backed store with lazy TTL eviction. Suitable for single-process
// deployments and local dev. Production multi-instance backends should
// supply their own implementation backed by Postgres / DO storage.
export function createInMemoryBrokerStore(
  opts: InMemoryBrokerStoreOptions = {},
): BrokerStore {
  const pendingTtlMs = opts.pendingTtlMs ?? 5 * 60_000;
  const handoffTtlMs = opts.handoffTtlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, PendingValue>();
  const handoffs = new Map<string, HandoffValue>();
  const refresh = new Map<string, RefreshValue>();

  return {
    async putPending(state, value) {
      pending.set(state, value);
    },
    async takePending(state) {
      const value = pending.get(state);
      if (!value) return undefined;
      pending.delete(state);
      if (now() - value.createdAt > pendingTtlMs) return undefined;
      return value;
    },
    async putHandoff(handoff, value) {
      handoffs.set(handoff, value);
    },
    async takeHandoff(handoff) {
      const value = handoffs.get(handoff);
      if (!value) return undefined;
      handoffs.delete(handoff);
      if (now() - value.createdAt > handoffTtlMs) return undefined;
      return value;
    },
    async putRefresh(sessionId, value) {
      refresh.set(sessionId, value);
    },
    async getRefresh(sessionId) {
      return refresh.get(sessionId);
    },
    async updateRefreshToken(sessionId, refreshToken) {
      const existing = refresh.get(sessionId);
      if (!existing) return;
      refresh.set(sessionId, { ...existing, refreshToken });
    },
  };
}
