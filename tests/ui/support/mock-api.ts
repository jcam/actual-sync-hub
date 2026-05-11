import type { Page, Request } from "@playwright/test";

type SessionState = {
  authenticated: boolean;
  username?: string;
};

type MockRuntime = {
  instanceLabel: string;
  liveSandboxMode: boolean;
  providers: Array<{
    provider: string;
    label: string;
    enabled: boolean;
    ready: boolean;
    environment?: string | null;
    issues: string[];
    notes: string[];
  }>;
  settings: {
    PLAID: Record<string, unknown>;
    STRIPE: Record<string, unknown>;
    TELLER: Record<string, unknown>;
    SIMPLEFIN: Record<string, unknown>;
    HOME_VALUES?: {
      automaticSyncConcurrency: number;
      redfinFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
      movotoFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
      homesFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
      truliaFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
    };
  };
  plaid: {
    enabled: boolean;
    environment: "sandbox" | "production";
    sandboxToolsEnabled: boolean;
  };
  stripe: {
    enabled: boolean;
    environment: "test" | "live";
    publishableKeyConfigured: boolean;
    secretKeyConfigured: boolean;
  };
  teller: {
    enabled: boolean;
    environment: "sandbox" | "development" | "production";
    mtlsConfigured: boolean;
  };
  simplefin: {
    enabled: boolean;
    mode: "sandbox" | "development" | "production";
    requiresSetupToken: boolean;
  };
  actual: {
    serverUrl: string;
    budgetSyncIdConfigured: boolean;
    externalSyncWritebackEnabled: boolean;
  };
};

type MockAccountsResponse = {
  accounts: Array<{
    id: string;
    name: string;
    balance: number;
    offbudget?: boolean;
    closed?: boolean;
    link: {
      status: "ACTIVE" | "MIGRATING";
      actualAccountId: string;
      actualAccountName: string;
      assetType: string;
      provider?: string | null;
      connectionId?: string | null;
      connectionAccountId?: string | null;
      syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
      syncHour?: number | null;
      syncDayOfWeek?: number | null;
      isEnabled: boolean;
      categoryMappings: Array<{ sourceCategory: string; actualCategoryId: string }>;
      seenCategoryNames: string[];
      health?: null;
    };
  }>;
  options: Array<{
    connectionId: string;
    connectionLabel: string;
    connectionStatus: "ACTIVE" | "DISCONNECTED";
    connectionHealth?: null;
    connectionAccountId: string;
    externalAccountId: string;
    provider: string;
    institutionName?: string | null;
    accountName: string;
    mask?: string | null;
    type: string;
    subtype?: string | null;
    providerConnectionId?: string | null;
    providerConnectionName?: string | null;
    providerInstitutionName?: string | null;
  }>;
  actualCategories: Array<{ id: string; name: string }>;
};

type MockConnection = {
  id: string;
  provider: string;
  label: string;
  status: "ACTIVE" | "DISCONNECTED";
  institutionName?: string | null;
  institutionId?: string | null;
  providerUserId?: string | null;
  providerAccountsUrl?: string | null;
  lastRefreshedAt?: string | null;
  health?: null;
  homeValues?: {
    address: string;
    source: "REDFIN" | "MOVOTO" | "HOMES_COM" | "TRULIA" | "AVERAGE";
    redfinEstimate?: number | null;
    redfinUrl?: string | null;
    movotoEstimate?: number | null;
    movotoUrl?: string | null;
    homesEstimate?: number | null;
    homesUrl?: string | null;
    truliaEstimate?: number | null;
    truliaUrl?: string | null;
    calculatedValue?: number | null;
    lastCalculatedAt?: string | null;
    sources?: {
      redfin?: {
        estimate?: number | null;
        lastFailureMessage?: string | null;
        usingCachedEstimate?: boolean | null;
        stale?: boolean | null;
      } | null;
      movoto?: null;
      homes?: null;
      trulia?: null;
    } | null;
  } | null;
  accounts: Array<{
    id: string;
    externalAccountId: string;
    name: string;
    type: string;
    currentBalance?: number | null;
  }>;
};

