import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {} as never,
    actualService: {} as never,
    authService: {
      authenticateUser: vi.fn(),
      ...(overrides.authService as object | undefined)
    },
    appService: {
      getRuntimeInfo: vi.fn(),
      listConnections: vi.fn(),
      listActualAccounts: vi.fn(),
      refreshAllConnections: vi.fn(),
      upsertAccountLink: vi.fn(),
      runAccountSync: vi.fn(),
      previewAccountMigration: vi.fn(),
      commitAccountMigration: vi.fn(),
      previewAccountSyncReview: vi.fn(),
      commitAccountSyncReview: vi.fn(),
      listSyncRuns: vi.fn(),
      ...(overrides.appService as object | undefined)
    },
    plaidService: {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      seedSandboxConnection: vi.fn(),
      seedSandboxTransactions: vi.fn(),
      ...(overrides.plaidService as object | undefined)
    }
  };
}

describe("server routes", () => {
  const apps: Array<Awaited<ReturnType<typeof createServer>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it("rejects protected routes without a session", async () => {
    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext()
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/connections"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("logs in and uses the session on later requests", async () => {
    const listConnections = vi.fn().mockResolvedValue([{ id: "conn-1", label: "Plaid", provider: "PLAID", status: "ACTIVE", accounts: [] }]);

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-1",
            username: "admin"
          })
        },
        appService: {
          listConnections
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });

    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));
    expect(cookie?.value).toBeTruthy();

    const response = await app.inject({
      method: "GET",
      url: "/api/connections",
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(200);
    expect(listConnections).toHaveBeenCalledOnce();
  });

  it("creates a Plaid link token for the authenticated user", async () => {
    const createLinkToken = vi.fn().mockResolvedValue("link-sandbox-token");

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-42",
            username: "admin"
          })
        },
        plaidService: {
          createLinkToken
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/link-token",
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      linkToken: "link-sandbox-token"
    });
    expect(createLinkToken).toHaveBeenCalledWith("user-42");
  });

  it("exchanges a Plaid public token for an authenticated user", async () => {
    const exchangePublicToken = vi.fn().mockResolvedValue("connection-99");

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-99",
            username: "admin"
          })
        },
        plaidService: {
          exchangePublicToken
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/exchange",
      payload: {
        publicToken: "public-sandbox-token",
        label: "Main checking"
      },
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-99"
    });
    expect(exchangePublicToken).toHaveBeenCalledWith("public-sandbox-token", "Main checking");
  });

  it("returns 400 for an invalid Plaid exchange payload", async () => {
    const exchangePublicToken = vi.fn();

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-100",
            username: "admin"
          })
        },
        plaidService: {
          exchangePublicToken
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/exchange",
      payload: {
        publicToken: ""
      },
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid request"
    });
    expect(exchangePublicToken).not.toHaveBeenCalled();
  });

  it("saves an account link through the route layer", async () => {
    const upsertAccountLink = vi.fn().mockResolvedValue(undefined);

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-7",
            username: "admin"
          })
        },
        appService: {
          upsertAccountLink
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));

    const payload = {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: "conn-1",
      connectionAccountId: "conn-account-1",
      syncFrequency: "DAILY",
      syncHour: 6,
      syncDayOfWeek: null,
      isEnabled: true,
      categoryMappings: []
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/account-links/actual-1",
      payload,
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true
    });
    expect(upsertAccountLink).toHaveBeenCalledWith("actual-1", payload);
  });

  it("runs a manual sync through the route layer", async () => {
    const runAccountSync = vi.fn().mockResolvedValue(undefined);

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-11",
            username: "admin"
          })
        },
        appService: {
          runAccountSync
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));

    const response = await app.inject({
      method: "POST",
      url: "/api/account-links/actual-1/sync",
      cookies: cookie ? { [cookie.name]: cookie.value } : {}
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true
    });
    expect(runAccountSync).toHaveBeenCalledWith("actual-1");
  });

  it("returns a migration preview and commits the selected imported ids", async () => {
    const previewAccountSyncReview = vi.fn().mockResolvedValue({
      actualAccountId: "actual-1",
      actualAccountName: "Checking",
      linkId: "link-1",
      status: "MIGRATING",
      items: []
    });
    const commitAccountSyncReview = vi.fn().mockResolvedValue(undefined);

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-13",
            username: "admin"
          })
        },
        appService: {
          previewAccountSyncReview,
          commitAccountSyncReview
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));
    const cookies = cookie ? { [cookie.name]: cookie.value } : {};

    const preview = await app.inject({
      method: "GET",
      url: "/api/account-links/actual-1/migration/preview",
      cookies
    });
    expect(preview.statusCode).toBe(200);
    expect(previewAccountSyncReview).toHaveBeenCalledWith("actual-1");

    const genericPreview = await app.inject({
      method: "GET",
      url: "/api/account-links/actual-1/sync-review/preview",
      cookies
    });
    expect(genericPreview.statusCode).toBe(200);

    const commit = await app.inject({
      method: "POST",
      url: "/api/account-links/actual-1/migration/commit",
      payload: {
        importedIds: ["plaid-1", "plaid-2"]
      },
      cookies
    });
    expect(commit.statusCode).toBe(200);
    expect(commitAccountSyncReview).toHaveBeenCalledWith("actual-1", {
      importedIds: ["plaid-1", "plaid-2"]
    });

    const genericCommit = await app.inject({
      method: "POST",
      url: "/api/account-links/actual-1/sync-review/commit",
      payload: {
        importedIds: ["plaid-9"]
      },
      cookies
    });
    expect(genericCommit.statusCode).toBe(200);
  });

  it("returns runtime info and triggers sandbox helpers for authenticated users", async () => {
    const getRuntimeInfo = vi.fn().mockResolvedValue({
      instanceLabel: "Live Sandbox",
      liveSandboxMode: true,
      plaid: {
        enabled: true,
        environment: "sandbox",
        sandboxToolsEnabled: true
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true
      }
    });
    const refreshAllConnections = vi.fn().mockResolvedValue(undefined);
    const seedSandboxConnection = vi.fn().mockResolvedValue("conn-seeded");
    const seedSandboxTransactions = vi.fn().mockResolvedValue({
      added: 3
    });

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: makeContext({
        authService: {
          authenticateUser: vi.fn().mockResolvedValue({
            id: "user-55",
            username: "admin"
          })
        },
        appService: {
          getRuntimeInfo,
          refreshAllConnections
        },
        plaidService: {
          seedSandboxConnection,
          seedSandboxTransactions
        }
      })
    });
    apps.push(app);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "secret"
      }
    });
    const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));
    const cookies = cookie ? { [cookie.name]: cookie.value } : {};

    const runtimeResponse = await app.inject({
      method: "GET",
      url: "/api/runtime",
      cookies
    });
    expect(runtimeResponse.statusCode).toBe(200);
    expect(getRuntimeInfo).toHaveBeenCalledOnce();

    const refreshAllResponse = await app.inject({
      method: "POST",
      url: "/api/connections/refresh-all",
      cookies
    });
    expect(refreshAllResponse.statusCode).toBe(200);
    expect(refreshAllConnections).toHaveBeenCalledOnce();

    const seedConnectionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/sandbox/seed-connection",
      cookies,
      payload: {}
    });
    expect(seedConnectionResponse.statusCode).toBe(200);
    expect(seedConnectionResponse.json()).toEqual({
      connectionId: "conn-seeded"
    });

    const seedTransactionsResponse = await app.inject({
      method: "POST",
      url: "/api/connections/conn-seeded/plaid/sandbox/seed-transactions",
      cookies,
      payload: {
        count: 3
      }
    });
    expect(seedTransactionsResponse.statusCode).toBe(200);
    expect(seedSandboxTransactions).toHaveBeenCalledWith("conn-seeded", 3);
  });
});
