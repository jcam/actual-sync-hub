import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";

const mockPlaidClient = vi.hoisted(() => ({
  linkTokenCreate: vi.fn(),
  accountsGet: vi.fn(),
  transactionsSync: vi.fn()
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

import { createPlaidService, type PlaidConfig } from "./plaid-service.js";

const testConfig: PlaidConfig = {
  clientId: "plaid-client-id",
  secret: "plaid-secret",
  environment: "sandbox",
  countryCodes: ["US"],
  products: ["transactions"],
  transactionsDaysRequested: 365,
  personalFinanceCategoryVersion: "v2"
};

describe("plaid service request options", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    mockPlaidClient.linkTokenCreate.mockReset();
    mockPlaidClient.accountsGet.mockReset();
    mockPlaidClient.transactionsSync.mockReset();
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("requests explicit transaction history when creating a link token", async () => {
    mockPlaidClient.linkTokenCreate.mockResolvedValue({
      data: {
        link_token: "link-token-123"
      }
    });

    const service = createPlaidService({
      config: testConfig
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
      config: testConfig
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
        personal_finance_category_version: "v2"
      }
    });
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
      config: testConfig
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
      config: testConfig
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
      config: testConfig
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  });
});