type MockState = {
  session: SessionState;
  runtime: MockRuntime;
  accountsResponse: MockAccountsResponse;
  syncRuns: Array<{
    id: string;
    status: "SUCCESS" | "FAILED" | "RUNNING";
    startedAt: string;
    summary?: string | null;
    error?: string | null;
  }>;
  connections: MockConnection[];
};

type MockOptions = {
  authenticated?: boolean;
  homeValueConnections?: MockConnection[];
};

function createRuntime(): MockRuntime {
  return {
    instanceLabel: "Playwright Fixture",
    liveSandboxMode: false,
    providers: [],
    settings: {
      PLAID: {},
      STRIPE: {},
      TELLER: {},
      SIMPLEFIN: {},
      HOME_VALUES: {
        automaticSyncConcurrency: 2,
        redfinFetchMethod: "node_fetch",
        movotoFetchMethod: "node_fetch",
        homesFetchMethod: "node_fetch",
        truliaFetchMethod: "node_fetch"
      }
    },
    plaid: {
      enabled: false,
      environment: "sandbox",
      sandboxToolsEnabled: false
    },
    stripe: {
      enabled: false,
      environment: "test",
      publishableKeyConfigured: false,
      secretKeyConfigured: false
    },
    teller: {
      enabled: false,
      environment: "sandbox",
      mtlsConfigured: false
    },
    simplefin: {
      enabled: false,
      mode: "sandbox",
      requiresSetupToken: true
    },
    actual: {
      serverUrl: "http://localhost:5006",
      budgetSyncIdConfigured: true,
      externalSyncWritebackEnabled: true
    }
  };
}

function createAccountsResponse(): MockAccountsResponse {
  return {
    accounts: [
      {
        id: "actual-checking",
        name: "Household Checking",
        balance: 1825.22,
        link: {
          status: "ACTIVE",
          actualAccountId: "actual-checking",
          actualAccountName: "Household Checking",
          assetType: "BANK",
          provider: "PLAID",
          connectionId: "conn-plaid-1",
          connectionAccountId: "conn-acct-1",
          syncFrequency: "DAILY",
          syncHour: 6,
          syncDayOfWeek: 1,
          isEnabled: true,
          categoryMappings: [],
          seenCategoryNames: ["Groceries", "Utilities"],
          health: null
        }
      }
    ],
    options: [
      {
        connectionId: "conn-plaid-1",
        connectionLabel: "Main Checking Feed",
        connectionStatus: "ACTIVE",
        connectionHealth: null,
        connectionAccountId: "conn-acct-1",
        externalAccountId: "ext-acct-1",
        provider: "PLAID",
        institutionName: "Mock Bank",
        accountName: "Everyday Checking",
        mask: "12",
        type: "depository",
        subtype: "checking"
      }
    ],
    actualCategories: [
      {
        id: "cat-1",
        name: "Groceries"
      }
    ]
  };
}

function createInitialState(options: MockOptions = {}): MockState {
  return {
    session: options.authenticated ? { authenticated: true, username: "admin" } : { authenticated: false },
    runtime: createRuntime(),
    accountsResponse: createAccountsResponse(),
    syncRuns: [
      {
        id: "sync-1",
        status: "SUCCESS",
        startedAt: "2026-05-11T12:00:00.000Z",
        summary: "Imported 12 transactions"
      }
    ],
    connections: options.homeValueConnections ?? []
  };
}

async function readJsonBody<T>(request: Request) {
  const body = request.postData();
  const parsed: unknown = body ? JSON.parse(body) : {};
  return parsed as T;
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  };
}

