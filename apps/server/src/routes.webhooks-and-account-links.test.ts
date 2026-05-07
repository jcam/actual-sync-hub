import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";
import { createTrackedApps, loginAsAdmin, makeContext } from "./routes.test-helpers.js";

describe("server webhook and account-link routes", () => {
  const trackedApps = createTrackedApps();

  afterEach(async () => {
    await trackedApps.cleanup();
  });

  it("rejects external sync bridge requests without a valid Actual token", async () => {
    const validateActualToken = vi.fn().mockResolvedValue(false);

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            validateActualToken
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/external-sync/status?accountId=actual-1"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Unauthorized",
      reason: "Unauthorized"
    });
    expect(validateActualToken).not.toHaveBeenCalled();
  });

  it("returns bridge status for a validated Actual token", async () => {
    const getExternalSyncBridgeStatus = vi.fn().mockResolvedValue({
      configured: true,
      state: "ok",
      message: null,
      lastSync: "2026-05-05T12:00:00.000Z",
      canSync: true,
      needsReauth: false
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            validateActualToken: vi.fn().mockResolvedValue(true)
          },
          appService: {
            getExternalSyncBridgeStatus
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/external-sync/status?accountId=actual-1",
      headers: {
        "x-actual-token": "valid-token"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      data: {
        configured: true,
        state: "ok",
        message: null,
        lastSync: "2026-05-05T12:00:00.000Z",
        canSync: true,
        needsReauth: false
      }
    });
    expect(getExternalSyncBridgeStatus).toHaveBeenCalledWith("actual-1");
  });

  it("accepts POST status requests for Actual bridge compatibility", async () => {
    const getExternalSyncBridgeStatus = vi.fn().mockResolvedValue({
      configured: true,
      state: "ok",
      message: null,
      lastSync: "2026-05-05T12:00:00.000Z",
      canSync: true,
      needsReauth: false
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            validateActualToken: vi.fn().mockResolvedValue(true)
          },
          appService: {
            getExternalSyncBridgeStatus
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/external-sync/status",
      headers: {
        "x-actual-token": "valid-token"
      },
      payload: {
        accountId: "actual-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      data: {
        configured: true,
        state: "ok",
        message: null,
        lastSync: "2026-05-05T12:00:00.000Z",
        canSync: true,
        needsReauth: false
      }
    });
    expect(getExternalSyncBridgeStatus).toHaveBeenCalledWith("actual-1");
  });

  it("runs bridge sync for a validated Actual token", async () => {
    const runExternalSyncBridgeSync = vi.fn().mockResolvedValue({
      message: "Imported 3 transactions.",
      lastSync: "2026-05-05T12:30:00.000Z",
      newTransactions: ["txn-1", "txn-2", "txn-3"],
      matchedTransactions: ["txn-4"],
      updatedAccounts: ["actual-1"]
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            validateActualToken: vi.fn().mockResolvedValue(true)
          },
          appService: {
            runExternalSyncBridgeSync
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/external-sync/sync",
      headers: {
        "x-actual-token": "valid-token"
      },
      payload: {
        accountId: "actual-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      data: {
        message: "Imported 3 transactions.",
        lastSync: "2026-05-05T12:30:00.000Z",
        newTransactions: ["txn-1", "txn-2", "txn-3"],
        matchedTransactions: ["txn-4"],
        updatedAccounts: ["actual-1"]
      }
    });
    expect(runExternalSyncBridgeSync).toHaveBeenCalledWith("actual-1");
  });

  it("rejects Teller webhooks when webhook verification is not configured", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          tellerService: {
            webhooksConfigured: vi.fn().mockReturnValue(false)
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/teller",
      payload: {
        id: "wh_1",
        type: "webhook.test",
        timestamp: "2026-05-05T00:00:00Z",
        payload: {}
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Teller webhooks are not configured"
    });
  });

  it("accepts a verified Teller webhook and delegates it to the app service", async () => {
    const handleTellerWebhook = vi.fn().mockResolvedValue(undefined);
    const verifyWebhookSignature = vi.fn().mockReturnValue(true);

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          appService: {
            handleTellerWebhook
          },
          tellerService: {
            webhooksConfigured: vi.fn().mockReturnValue(true),
            verifyWebhookSignature
          }
        })
      })
    );

    const payload = {
      id: "wh_2",
      type: "transactions.processed",
      timestamp: "2026-05-05T00:00:00Z",
      payload: {
        enrollment_id: "enr_123",
        transactions: []
      }
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/teller",
      headers: {
        "teller-signature": "t=123,v1=deadbeef"
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true
    });
    expect(verifyWebhookSignature).toHaveBeenCalledWith(JSON.stringify(payload), "t=123,v1=deadbeef");
    expect(handleTellerWebhook).toHaveBeenCalledWith(payload);
  });

  it("rejects Stripe webhooks when webhook verification is not configured", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          stripeService: {
            webhooksConfigured: vi.fn().mockReturnValue(false)
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=deadbeef"
      },
      payload: JSON.stringify({
        id: "evt_1",
        type: "financial_connections.account.deactivated",
        data: {
          object: {
            id: "fca_123",
            object: "financial_connections.account"
          }
        }
      })
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Stripe webhooks are not configured"
    });
  });

  it("accepts a verified Stripe webhook and delegates it to the app service", async () => {
    const handleStripeWebhook = vi.fn().mockResolvedValue(undefined);
    const constructWebhookEvent = vi.fn().mockResolvedValue({
      id: "evt_2",
      type: "financial_connections.account.reactivated",
      created: 1_778_000_000,
      data: {
        object: {
          id: "fca_123",
          object: "financial_connections.account",
          authorization: "fcauth_123"
        }
      }
    });

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          appService: {
            handleStripeWebhook
          },
          stripeService: {
            webhooksConfigured: vi.fn().mockReturnValue(true),
            constructWebhookEvent
          }
        })
      })
    );

    const payload = JSON.stringify({
      id: "evt_2",
      type: "financial_connections.account.reactivated",
      data: {
        object: {
          id: "fca_123",
          object: "financial_connections.account",
          authorization: "fcauth_123"
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=deadbeef"
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true
    });
    expect(constructWebhookEvent).toHaveBeenCalledWith(expect.any(Buffer), "t=123,v1=deadbeef");
    expect(handleStripeWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "evt_2",
        type: "financial_connections.account.reactivated"
      })
    );
  });

  it("saves an account link through the route layer", async () => {
    const upsertAccountLink = vi.fn().mockResolvedValue(undefined);

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const payload = {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "SIMPLEFIN",
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
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true
    });
    expect(upsertAccountLink).toHaveBeenCalledWith("actual-1", payload);
  });

  it("runs a manual sync through the route layer", async () => {
    const runAccountSync = vi.fn().mockResolvedValue(undefined);

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/account-links/actual-1/sync",
      cookies: await loginAsAdmin(app)
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

    const app = trackedApps.track(
      await createServer({
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
      })
    );

    const cookies = await loginAsAdmin(app);

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
});
