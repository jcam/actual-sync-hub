import type {
  ActualAccountDto,
  ActualBankSyncLinkDto,
  CommitMigrationPayload,
  ConnectionReauthSessionDto,
  ConnectionDto,
  MigrationPreviewDto,
  Provider,
  ProviderConnectResult,
  ProviderSettingsByProviderDto,
  RuntimeInfoDto,
  SaltEdgeConnectSessionDto,
  SessionDto,
  SyncRunDto,
  TellerConnectConfigDto,
  UpsertHomeValueConnectionPayload,
  UpdateAccountLinkPayload
} from "@actual-sync/shared";
import { ApiError } from "./lib/errors";

async function request<T>(input: RequestInfo, init?: RequestInit) {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers = new Headers(init?.headers);
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(input, {
    credentials: "include",
    headers,
    ...init
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(payload.error || `Request failed with status ${response.status}`, response.status, {
      issues: Array.isArray(payload.issues) ? payload.issues : undefined
    });
  }

  return response.json() as Promise<T>;
}

type ReviewKind = "migration" | "sync-review";

function previewReview(kind: ReviewKind, actualAccountId: string) {
  return request<MigrationPreviewDto>(`/api/account-links/${actualAccountId}/${kind}/preview`);
}

function commitReview(kind: ReviewKind, actualAccountId: string, payload: CommitMigrationPayload) {
  return request<{ ok: boolean }>(`/api/account-links/${actualAccountId}/${kind}/commit`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export const api = {
  getSession() {
    return request<SessionDto>("/api/auth/session");
  },
  getRuntimeInfo() {
    return request<RuntimeInfoDto>("/api/runtime");
  },
  getProviderSettings<T extends Provider>(provider: T) {
    return request<ProviderSettingsByProviderDto<T>>(`/api/provider-settings/${provider}`);
  },
  updateProviderSettings<T extends Provider>(provider: T, settings: ProviderSettingsByProviderDto<T>) {
    return request<ProviderSettingsByProviderDto<T>>(`/api/provider-settings/${provider}`, {
      method: "PUT",
      body: JSON.stringify(settings)
    });
  },
  login(username: string, password: string) {
    return request<SessionDto>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
  },
  logout() {
    return request<SessionDto>("/api/auth/logout", {
      method: "POST"
    });
  },
  listAccounts() {
    return request<ActualAccountDto[]>("/api/actual/accounts");
  },
  listActualBankSyncLinks() {
    return request<ActualBankSyncLinkDto[]>("/api/actual/bank-sync-links");
  },
  listConnections() {
    return request<ConnectionDto[]>("/api/connections");
  },
  createPlaidLinkToken() {
    return request<{ linkToken: string }>("/api/connections/plaid/link-token", {
      method: "POST"
    });
  },
  exchangePlaidPublicToken(publicToken: string, label?: string) {
    return request<ProviderConnectResult>("/api/connections/plaid/exchange", {
      method: "POST",
      body: JSON.stringify({ publicToken, label })
    });
  },
  connectSimpleFin(setupToken: string, label?: string) {
    return request<ProviderConnectResult>("/api/connections/simplefin/connect", {
      method: "POST",
      body: JSON.stringify({
        setupToken,
        ...(label ? { label } : {})
      })
    });
  },
  reuseCachedSimpleFinConnection(label?: string) {
    return request<ProviderConnectResult>("/api/connections/simplefin/reuse-cached", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {})
    });
  },
  importExistingSimpleFinLinks(connectionId: string) {
    return request<{ imported: number; updated: number; skipped: number; unmatched: number }>(
      "/api/connections/simplefin/import-existing",
      {
        method: "POST",
        body: JSON.stringify({ connectionId })
      }
    );
  },
  createSaltEdgeConnectSession(label?: string) {
    return request<SaltEdgeConnectSessionDto>("/api/connections/saltedge/connect-session", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {})
    });
  },
  finalizeSaltEdgeConnection(payload: {
    connectionId: string;
    customerId?: string;
    connectionSecret?: string;
    label?: string;
  }) {
    return request<ProviderConnectResult>("/api/connections/saltedge/finalize", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  createHomeValueConnection(payload: UpsertHomeValueConnectionPayload) {
    return request<ProviderConnectResult>("/api/connections/home-values", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateHomeValueConnection(id: string, payload: UpsertHomeValueConnectionPayload) {
    return request<ProviderConnectResult>(`/api/connections/${id}/home-values`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  },
  getTellerConnectConfig() {
    return request<TellerConnectConfigDto>("/api/connections/teller/connect-config");
  },
  enrollTellerConnection(payload: {
    accessToken: string;
    enrollmentId: string;
    userId?: string | null;
    institutionName?: string | null;
    label?: string | null;
  }) {
    return request<ProviderConnectResult>("/api/connections/teller/enroll", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  reuseCachedTellerConnection(label?: string) {
    return request<ProviderConnectResult>("/api/connections/teller/reuse-cached", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {})
    });
  },
  seedTellerSandboxConnection(label?: string) {
    return request<ProviderConnectResult>("/api/connections/teller/sandbox/seed-connection", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {})
    });
  },
  refreshConnection(id: string) {
    return request<{ ok: boolean }>(`/api/connections/${id}/refresh`, {
      method: "POST"
    });
  },
  createConnectionReauthSession(id: string) {
    return request<ConnectionReauthSessionDto>(`/api/connections/${id}/reauth-session`, {
      method: "POST"
    });
  },
  disconnectConnection(id: string) {
    return request<{ ok: boolean }>(`/api/connections/${id}/disconnect`, {
      method: "POST"
    });
  },
  refreshAllConnections() {
    return request<{ ok: boolean }>("/api/connections/refresh-all", {
      method: "POST"
    });
  },
  seedPlaidSandboxConnection(label?: string) {
    return request<ProviderConnectResult>("/api/connections/plaid/sandbox/seed-connection", {
      method: "POST",
      body: JSON.stringify(label ? { label } : {})
    });
  },
  seedPlaidSandboxTransactions(id: string, count = 3) {
    return request<{ added: number }>(`/api/connections/${id}/plaid/sandbox/seed-transactions`, {
      method: "POST",
      body: JSON.stringify({ count })
    });
  },
  updateAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload) {
    return request<{ ok: boolean }>(`/api/account-links/${actualAccountId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
  },
  runSync(actualAccountId: string) {
    return request<{ ok: boolean }>(`/api/account-links/${actualAccountId}/sync`, {
      method: "POST"
    });
  },
  previewMigration(actualAccountId: string) {
    return previewReview("migration", actualAccountId);
  },
  commitMigration(actualAccountId: string, payload: CommitMigrationPayload) {
    return commitReview("migration", actualAccountId, payload);
  },
  previewSyncReview(actualAccountId: string) {
    return previewReview("sync-review", actualAccountId);
  },
  commitSyncReview(actualAccountId: string, payload: CommitMigrationPayload) {
    return commitReview("sync-review", actualAccountId, payload);
  },
  listSyncRuns() {
    return request<SyncRunDto[]>("/api/sync-runs");
  }
};
