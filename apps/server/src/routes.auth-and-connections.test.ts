import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import { createTrackedApps, loginAsAdmin, makeContext } from "./routes.test-helpers.js";

describe("server auth and connection routes", () => {
  const trackedApps = createTrackedApps();

  afterEach(async () => {
    await trackedApps.cleanup();
  });

  it("rejects protected routes without a session", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext()
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/connections"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("logs in and uses the session on later requests", async () => {
    const listConnections = vi.fn().mockResolvedValue([{ id: "conn-1", label: "Plaid", provider: "PLAID", status: "ACTIVE", accounts: [] }]);

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const cookies = await loginAsAdmin(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/connections",
      cookies
    });

    expect(response.statusCode).toBe(200);
    expect(listConnections).toHaveBeenCalledOnce();
  });

  it("creates a Plaid link token for the authenticated user", async () => {
    const createLinkToken = vi.fn().mockResolvedValue("link-sandbox-token");

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/link-token",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      linkToken: "link-sandbox-token"
    });
    expect(createLinkToken).toHaveBeenCalledWith("user-42");
  });

  it("creates a connection reauth session for the authenticated user", async () => {
    const createConnectionReauthSession = vi.fn().mockResolvedValue({
      provider: "PLAID",
      connectionId: "conn-reauth",
      mode: "plaid_update",
      linkToken: "link-update-token"
    });

    const app = trackedApps.track(
      await createServer({
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
          appService: {
            createConnectionReauthSession
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/conn-reauth/reauth-session",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: "PLAID",
      connectionId: "conn-reauth",
      mode: "plaid_update",
      linkToken: "link-update-token"
    });
    expect(createConnectionReauthSession).toHaveBeenCalledWith("conn-reauth", "user-42");
  });

  it("returns existing Actual bank-sync links for authenticated users", async () => {
    const listActualBankSyncLinks = vi.fn().mockResolvedValue([
      {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        actualOfficialName: "Main Checking",
        accountSyncSource: "simpleFin",
        externalAccountId: "sf-account-1",
        actualBankId: "bank-row-1",
        actualBankName: "SimpleFIN Credit Union",
        actualBankExternalId: "credit-union.example",
        mask: "1111",
        balanceCurrent: 321.45,
        balanceAvailable: 300.12,
        balanceLimit: null,
        closed: false,
        offbudget: false,
        lastSyncedAt: "2026-05-05",
        currentLinkId: null,
        currentLinkProvider: null,
        currentLinkStatus: null
      }
    ]);

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-actual",
              username: "admin"
            })
          },
          appService: {
            listActualBankSyncLinks
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/actual/bank-sync-links",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        actualOfficialName: "Main Checking",
        accountSyncSource: "simpleFin",
        externalAccountId: "sf-account-1",
        actualBankId: "bank-row-1",
        actualBankName: "SimpleFIN Credit Union",
        actualBankExternalId: "credit-union.example",
        mask: "1111",
        balanceCurrent: 321.45,
        balanceAvailable: 300.12,
        balanceLimit: null,
        closed: false,
        offbudget: false,
        lastSyncedAt: "2026-05-05",
        currentLinkId: null,
        currentLinkProvider: null,
        currentLinkStatus: null
      }
    ]);
  });

  it("reuses a cached SimpleFIN fixture for authenticated users", async () => {
    const reuseCachedConnection = vi.fn().mockResolvedValue("conn-simplefin-cached");

    const app = trackedApps.track(
      await createServer({
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
          simplefinService: {
            reuseCachedConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/simplefin/reuse-cached",
      payload: {
        label: "Reused SimpleFIN"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "conn-simplefin-cached"
    });
    expect(reuseCachedConnection).toHaveBeenCalledWith("Reused SimpleFIN");
  });

  it("reuses a cached Teller fixture for authenticated users", async () => {
    const reuseCachedConnection = vi.fn().mockResolvedValue("conn-teller-cached");

    const app = trackedApps.track(
      await createServer({
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
          tellerService: {
            reuseCachedConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/teller/reuse-cached",
      payload: {
        label: "Reused Teller"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "conn-teller-cached"
    });
    expect(reuseCachedConnection).toHaveBeenCalledWith("Reused Teller");
  });

  it("exchanges a Plaid public token for an authenticated user", async () => {
    const exchangePublicToken = vi.fn().mockResolvedValue("connection-99");

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/exchange",
      payload: {
        publicToken: "public-sandbox-token",
        label: "Main checking"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-99"
    });
    expect(exchangePublicToken).toHaveBeenCalledWith("public-sandbox-token", "Main checking");
  });

  it("connects SimpleFIN and imports matching native Actual links", async () => {
    const connectSetupToken = vi.fn().mockResolvedValue("connection-simplefin-1");
    const importExistingSimpleFinLinks = vi.fn().mockResolvedValue({
      imported: 3,
      updated: 1,
      skipped: 2,
      unmatched: 0
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-simplefin",
              username: "admin"
            })
          },
          simplefinService: {
            connectSetupToken
          },
          appService: {
            importExistingSimpleFinLinks
          }
        })
      })
    );

    const cookies = await loginAsAdmin(app);

    const connectResponse = await app.inject({
      method: "POST",
      url: "/api/connections/simplefin/connect",
      payload: {
        setupToken: "c2V0dXAtdG9rZW4=",
        label: "Household SimpleFIN"
      },
      cookies
    });

    expect(connectResponse.statusCode).toBe(200);
    expect(connectResponse.json()).toEqual({
      connectionId: "connection-simplefin-1"
    });
    expect(connectSetupToken).toHaveBeenCalledWith({
      setupToken: "c2V0dXAtdG9rZW4=",
      label: "Household SimpleFIN"
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/connections/simplefin/import-existing",
      payload: {
        connectionId: "connection-simplefin-1"
      },
      cookies
    });

    expect(importResponse.statusCode).toBe(200);
    expect(importResponse.json()).toEqual({
      imported: 3,
      updated: 1,
      skipped: 2,
      unmatched: 0
    });
    expect(importExistingSimpleFinLinks).toHaveBeenCalledWith("connection-simplefin-1");
  });

  it("disconnects a SimpleFIN connection", async () => {
    const disconnectConnection = vi.fn().mockResolvedValue(undefined);

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-simplefin-disconnect",
              username: "admin"
            })
          },
          appService: {
            disconnectConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/conn-simplefin-1/disconnect",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(disconnectConnection).toHaveBeenCalledWith("conn-simplefin-1");
  });

  it("returns Teller Connect config and persists a Teller enrollment", async () => {
    const getConnectConfig = vi.fn().mockReturnValue({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });
    const enrollConnection = vi.fn().mockResolvedValue("connection-teller-1");

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-teller",
              username: "admin"
            })
          },
          tellerService: {
            getConnectConfig,
            enrollConnection
          }
        })
      })
    );

    const cookies = await loginAsAdmin(app);

    const configResponse = await app.inject({
      method: "GET",
      url: "/api/connections/teller/connect-config",
      cookies
    });
    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json()).toEqual({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });

    const enrollPayload = {
      accessToken: "test_token_123",
      enrollmentId: "enr_123",
      userId: "usr_123",
      institutionName: "Security Credit Union"
    };
    const enrollResponse = await app.inject({
      method: "POST",
      url: "/api/connections/teller/enroll",
      payload: enrollPayload,
      cookies
    });
    expect(enrollResponse.statusCode).toBe(200);
    expect(enrollResponse.json()).toEqual({
      connectionId: "connection-teller-1"
    });
    expect(enrollConnection).toHaveBeenCalledWith(enrollPayload);
  });

  it("seeds a Teller sandbox connection for authenticated users", async () => {
    const seedSandboxConnection = vi.fn().mockResolvedValue("connection-teller-seeded");

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-teller-seed",
              username: "admin"
            })
          },
          tellerService: {
            seedSandboxConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/teller/sandbox/seed-connection",
      payload: {},
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-teller-seeded"
    });
    expect(seedSandboxConnection).toHaveBeenCalledWith(undefined);
  });

  it("returns 400 for an invalid Plaid exchange payload", async () => {
    const exchangePublicToken = vi.fn();

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/exchange",
      payload: {
        publicToken: ""
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid request"
    });
    expect(exchangePublicToken).not.toHaveBeenCalled();
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
      teller: {
        enabled: false,
        environment: "sandbox",
        mtlsConfigured: false
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

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const cookies = await loginAsAdmin(app);

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
