import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createTestDatabase } from "../test/test-db.js";
import { createStripeService } from "./stripe-service.js";

const stripeMocks = vi.hoisted(() => ({
  accountsDisconnect: vi.fn(),
  accountsRefresh: vi.fn(),
  accountsRetrieve: vi.fn(),
  authorizationsRetrieve: vi.fn(),
  constructEvent: vi.fn((payload: Buffer | string, signature: string, secret: string) => {
    if (signature !== `secret:${secret}`) {
      throw new Error("Invalid signature");
    }

    const json = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
    return JSON.parse(json);
  }),
  customersCreate: vi.fn(),
  generateTestHeaderString: vi.fn(({ secret }: { secret: string }) => `secret:${secret}`),
  sessionsCreate: vi.fn(),
  transactionsList: vi.fn()
}));

vi.mock("stripe", () => {
  class StripeError extends Error {
    statusCode?: number;
    code?: string;

    constructor(raw?: { message?: string; statusCode?: number; code?: string }, type = "StripeError") {
      super(raw?.message ?? "Stripe error");
      this.name = type;
      if (raw?.statusCode !== undefined) {
        this.statusCode = raw.statusCode;
      }
      if (raw?.code !== undefined) {
        this.code = raw.code;
      }
    }
  }

  class StripeRateLimitError extends StripeError {}
  class StripeAuthenticationError extends StripeError {}
  class StripePermissionError extends StripeError {}

  class MockStripe {
    static errors = {
      StripeAuthenticationError,
      StripeError,
      StripePermissionError,
      StripeRateLimitError
    };

    customers = {
      create: stripeMocks.customersCreate
    };

    financialConnections = {
      accounts: {
        disconnect: stripeMocks.accountsDisconnect,
        refresh: stripeMocks.accountsRefresh,
        retrieve: stripeMocks.accountsRetrieve
      },
      authorizations: {
        retrieve: stripeMocks.authorizationsRetrieve
      },
      sessions: {
        create: stripeMocks.sessionsCreate
      },
      transactions: {
        list: stripeMocks.transactionsList
      }
    };

    webhooks = {
      constructEvent: stripeMocks.constructEvent,
      generateTestHeaderString: stripeMocks.generateTestHeaderString
    };
  }

  return {
    __esModule: true,
    default: MockStripe
  };
});

function createProviderSettingsMock() {
  return {
    get: vi.fn().mockResolvedValue({
      environment: "test",
      test: {
        publishableKey: "pk_test_123",
        secretKey: "sk_test_123",
        webhookSigningSecrets: ["whsec_test_123"]
      },
      live: {
        publishableKey: "",
        secretKey: "",
        webhookSigningSecrets: []
      },
      countryCodes: ["US"],
      permissions: ["balances", "transactions"],
      prefetch: ["balances", "transactions"],
      transactionsInitialDays: 90,
      automaticSyncConcurrency: 2
    })
  } as never;
}