function buildHomeValueConnection(payload: {
  label?: string | null;
  address: string;
  source: "REDFIN" | "MOVOTO" | "HOMES_COM" | "TRULIA" | "AVERAGE";
  redfinUrl?: string | null;
  movotoUrl?: string | null;
  homesUrl?: string | null;
  truliaUrl?: string | null;
}): MockConnection {
  return {
    id: `conn-home-${Math.random().toString(16).slice(2, 8)}`,
    provider: "HOME_VALUES",
    label: payload.label?.trim() || "Saved property",
    status: "ACTIVE",
    homeValues: {
      address: payload.address,
      source: payload.source,
      redfinUrl: payload.redfinUrl ?? null,
      movotoUrl: payload.movotoUrl ?? null,
      homesUrl: payload.homesUrl ?? null,
      truliaUrl: payload.truliaUrl ?? null,
      redfinEstimate: payload.redfinUrl ? 712345 : null,
      movotoEstimate: null,
      homesEstimate: null,
      truliaEstimate: null,
      calculatedValue: payload.redfinUrl ? 712345 : null,
      lastCalculatedAt: "2026-05-11T12:30:00.000Z",
      sources: payload.redfinUrl
        ? {
            redfin: {
              estimate: 712345,
              lastFailureMessage: null,
              stale: false,
              usingCachedEstimate: false
            },
            movoto: null,
            homes: null,
            trulia: null
          }
        : null
    },
    accounts: [
      {
        id: "home-account-1",
        externalAccountId: "home-external-1",
        name: payload.label?.trim() || "Saved property",
        type: "asset",
        currentBalance: payload.redfinUrl ? 712345 : null
      }
    ]
  };
}

export async function installMockApi(page: Page, options: MockOptions = {}) {
  const state = createInitialState(options);

  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === "GET" && path === "/api/auth/session") {
      await route.fulfill(json(state.session));
      return;
    }

    if (method === "POST" && path === "/api/auth/login") {
      state.session = {
        authenticated: true,
        username: "admin"
      };
      await route.fulfill(json(state.session));
      return;
    }

    if (method === "POST" && path === "/api/auth/logout") {
      state.session = { authenticated: false };
      await route.fulfill(json(state.session));
      return;
    }

    if (method === "GET" && path === "/api/actual/accounts") {
      await route.fulfill(json(state.accountsResponse));
      return;
    }

    if (method === "GET" && path === "/api/sync-runs") {
      await route.fulfill(json(state.syncRuns));
      return;
    }

    if (method === "GET" && path === "/api/runtime") {
      await route.fulfill(json(state.runtime));
      return;
    }

    if (method === "GET" && path === "/api/connections") {
      await route.fulfill(json(state.connections));
      return;
    }

    if (method === "POST" && path === "/api/connections/home-values") {
      const payload = await readJsonBody<{
        label?: string | null;
        address: string;
        source: "REDFIN" | "MOVOTO" | "HOMES_COM" | "TRULIA" | "AVERAGE";
        redfinUrl?: string | null;
        movotoUrl?: string | null;
        homesUrl?: string | null;
        truliaUrl?: string | null;
      }>(request);
      const connection = buildHomeValueConnection(payload);
      state.connections.push(connection);
      await route.fulfill(json({ connectionId: connection.id }));
      return;
    }

    const updateHomeValueMatch = path.match(/^\/api\/connections\/([^/]+)\/home-values$/);
    if (method === "PUT" && updateHomeValueMatch) {
      const payload = await readJsonBody<{
        label?: string | null;
        address: string;
        source: "REDFIN" | "MOVOTO" | "HOMES_COM" | "TRULIA" | "AVERAGE";
        redfinUrl?: string | null;
        movotoUrl?: string | null;
        homesUrl?: string | null;
        truliaUrl?: string | null;
      }>(request);
      const index = state.connections.findIndex(connection => connection.id === updateHomeValueMatch[1]);
      if (index === -1) {
        await route.fulfill(json({ error: "Connection not found" }, 404));
        return;
      }
      state.connections[index] = {
        ...buildHomeValueConnection(payload),
        id: state.connections[index].id
      };
      await route.fulfill(json({ connectionId: state.connections[index].id }));
      return;
    }

    await route.fulfill(json({ error: `Unhandled mocked API request: ${method} ${path}` }, 500));
  });

  return state;
}
