import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";
import { createPlaidService } from "./plaid-service.js";
import type { PlaidConfig } from "./plaid-service.js";

const mockPlaidClient = vi.hoisted(() => ({
  linkTokenCreate: vi.fn(),
  itemRemove: vi.fn(),
  accountsGet: vi.fn(),
  transactionsSync: vi.fn(),
  webhookVerificationKeyGet: vi.fn()
}));

vi.mock("plaid", () => ({
  Configuration: vi.fn(function configuration(value) {
    return value;
  }),
  PlaidApi: vi.fn(function plaidApi() {
    return mockPlaidClient;
  }),
  PlaidEnvironments: {
    sandbox: "https://sandbox.plaid.test",
    production: "https://production.plaid.test"
  },
  Products: {
    Transactions: "transactions"
  }
}));

const testConfig: PlaidConfig = {
  clientId: "plaid-client-id",
  secret: "plaid-secret",
  environment: "sandbox",
  countryCodes: ["US"],
  products: ["transactions"],
  transactionsDaysRequested: 365,
  personalFinanceCategoryVersion: "v2"
};

function createProviderSettingsMock() {
  return {
    get: vi.fn().mockResolvedValue({
      environment: testConfig.environment,
      sandbox: {
        clientId: testConfig.environment === "sandbox" ? testConfig.clientId : "",
        secret: testConfig.environment === "sandbox" ? testConfig.secret : ""
      },
      production: {
        clientId: testConfig.environment === "production" ? testConfig.clientId : "",
        secret: testConfig.environment === "production" ? testConfig.secret : ""
      },
      countryCodes: testConfig.countryCodes,
      products: testConfig.products,
      transactionsDaysRequested: testConfig.transactionsDaysRequested,
      personalFinanceCategoryVersion: testConfig.personalFinanceCategoryVersion,
      automaticSyncConcurrency: 2
    })
  } as never;
}