describe.sequential("stripeService", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    stripeMocks.accountsDisconnect.mockReset();
    stripeMocks.accountsRefresh.mockReset();
    stripeMocks.accountsRetrieve.mockReset();
    stripeMocks.authorizationsRetrieve.mockReset();
    stripeMocks.constructEvent.mockClear();
    stripeMocks.customersCreate.mockReset();
    stripeMocks.generateTestHeaderString.mockClear();
    stripeMocks.sessionsCreate.mockReset();
    stripeMocks.transactionsList.mockReset();
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("reports webhooks as unconfigured when no signing secrets are present", async () => {
    const service = createStripeService({
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: "test",
          test: {
            publishableKey: "pk_test_123",
            secretKey: "sk_test_123",
            webhookSigningSecrets: []
          },
          live: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          countryCodes: ["US"],
          permissions: ["balances", "transactions"],
          prefetch: ["balances", "transactions"],
          transactionsInitialDays: 90,
          automaticSyncConcurrency: 2
        })
      } as never
    });

    await expect(service.webhooksConfigured()).resolves.toBe(false);
  });

  it("verifies and constructs Stripe webhook events with configured signing secrets", async () => {
    const service = createStripeService({
      providerSettings: createProviderSettingsMock()
    });

    const stripe = new Stripe("sk_test_123");
    const payload = JSON.stringify({
      id: "evt_test_webhook",
      object: "event",
      type: "financial_connections.account.deactivated"
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_test_123"
    });

    await expect(service.webhooksConfigured()).resolves.toBe(true);
    await expect(service.constructWebhookEvent(payload, header)).resolves.toMatchObject({
      id: "evt_test_webhook",
      type: "financial_connections.account.deactivated"
    });
    await expect(service.constructWebhookEvent(payload, "secret:wrong")).resolves.toBeNull();
  });

  it("accepts webhook signatures signed with any configured secret", async () => {
    const service = createStripeService({
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: "test",
          test: {
            publishableKey: "pk_test_123",
            secretKey: "sk_test_123",
            webhookSigningSecrets: ["whsec_old", "whsec_new"]
          },
          live: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          countryCodes: ["US"],
          permissions: ["balances", "transactions"],
          prefetch: ["balances", "transactions"],
          transactionsInitialDays: 90,
          automaticSyncConcurrency: 2
        })
      } as never
    });

    const stripe = new Stripe("sk_test_123");
    const payload = JSON.stringify({
      id: "evt_test_multi_secret",
      object: "event",
      type: "financial_connections.account.created"
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_new"
    });

    await expect(service.constructWebhookEvent(payload, header)).resolves.toMatchObject({
      id: "evt_test_multi_secret",
      type: "financial_connections.account.created"
    });
  });

  it("creates connect sessions with customer metadata and configured filters", async () => {
    stripeMocks.customersCreate.mockResolvedValue({
      id: "cus_123"
    });
    stripeMocks.sessionsCreate.mockResolvedValue({
      id: "fcs_123",
      client_secret: "fcs_secret_123"
    });

    const service = createStripeService({
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.createConnectSession("user-123")).resolves.toEqual({
      sessionId: "fcs_123",
      clientSecret: "fcs_secret_123",
      publishableKey: "pk_test_123"
    });
    expect(stripeMocks.customersCreate).toHaveBeenCalledWith({
      name: "Actual Sync Hub user-123",
      metadata: {
        actual_sync_user_id: "user-123"
      }
    });
    expect(stripeMocks.sessionsCreate).toHaveBeenCalledWith({
      account_holder: {
        type: "customer",
        customer: "cus_123"
      },
      filters: {
        countries: ["US"]
      },
      permissions: ["balances", "transactions"],
      prefetch: ["balances", "transactions"]
    });
  });

  it("finalizes Stripe accounts by deduplicating ids and persisting connection metadata", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    stripeMocks.accountsRetrieve.mockImplementation(async (accountId: string) => {
      if (accountId === "acct_1") {
        return {
          id: "acct_1",
          authorization: "auth_123",
          account_holder: {
            customer: "cus_123"
          },
          balance: {
            current: {
              usd: 125_00
            },
            cash: {
              available: {
                usd: 120_00
              }
            }
          },
          category: "cash",
          display_name: "Primary Checking",
          institution_name: "Mock Bank",
          last4: "1234",
          livemode: false,
          permissions: ["balances", "transactions"],
          subcategory: "checking"
        };
      }

      return {
        id: "acct_2",
        authorization: "auth_123",
        account_holder: {
          customer: "cus_123"
        },
        balance: {
          current: {
            usd: 9800
          },
          cash: {
            available: {
              usd: 9700
            }
          }
        },
        category: "cash",
        display_name: "Savings",
        institution_name: "Mock Bank",
        last4: "5678",
        livemode: false,
        permissions: ["balances"],
        subcategory: "savings"
      };
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    const result = await service.finalizeAccounts({
      accountIds: ["acct_1", " acct_1 ", "acct_2"],
      label: "Household Stripe",
      sessionId: "fcs_123"
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: result.connectionId
      },
      include: {
        accounts: {
          orderBy: {
            externalAccountId: "asc"
          }
        }
      }
    });

    expect(stripeMocks.accountsRetrieve).toHaveBeenCalledTimes(2);
    expect(connection.label).toBe("Household Stripe");
    expect(connection.providerItemId).toBe("auth_123");
    expect(connection.institutionName).toBe("Mock Bank");
    expect(connection.accounts.map(account => account.externalAccountId)).toEqual(["acct_1", "acct_2"]);
    expect(connection.accounts[0]).toMatchObject({
      name: "Primary Checking",
      mask: "1234",
      type: "cash",
      subtype: "checking",
      currentBalance: 125,
      availableBalance: 120
    });
    expect(JSON.parse(connection.metadataJson || "{}")).toMatchObject({
      stripe: {
        accountIds: ["acct_1", "acct_2"],
        authorizationId: "auth_123",
        customerId: "cus_123",
        environment: "test",
        livemode: false,
        permissions: ["balances", "transactions"],
        sessionId: "fcs_123"
      },
      health: null
    });
  });

  it("returns a manual reauth session when Stripe relink context is unavailable", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: null
      }
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.createReauthSession!({
      connectionId: connection.id,
      userId: "user-123"
    })).resolves.toEqual({
      provider: "STRIPE",
      connectionId: connection.id,
      mode: "manual",
      message: "Stripe relink is unavailable for this connection. Reconnect it from the Stripe Connections page."
    });
  });

  it("creates a Stripe relink session when customer and authorization context are available", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_123",
        metadataJson: JSON.stringify({
          stripe: {
            customerId: "cus_123",
            permissions: ["ownership"]
          }
        })
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Checking",
        type: "cash"
      }
    });

    stripeMocks.accountsRetrieve.mockResolvedValue({
      id: "acct_1",
      authorization: "auth_123",
      account_holder: {
        customer: "cus_123"
      },
      permissions: ["balances"],
      status: "active"
    });
    stripeMocks.authorizationsRetrieve.mockResolvedValue({
      id: "auth_123",
      status: "inactive",
      status_details: {
        inactive: {
          action: "relink_required"
        }
      }
    });
    stripeMocks.sessionsCreate.mockResolvedValue({
      id: "fcs_relink_123",
      client_secret: "fcs_secret_relink_123"
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.createReauthSession!({
      connectionId: connection.id,
      userId: "user-123"
    })).resolves.toEqual({
      provider: "STRIPE",
      connectionId: connection.id,
      mode: "stripe_relink",
      sessionId: "fcs_relink_123",
      clientSecret: "fcs_secret_relink_123",
      publishableKey: "pk_test_123"
    });
    expect(stripeMocks.sessionsCreate).toHaveBeenCalledWith({
      account_holder: {
        type: "customer",
        customer: "cus_123"
      },
      filters: {
        countries: ["US"]
      },
      permissions: ["balances", "transactions", "ownership"],
      prefetch: ["balances", "transactions"],
      relink_options: {
        authorization: "auth_123",
        account: "acct_1"
      }
    });
  });

  it("returns manual reauth when Stripe says the authorization cannot be repaired by relink", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_123",
        metadataJson: JSON.stringify({
          stripe: {
            customerId: "cus_123"
          }
        })
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Checking",
        type: "cash"
      }
    });

    stripeMocks.accountsRetrieve.mockResolvedValue({
      id: "acct_1",
      authorization: "auth_123",
      account_holder: {
        customer: "cus_123"
      },
      status: "active"
    });
    stripeMocks.authorizationsRetrieve.mockResolvedValue({
      id: "auth_123",
      status: "inactive",
      status_details: {
        inactive: {
          action: "none"
        }
      }
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.createReauthSession!({
      connectionId: connection.id,
      userId: "user-123"
    })).resolves.toEqual({
      provider: "STRIPE",
      connectionId: connection.id,
      mode: "manual",
      message: "Stripe reported that this authorization cannot be repaired with relink. Reconnect it from the Stripe Connections page."
    });
  });

  it("syncs webhook-triggered Stripe account updates without forcing a refresh", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_123",
        metadataJson: JSON.stringify({
          stripe: {
            permissions: ["balances", "transactions"]
          }
        })
      }
    });

    const account = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Old Name",
        type: "cash"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Actual Checking",
        assetType: "BANK",
        provider: "STRIPE",
        connectionId: connection.id,
        connectionAccountId: account.id,
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: JSON.stringify({
          providerSyncState: {
            cursor: "refresh_older"
          }
        })
      }
    });

    stripeMocks.accountsRetrieve.mockResolvedValue({
      id: "acct_1",
      authorization: "auth_123",
      balance: {
        current: {
          usd: 200_00
        },
        cash: {
          available: {
            usd: 180_00
          }
        }
      },
      category: "cash",
      display_name: "Updated Checking",
      institution_name: "Mock Bank",
      last4: "6789",
      permissions: ["balances", "transactions"],
      status: "active",
      subcategory: "checking"
    });
    stripeMocks.transactionsList.mockResolvedValue({
      data: [
        {
          id: "txn_posted",
          amount: -1234,
          description: "Coffee Shop",
          status: "posted",
          transacted_at: 1_778_000_000
        },
        {
          id: "txn_void",
          amount: -2500,
          description: "Void Transaction",
          status: "void",
          transacted_at: 1_778_000_100
        }
      ],
      has_more: false
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.syncAccountLinkFromWebhook(link.id)).resolves.toEqual({
      imported: 1,
      transactions: [
        {
          amount: -12.34,
          cleared: true,
          date: "2026-05-05",
          importedId: "txn_posted",
          importedPayee: "Coffee Shop",
          payeeName: "Coffee Shop",
          searchText: ["Coffee Shop"]
        }
      ],
      removedImportedIds: ["txn_void"],
      configPatch: {
        providerSyncState: {
          cursor: "refresh_older",
          windowStartDate: null,
          windowEndDate: null
        }
      }
    });
    expect(stripeMocks.accountsRefresh).not.toHaveBeenCalled();
    expect(stripeMocks.transactionsList).toHaveBeenCalledWith({
      account: "acct_1",
      limit: 100,
      transaction_refresh: {
        after: "refresh_older"
      }
    });

    const refreshedAccount = await prisma.connectionAccount.findUniqueOrThrow({
      where: {
        id: account.id
      }
    });
    expect(refreshedAccount).toMatchObject({
      name: "Updated Checking",
      mask: "6789",
      currentBalance: 200,
      availableBalance: 180
    });
  });

  it("refreshes Stripe connections and updates metadata from refreshed account state", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_old",
        metadataJson: JSON.stringify({
          stripe: {
            permissions: ["balances"],
            authorizationId: "auth_old"
          }
        })
      }
    });

    const account = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Checking",
        type: "cash"
      }
    });

    stripeMocks.accountsRetrieve
      .mockResolvedValueOnce({
        id: "acct_1",
        authorization: "auth_456",
        balance: {
          current: {
            usd: 500_00
          }
        },
        category: "cash",
        display_name: "Checking",
        permissions: ["balances"],
        status: "active",
        subcategory: "checking"
      })
      .mockResolvedValueOnce({
        id: "acct_1",
        authorization: "auth_456",
        balance: {
          current: {
            usd: 510_00
          },
          cash: {
            available: {
              usd: 505_00
            }
          }
        },
        balance_refresh: {
          status: "succeeded"
        },
        category: "cash",
        display_name: "Checking Refreshed",
        last4: "1111",
        permissions: ["balances"],
        status: "active",
        subcategory: "checking"
      });
    stripeMocks.accountsRefresh.mockResolvedValue({});

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.refreshConnection!(connection.id)).resolves.toBeUndefined();
    expect(stripeMocks.accountsRefresh).toHaveBeenCalledWith("acct_1", {
      features: ["balance"]
    });

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const refreshedAccount = await prisma.connectionAccount.findUniqueOrThrow({
      where: {
        id: account.id
      }
    });
    expect(refreshedAccount).toMatchObject({
      name: "Checking Refreshed",
      mask: "1111",
      currentBalance: 510,
      availableBalance: 505
    });
    expect(JSON.parse(refreshedConnection.metadataJson || "{}")).toMatchObject({
      stripe: {
        accountIds: ["acct_1"],
        authorizationId: "auth_456"
      },
      health: null
    });
  });

  it("rejects refreshConnection for non-Stripe connections", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Plaid Connection",
        accessTokenCiphertext: ""
      }
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.refreshConnection!(connection.id)).rejects.toThrow(
      "Connection is not a Stripe Financial Connections account"
    );
  });

  it("marks Stripe connections unhealthy when refreshConnection fails", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_old",
        metadataJson: JSON.stringify({
          stripe: {
            permissions: ["balances"],
            authorizationId: "auth_old"
          }
        })
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Checking",
        type: "cash"
      }
    });

    stripeMocks.accountsRetrieve.mockRejectedValueOnce(new Stripe.errors.StripeAuthenticationError({
      message: "stripe auth failed",
      statusCode: 401,
      code: "auth_failed"
    }));

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.refreshConnection!(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY",
      message: "stripe auth failed"
    });

    const updatedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });

    expect(JSON.parse(updatedConnection.metadataJson || "{}")).toMatchObject({
      stripe: {
        permissions: ["balances"],
        authorizationId: "auth_old"
      },
      health: {
        scope: "CONNECTION_AUTH",
        action: "RETRY",
        message: "stripe auth failed"
      }
    });
    expect(updatedConnection.status).toBe("ERROR");
  });

  it("rejects finalizeReauthSession when Stripe relink returns an authorization already linked elsewhere", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const existing = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Existing Stripe",
        accessTokenCiphertext: "",
        providerItemId: "auth_conflict"
      }
    });

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_old"
      }
    });

    stripeMocks.accountsRetrieve.mockResolvedValue({
      id: "acct_1",
      authorization: "auth_conflict",
      account_holder: {
        customer: "cus_123"
      },
      status: "active"
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.finalizeReauthSession({
      connectionId: connection.id,
      accountIds: ["acct_1"]
    })).rejects.toThrow(
      "Stripe relink returned an authorization already connected elsewhere. Disconnect the duplicate and try again."
    );
    expect(existing.id).toBeTruthy();
  });

  it("ignores disconnect errors that only indicate the account already needs manual relink", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_123"
      }
    });

    await prisma.connectionAccount.createMany({
      data: [
        {
          connectionId: connection.id,
          externalAccountId: "acct_1",
          name: "Checking",
          type: "cash"
        },
        {
          connectionId: connection.id,
          externalAccountId: "acct_2",
          name: "Savings",
          type: "cash"
        }
      ]
    });

    stripeMocks.accountsDisconnect
      .mockRejectedValueOnce(new Stripe.errors.StripeError({
        message: "account disconnected",
        code: "account_disconnected"
      }))
      .mockResolvedValueOnce({});

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection!(connection.id)).resolves.toBeUndefined();
    expect(stripeMocks.accountsDisconnect).toHaveBeenCalledTimes(2);
  });

  it("rejects disconnectConnection for non-Stripe connections", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Plaid Connection",
        accessTokenCiphertext: ""
      }
    });

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection!(connection.id)).rejects.toThrow(
      "Connection is not a Stripe Financial Connections account"
    );
  });

  it("rethrows unexpected Stripe disconnect failures as retryable provider errors", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "STRIPE",
        label: "Stripe Connection",
        accessTokenCiphertext: "",
        providerItemId: "auth_123"
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct_1",
        name: "Checking",
        type: "cash"
      }
    });

    stripeMocks.accountsDisconnect.mockRejectedValueOnce(new Stripe.errors.StripeError({
      message: "permission denied",
      statusCode: 403,
      code: "permission_denied"
    }));

    const service = createStripeService({
      prisma,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection!(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY",
      message: "permission denied"
    });
  });
});
