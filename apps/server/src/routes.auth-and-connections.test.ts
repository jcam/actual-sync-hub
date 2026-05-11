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

  it("rejects invalid login credentials", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue(null)
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "wrong-password"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Invalid credentials"
    });
  });

  it("reports session auth state before login and after logout", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-2",
              username: "admin"
            })
          }
        })
      })
    );

    const beforeLogin = await app.inject({
      method: "GET",
      url: "/api/auth/session"
    });

    expect(beforeLogin.statusCode).toBe(200);
    expect(beforeLogin.json()).toEqual({
      authenticated: false
    });

    const cookies = await loginAsAdmin(app);

    const afterLogin = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies
    });

    expect(afterLogin.statusCode).toBe(200);
    expect(afterLogin.json()).toEqual({
      authenticated: true,
      username: "admin"
    });

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies
    });

    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({
      authenticated: false
    });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies
    });

    expect(afterLogout.statusCode).toBe(200);
    expect(afterLogout.json()).toEqual({
      authenticated: false
    });
  });

  it("returns shared account options and categories once for the accounts route", async () => {
    const payload = {
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          balance: 123.45,
          link: {
            status: "ACTIVE",
            actualAccountId: "actual-1",
            actualAccountName: "Checking",
            assetType: "BANK",
            provider: null,
            connectionId: null,
            connectionAccountId: null,
            syncFrequency: "MANUAL",
            syncHour: null,
            syncDayOfWeek: null,
            isEnabled: false,
            lastSyncedAt: null,
            categoryMappings: [],
            seenCategoryNames: []
          }
        }
      ],
      options: [
        {
          connectionId: "conn-1",
          connectionLabel: "Plaid",
          connectionStatus: "ACTIVE",
          connectionAccountId: "conn-account-1",
          externalAccountId: "ext-1",
          provider: "PLAID",
          institutionName: "Bank",
          accountName: "Checking",
          mask: "11",
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
    const listActualAccounts = vi.fn().mockResolvedValue(payload);

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
            listActualAccounts
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/actual/accounts",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(payload);
    expect(listActualAccounts).toHaveBeenCalledOnce();
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

  it("creates a Stripe Financial Connections session for the authenticated user", async () => {
    const createConnectSession = vi.fn().mockResolvedValue({
      sessionId: "fcsess_123",
      clientSecret: "fcsess_secret_123",
      publishableKey: "pk_test_123"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-84",
              username: "admin"
            })
          },
          stripeService: {
            createConnectSession
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/stripe/session",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessionId: "fcsess_123",
      clientSecret: "fcsess_secret_123",
      publishableKey: "pk_test_123"
    });
    expect(createConnectSession).toHaveBeenCalledWith("user-84");
  });

  it("finalizes Stripe-linked accounts for the authenticated user", async () => {
    const finalizeAccounts = vi.fn().mockResolvedValue({
      connectionId: "conn-stripe-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-85",
              username: "admin"
            })
          },
          stripeService: {
            finalizeAccounts
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/stripe/finalize",
      payload: {
        sessionId: "fcsess_123",
        label: "Primary Stripe Bank",
        accountIds: ["fca_1", "fca_2"]
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "conn-stripe-1"
    });
    expect(finalizeAccounts).toHaveBeenCalledWith({
      sessionId: "fcsess_123",
      label: "Primary Stripe Bank",
      accountIds: ["fca_1", "fca_2"]
    });
  });

  it("finalizes Stripe relinked accounts for the authenticated user", async () => {
    const finalizeReauthSession = vi.fn().mockResolvedValue({
      connectionId: "conn-stripe-reauth-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-86",
              username: "admin"
            })
          },
          stripeService: {
            finalizeReauthSession
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/conn-stripe-reauth-1/stripe/reauth-finalize",
      payload: {
        sessionId: "fcsess_relink_123",
        accountIds: ["fca_3"]
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "conn-stripe-reauth-1"
    });
    expect(finalizeReauthSession).toHaveBeenCalledWith({
      connectionId: "conn-stripe-reauth-1",
      sessionId: "fcsess_relink_123",
      accountIds: ["fca_3"]
    });
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
    const reuseCachedConnection = vi.fn().mockResolvedValue({
      connectionId: "conn-simplefin-cached"
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
    const reuseCachedConnection = vi.fn().mockResolvedValue({
      connectionId: "conn-teller-cached"
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
    const exchangePublicToken = vi.fn().mockResolvedValue({
      connectionId: "connection-99"
    });

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
    const connectSetupToken = vi.fn().mockResolvedValue({
      connectionId: "connection-simplefin-1",
      warning: "Connection saved, but some upstream institutions need attention."
    });
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
      connectionId: "connection-simplefin-1",
      warning: "Connection saved, but some upstream institutions need attention."
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

  it("creates a Home Values connection", async () => {
    const createHomeValueConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-home-value-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-home-values",
              username: "admin"
            })
          },
          appService: {
            createHomeValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/home-values",
      payload: {
        label: "Primary residence",
        address: "123 Main St, Springfield, IL",
        source: "AVERAGE",
        redfinEstimate: 650000,
        redfinUrl: "https://www.redfin.com/example",
        movotoEstimate: 645000,
        movotoUrl: "https://www.movoto.com/example"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-home-value-1"
    });
    expect(createHomeValueConnection).toHaveBeenCalledWith({
      label: "Primary residence",
      address: "123 Main St, Springfield, IL",
      source: "AVERAGE",
      redfinEstimate: 650000,
      redfinUrl: "https://www.redfin.com/example",
      movotoEstimate: 645000,
      movotoUrl: "https://www.movoto.com/example"
    });
  });

  it("accepts home value property URLs before they are normalized by the provider service", async () => {
    const createHomeValueConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-home-value-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-home-values",
              username: "admin"
            })
          },
          appService: {
            createHomeValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/home-values",
      payload: {
        label: "Primary residence",
        address: "123 Main St, Springfield, IL",
        source: "REDFIN",
        redfinUrl: "www.redfin.com/example"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(createHomeValueConnection).toHaveBeenCalledWith({
      label: "Primary residence",
      address: "123 Main St, Springfield, IL",
      source: "REDFIN",
      redfinUrl: "www.redfin.com/example"
    });
  });

  it("updates a Home Values connection", async () => {
    const updateHomeValueConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-home-value-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-home-values",
              username: "admin"
            })
          },
          appService: {
            updateHomeValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/connection-home-value-1/home-values",
      payload: {
        label: "Primary residence",
        address: "123 Main St, Springfield, IL",
        source: "MOVOTO",
        redfinEstimate: 650000,
        redfinUrl: "https://www.redfin.com/example",
        movotoEstimate: 648500,
        movotoUrl: "https://www.movoto.com/example"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-home-value-1"
    });
    expect(updateHomeValueConnection).toHaveBeenCalledWith("connection-home-value-1", {
      label: "Primary residence",
      address: "123 Main St, Springfield, IL",
      source: "MOVOTO",
      redfinEstimate: 650000,
      redfinUrl: "https://www.redfin.com/example",
      movotoEstimate: 648500,
      movotoUrl: "https://www.movoto.com/example"
    });
  });

  it("creates a Vehicle Values connection", async () => {
    const createVehicleValueConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-vehicle-value-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-vehicle-values",
              username: "admin"
            })
          },
          appService: {
            createVehicleValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/vehicle-values",
      payload: {
        label: "Daily driver",
        vin: "1HGCM82633A123456",
        year: 2021,
        make: "Toyota",
        model: "Prius",
        trim: "XLE",
        mileage: 32000,
        zipCode: "10001",
        condition: "GOOD",
        source: "AVERAGE",
        kbbUrl: "www.kbb.com/toyota/prius/2021/",
        edmundsValue: 15000,
        hagertyUrl: "https://www.hagerty.com/valuation-tools/sample"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-vehicle-value-1"
    });
    expect(createVehicleValueConnection).toHaveBeenCalledWith({
      label: "Daily driver",
      vin: "1HGCM82633A123456",
      year: 2021,
      make: "Toyota",
      model: "Prius",
      trim: "XLE",
      mileage: 32000,
      zipCode: "10001",
      condition: "GOOD",
      source: "AVERAGE",
      kbbUrl: "www.kbb.com/toyota/prius/2021/",
      edmundsValue: 15000,
      hagertyUrl: "https://www.hagerty.com/valuation-tools/sample"
    });
  });

  it("updates a Vehicle Values connection", async () => {
    const updateVehicleValueConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-vehicle-value-1"
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-vehicle-values",
              username: "admin"
            })
          },
          appService: {
            updateVehicleValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/connections/connection-vehicle-value-1/vehicle-values",
      payload: {
        label: "Collector",
        year: 1995,
        make: "Nissan",
        model: "Skyline",
        mileage: 78000,
        zipCode: "10001",
        condition: "GOOD",
        source: "HAGERTY",
        hagertyUrl: "https://www.hagerty.com/valuation-tools/sample"
      },
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connectionId: "connection-vehicle-value-1"
    });
    expect(updateVehicleValueConnection).toHaveBeenCalledWith("connection-vehicle-value-1", {
      label: "Collector",
      year: 1995,
      make: "Nissan",
      model: "Skyline",
      mileage: 78000,
      zipCode: "10001",
      condition: "GOOD",
      source: "HAGERTY",
      hagertyUrl: "https://www.hagerty.com/valuation-tools/sample"
    });
  });

  it("returns Teller Connect config and persists a Teller enrollment", async () => {
    const getConnectConfig = vi.fn().mockReturnValue({
      applicationId: "app_test_123",
      environment: "sandbox",
      products: ["transactions", "balance"],
      selectAccount: "multiple"
    });
    const enrollConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-teller-1"
    });

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
    const seedSandboxConnection = vi.fn().mockResolvedValue({
      connectionId: "connection-teller-seeded"
    });

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
      error: "Public Token is required."
    });
    expect(exchangePublicToken).not.toHaveBeenCalled();
  });

  it("returns runtime info and triggers sandbox helpers for authenticated users", async () => {
    const getRuntimeInfo = vi.fn().mockResolvedValue({
      instanceLabel: "Live Sandbox",
      liveSandboxMode: true,
      providers: [],
      settings: {
        PLAID: {
          environment: "sandbox",
          sandbox: {
            clientId: "",
            secret: ""
          },
          production: {
            clientId: "",
            secret: ""
          },
          countryCodes: ["US"],
          products: ["transactions"],
          transactionsDaysRequested: 365,
          personalFinanceCategoryVersion: "v2",
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: {
            appId: "",
            sandboxAccessToken: ""
          },
          development: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          production: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 2,
          webhookSyncDebounceSeconds: 30
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }
      },
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
      simplefin: {
        enabled: true,
        mode: "sandbox",
        requiresSetupToken: true
      },
      actual: {
        serverUrl: "http://127.0.0.1:5006",
        budgetSyncIdConfigured: true,
        externalSyncWritebackEnabled: false
      }
    });
    const refreshAllConnections = vi.fn().mockResolvedValue(undefined);
    const seedSandboxConnection = vi.fn().mockResolvedValue({
      connectionId: "conn-seeded"
    });
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

  it("reads and updates provider settings for authenticated users", async () => {
    const get = vi.fn().mockResolvedValue({
      environment: "sandbox",
      sandbox: {
        appId: "teller-app-id",
        sandboxAccessToken: "",
        webhookSigningSecrets: []
      },
      development: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      production: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      transactionsInitialDays: 90,
      transactionsOverlapDays: 10,
      automaticSyncConcurrency: 2,
      webhookSyncDebounceSeconds: 30,
      webhookToleranceSeconds: 180
    });
    const update = vi.fn().mockResolvedValue({
      environment: "development",
      sandbox: {
        appId: "teller-app-id",
        sandboxAccessToken: "sandbox-token",
        webhookSigningSecrets: []
      },
      development: {
        appId: "teller-app-id-updated",
        certificatePem: "CERT",
        keyPem: "KEY",
        webhookSigningSecrets: ["secret-a", "secret-b"]
      },
      production: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      transactionsInitialDays: 60,
      transactionsOverlapDays: 7,
      automaticSyncConcurrency: 3,
      webhookSyncDebounceSeconds: 45,
      webhookToleranceSeconds: 180
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-settings",
              username: "admin"
            })
          },
          providerSettingsService: {
            get,
            update
          }
        })
      })
    );

    const cookies = await loginAsAdmin(app);

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/provider-settings/TELLER",
      cookies
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual({
      environment: "sandbox",
      sandbox: {
        appId: "teller-app-id",
        sandboxAccessToken: "",
        webhookSigningSecrets: []
      },
      development: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      production: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      transactionsInitialDays: 90,
      transactionsOverlapDays: 10,
      automaticSyncConcurrency: 2,
      webhookSyncDebounceSeconds: 30,
      webhookToleranceSeconds: 180
    });
    expect(get).toHaveBeenCalledWith("TELLER");

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/provider-settings/TELLER",
      cookies,
      payload: {
        environment: "development",
        sandbox: {
          appId: "teller-app-id",
          sandboxAccessToken: "sandbox-token",
          webhookSigningSecrets: []
        },
        development: {
          appId: "teller-app-id-updated",
          certificatePem: "CERT",
          keyPem: "KEY",
          webhookSigningSecrets: ["secret-a", "secret-b"]
        },
        production: {
          appId: "",
          certificatePem: "",
          keyPem: "",
          webhookSigningSecrets: []
        },
        transactionsInitialDays: 60,
        transactionsOverlapDays: 7,
        automaticSyncConcurrency: 3,
        webhookSyncDebounceSeconds: 45,
        webhookToleranceSeconds: 180
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toEqual({
      environment: "development",
      sandbox: {
        appId: "teller-app-id",
        sandboxAccessToken: "sandbox-token",
        webhookSigningSecrets: []
      },
      development: {
        appId: "teller-app-id-updated",
        certificatePem: "CERT",
        keyPem: "KEY",
        webhookSigningSecrets: ["secret-a", "secret-b"]
      },
      production: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      transactionsInitialDays: 60,
      transactionsOverlapDays: 7,
      automaticSyncConcurrency: 3,
      webhookSyncDebounceSeconds: 45,
      webhookToleranceSeconds: 180
    });
    expect(update).toHaveBeenCalledWith("TELLER", {
      environment: "development",
      sandbox: {
        appId: "teller-app-id",
        sandboxAccessToken: "sandbox-token",
        webhookSigningSecrets: []
      },
      development: {
        appId: "teller-app-id-updated",
        certificatePem: "CERT",
        keyPem: "KEY",
        webhookSigningSecrets: ["secret-a", "secret-b"]
      },
      production: {
        appId: "",
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: []
      },
      transactionsInitialDays: 60,
      transactionsOverlapDays: 7,
      automaticSyncConcurrency: 3,
      webhookSyncDebounceSeconds: 45,
      webhookToleranceSeconds: 180
    });
  });

  it("returns sync runs for authenticated users", async () => {
    const listSyncRuns = vi.fn().mockResolvedValue([
      {
        id: "run-1",
        status: "SUCCEEDED",
        startedAt: "2026-05-10T12:00:00.000Z"
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
              id: "user-sync-runs",
              username: "admin"
            })
          },
          appService: {
            listSyncRuns
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/sync-runs",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "run-1",
        status: "SUCCEEDED",
        startedAt: "2026-05-10T12:00:00.000Z"
      }
    ]);
    expect(listSyncRuns).toHaveBeenCalledOnce();
  });

  it("returns a 400 for an invalid provider settings route parameter", async () => {
    const get = vi.fn();

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-settings",
              username: "admin"
            })
          },
          providerSettingsService: {
            get
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/provider-settings/UNKNOWN_PROVIDER",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Provider must be one of PLAID, STRIPE, TELLER, SIMPLEFIN, HOME_VALUES, VEHICLE_VALUES."
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns a 400 for an invalid home-values source enum", async () => {
    const createHomeValueConnection = vi.fn();

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-home-values",
              username: "admin"
            })
          },
          appService: {
            createHomeValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/home-values",
      cookies: await loginAsAdmin(app),
      payload: {
        label: "Home",
        address: "123 Main St",
        source: "ZILLOW"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Source must be one of REDFIN, MOVOTO, HOMES_COM, TRULIA, AVERAGE."
    });
    expect(createHomeValueConnection).not.toHaveBeenCalled();
  });

  it("returns a 400 for an invalid vehicle-values source enum", async () => {
    const createVehicleValueConnection = vi.fn();

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-vehicle-values",
              username: "admin"
            })
          },
          appService: {
            createVehicleValueConnection
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connections/vehicle-values",
      cookies: await loginAsAdmin(app),
      payload: {
        make: "Toyota",
        model: "Prius",
        mileage: 32000,
        zipCode: "10001",
        condition: "GOOD",
        source: "BLACK_BOOK"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Source must be one of KBB, EDMUNDS, CARMAX, HAGERTY, AVERAGE."
    });
    expect(createVehicleValueConnection).not.toHaveBeenCalled();
  });
});