describe.sequential("plaid service request options", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    mockPlaidClient.linkTokenCreate.mockReset();
    mockPlaidClient.itemRemove.mockReset();
    mockPlaidClient.accountsGet.mockReset();
    mockPlaidClient.transactionsSync.mockReset();
    mockPlaidClient.webhookVerificationKeyGet.mockReset();
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("requests explicit transaction history when creating a link token", async () => {
    mockPlaidClient.linkTokenCreate.mockResolvedValue({
      data: {
        link_token: "link-token-123"
      }
    });

    const service = createPlaidService({
      config: testConfig,
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: testConfig.environment,
          sandbox: {
            clientId: testConfig.environment === "sandbox" ? testConfig.clientId : "",
            secret: testConfig.environment === "sandbox" ? testConfig.secret : ""
          },
          production: {
            clientId: testConfig.environment === "production" ? testConfig.clientId : "",
            secret: testConfig.environment === "production" ? testConfig.secret : ""
          },
          countryCodes: testConfig.countryCodes,
          products: testConfig.products,
          transactionsDaysRequested: testConfig.transactionsDaysRequested,
          personalFinanceCategoryVersion: testConfig.personalFinanceCategoryVersion,
          automaticSyncConcurrency: 2
        })
      } as never
    });

    const token = await service.createLinkToken("user-123");

    expect(token).toBe("link-token-123");
    expect(mockPlaidClient.linkTokenCreate).toHaveBeenCalledWith({
      client_name: "Actual Sync Hub",
      country_codes: ["US"],
      language: "en",
      products: ["transactions"],
      transactions: {
        days_requested: 365
      },
      user: {
        client_user_id: "user-123"
      }
    });
  });

  it("verifies Plaid webhook signatures against the verification key and raw body hash", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));

    const body = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-123"
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256"
    });
    const jwk = publicKey.export({
      format: "jwk"
    }) as Record<string, string | undefined>;

    mockPlaidClient.webhookVerificationKeyGet.mockResolvedValue({
      data: {
        key: {
          alg: "ES256",
          crv: jwk.crv || "P-256",
          kid: "plaid-key-123",
          kty: jwk.kty || "EC",
          use: "sig",
          x: jwk.x || "",
          y: jwk.y || "",
          created_at: nowSeconds - 60,
          expired_at: null
        }
      }
    });

    const header = Buffer.from(
      JSON.stringify({
        alg: "ES256",
        kid: "plaid-key-123",
        typ: "JWT"
      }),
      "utf8"
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iat: nowSeconds,
        request_body_sha256: crypto.createHash("sha256").update(body).digest("hex")
      }),
      "utf8"
    ).toString("base64url");
    const signedContent = `${header}.${payload}`;
    const signature = crypto
      .sign("sha256", Buffer.from(signedContent, "utf8"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363"
      })
      .toString("base64url");
    const jwt = `${signedContent}.${signature}`;

    const service = createPlaidService({
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.webhooksConfigured()).resolves.toBe(true);
    await expect(service.verifyWebhookSignature(body, jwt)).resolves.toBe(true);
    await expect(service.verifyWebhookSignature(`${body} `, jwt)).resolves.toBe(false);
    expect(mockPlaidClient.webhookVerificationKeyGet).toHaveBeenCalledWith({
      key_id: "plaid-key-123"
    });
  });

  it("rejects malformed Plaid webhook headers before verification", async () => {
    const service = createPlaidService({
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.verifyWebhookSignature("{}", undefined)).resolves.toBe(false);
    await expect(service.verifyWebhookSignature("{}", "not-a-jwt")).resolves.toBe(false);
    await expect(service.verifyWebhookSignature("{}", [
      Buffer.from(JSON.stringify({
        alg: "HS256",
        kid: "plaid-key-123",
        typ: "JWT"
      }), "utf8").toString("base64url"),
      "payload",
      "signature"
    ].join("."))).resolves.toBe(false);
  });

  it("creates a Plaid update-token reauth session for an existing connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    mockPlaidClient.linkTokenCreate.mockResolvedValue({
      data: {
        link_token: "update-link-token-123"
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.createReauthSession!({
      connectionId: connection.id,
      userId: "user-123"
    })).resolves.toEqual({
      provider: "PLAID",
      connectionId: connection.id,
      mode: "plaid_update",
      linkToken: "update-link-token-123"
    });
    expect(mockPlaidClient.linkTokenCreate).toHaveBeenCalledWith({
      access_token: "access-token-123",
      client_name: "Actual Sync Hub",
      country_codes: ["US"],
      language: "en",
      user: {
        client_user_id: "user-123"
      }
    });
  });

  it("requests PFCv2 categories during transaction sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "account-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: JSON.stringify({
          providerSyncState: {
            cursor: "cursor-123"
          }
        })
      }
    });

    mockPlaidClient.transactionsSync.mockResolvedValue({
      data: {
        added: [],
        modified: [],
        removed: [],
        next_cursor: "cursor-456",
        has_more: false
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    const result = await service.syncAccountLink(link.id);

    expect(result.configPatch).toEqual({
      providerSyncState: {
        cursor: "cursor-456",
        windowStartDate: null,
        windowEndDate: null
      }
    });
    expect(mockPlaidClient.transactionsSync).toHaveBeenCalledWith({
      access_token: "access-token-123",
      cursor: "cursor-123",
      options: {
        days_requested: 365,
        include_original_description: true,
        personal_finance_category_version: "v2"
      }
    });
  });

  it("derives notes from Plaid transaction names when they contain useful detail", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "account-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    mockPlaidClient.transactionsSync.mockResolvedValue({
      data: {
        added: [
          {
            account_id: "account-ext-1",
            transaction_id: "txn-1",
            date: "2026-05-03",
            amount: 12.34,
            name: "Coffee Shop Downtown",
            original_description: "Coffee Shop Downtown Terminal 4",
            merchant_name: "Coffee Shop",
            pending: false,
            personal_finance_category: {
              primary: "FOOD_AND_DRINK",
              detailed: "FOOD_AND_DRINK_COFFEE"
            },
            counterparties: []
          },
          {
            account_id: "account-ext-1",
            transaction_id: "txn-2",
            date: "2026-05-04",
            amount: 5,
            name: "AMAZON",
            original_description: "AMAZON",
            merchant_name: "Amazon",
            pending: false,
            personal_finance_category: null,
            counterparties: []
          }
        ],
        modified: [],
        removed: [],
        next_cursor: "cursor-456",
        has_more: false
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    const result = await service.syncAccountLink(link.id);

    expect(result.transactions).toEqual([
      {
        amount: -12.34,
        categoryNames: ["Food And Drink Coffee", "Coffee", "Food And Drink"],
        cleared: true,
        date: "2026-05-03",
        importedId: "txn-1",
        importedPayee: "Coffee Shop Downtown",
        notes: "Downtown Terminal 4",
        payeeName: "Coffee Shop",
        searchText: ["Coffee Shop Downtown", "Coffee Shop Downtown Terminal 4", "Coffee Shop"]
      },
      {
        amount: -5,
        categoryNames: [],
        cleared: true,
        date: "2026-05-04",
        importedId: "txn-2",
        importedPayee: "AMAZON",
        notes: undefined,
        payeeName: "Amazon",
        searchText: ["AMAZON", "Amazon"]
      }
    ]);
  });

  it("classifies invalid Plaid access tokens as provider connection reauth failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123"),
        metadataJson: JSON.stringify({})
      }
    });

    mockPlaidClient.accountsGet.mockRejectedValue({
      message: "Plaid token expired",
      response: {
        data: {
          error_code: "INVALID_ACCESS_TOKEN"
        }
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "INVALID_ACCESS_TOKEN",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "REAUTH_CONNECTION"
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const metadata = JSON.parse(refreshed.metadataJson || "{}");

    expect(refreshed.status).toBe("ERROR");
    expect(metadata.health).toMatchObject({
      state: "REAUTH_REQUIRED",
      scope: "CONNECTION_AUTH",
      action: "REAUTH_CONNECTION",
      code: "INVALID_ACCESS_TOKEN"
    });
  });

  it("classifies Plaid item login required as a bank reauth failure", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "account-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    mockPlaidClient.transactionsSync.mockRejectedValue({
      message: "Plaid item needs login",
      response: {
        data: {
          error_code: "ITEM_LOGIN_REQUIRED"
        }
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.syncAccountLink(link.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "ITEM_LOGIN_REQUIRED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "REAUTH_BANK"
    });
  });

  it("classifies Plaid rate limits as retryable sync pipeline failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123"),
        metadataJson: JSON.stringify({})
      }
    });

    mockPlaidClient.accountsGet.mockRejectedValue({
      message: "Too many requests",
      response: {
        status: 429,
        data: {
          error_code: "RATE_LIMIT_EXCEEDED"
        }
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  });

  it("removes the Plaid item when disconnecting a connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    mockPlaidClient.itemRemove.mockResolvedValue({
      data: {
        request_id: "req-123"
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection?.(connection.id)).resolves.toBeUndefined();
    expect(mockPlaidClient.itemRemove).toHaveBeenCalledWith({
      access_token: "access-token-123"
    });
  });

  it("treats already-removed Plaid items as disconnected during cleanup", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    mockPlaidClient.itemRemove.mockRejectedValue({
      message: "Item not found",
      response: {
        data: {
          error_code: "ITEM_NOT_FOUND"
        }
      }
    });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection?.(connection.id)).resolves.toBeUndefined();
  });

  it("rethrows unexpected Plaid disconnect failures as retryable provider errors", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    mockPlaidClient.itemRemove.mockRejectedValue(new Error("Plaid backend unavailable"));

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.disconnectConnection?.(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY"
    });
  });

  it("retries Plaid transaction sync when pagination mutates mid-stream", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-123",
        accessTokenCiphertext: encryptString("access-token-123")
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "account-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: JSON.stringify({
          providerSyncState: {
            cursor: "cursor-123"
          }
        })
      }
    });

    mockPlaidClient.transactionsSync
      .mockRejectedValueOnce(new Error("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"))
      .mockResolvedValueOnce({
        data: {
          added: [
            {
              account_id: "account-ext-1",
              transaction_id: "txn-1",
              date: "2026-05-04",
              amount: 8.75,
              name: "Bakery",
              original_description: "Bakery Downtown",
              merchant_name: "Bakery",
              pending: false,
              personal_finance_category: {
                primary: "FOOD_AND_DRINK",
                detailed: "FOOD_AND_DRINK_BAKERY"
              },
              counterparties: []
            }
          ],
          modified: [],
          removed: [],
          next_cursor: "cursor-456",
          has_more: false
        }
      });

    const service = createPlaidService({
      prisma,
      config: testConfig,
      providerSettings: createProviderSettingsMock()
    });

    await expect(service.syncAccountLink(link.id)).resolves.toMatchObject({
      imported: 1,
      transactions: [
        expect.objectContaining({
          amount: -8.75,
          cleared: true,
          date: "2026-05-04",
          importedId: "txn-1",
          importedPayee: "Bakery",
          notes: "Downtown",
          payeeName: "Bakery",
          searchText: ["Bakery", "Bakery Downtown"]
        })
      ],
      removedImportedIds: [],
      configPatch: {
        providerSyncState: {
          cursor: "cursor-456",
          windowStartDate: null,
          windowEndDate: null
        }
      }
    });
    expect(mockPlaidClient.transactionsSync).toHaveBeenCalledTimes(2);
    expect(mockPlaidClient.transactionsSync.mock.calls[0]?.[0]).toMatchObject({
      access_token: "access-token-123",
      cursor: "cursor-123"
    });
    expect(mockPlaidClient.transactionsSync.mock.calls[1]?.[0]).toMatchObject({
      access_token: "access-token-123",
      cursor: "cursor-123"
    });
  });
});
