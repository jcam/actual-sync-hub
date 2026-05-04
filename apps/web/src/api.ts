import type {
  ActualAccountDto,
  CommitMigrationPayload,
  ConnectionDto,
  MigrationPreviewDto,
  RuntimeInfoDto,
  SessionDto,
  SyncRunDto,
  UpdateAccountLinkPayload
} from "@actual-sync/shared";

async function request<T>(input: RequestInfo, init?: RequestInit) {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const response = await fetch(input, {
    credentials: "include",
    headers: hasBody
      ? {
          "Content-Type": "application/json",
          ...(init?.headers || {})
        }
      : init?.headers,
    ...init
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  getSession() {
    return request<SessionDto>("/api/auth/session");
  },
  getRuntimeInfo() {
    return request<RuntimeInfoDto>("/api/runtime");
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
  listAccounts(includeTransactions = true) {
    return request<ActualAccountDto[]>(`/api/actual/accounts?includeTransactions=${includeTransactions ? "true" : "false"}`);
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
    return request<{ connectionId: string }>("/api/connections/plaid/exchange", {
      method: "POST",
      body: JSON.stringify({ publicToken, label })
    });
  },
  refreshConnection(id: string) {
    return request<{ ok: boolean }>(`/api/connections/${id}/refresh`, {
      method: "POST"
    });
  },
  refreshAllConnections() {
    return request<{ ok: boolean }>("/api/connections/refresh-all", {
      method: "POST"
    });
  },
  seedPlaidSandboxConnection(label?: string) {
    return request<{ connectionId: string }>("/api/connections/plaid/sandbox/seed-connection", {
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
    return request<MigrationPreviewDto>(`/api/account-links/${actualAccountId}/migration/preview`);
  },
  commitMigration(actualAccountId: string, payload: CommitMigrationPayload) {
    return request<{ ok: boolean }>(`/api/account-links/${actualAccountId}/migration/commit`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  previewSyncReview(actualAccountId: string) {
    return request<MigrationPreviewDto>(`/api/account-links/${actualAccountId}/sync-review/preview`);
  },
  commitSyncReview(actualAccountId: string, payload: CommitMigrationPayload) {
    return request<{ ok: boolean }>(`/api/account-links/${actualAccountId}/sync-review/commit`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  listSyncRuns() {
    return request<SyncRunDto[]>("/api/sync-runs");
  }
};
