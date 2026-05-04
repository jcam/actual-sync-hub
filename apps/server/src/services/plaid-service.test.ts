import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";

const mockPlaidClient = vi.hoisted(() => ({
  linkTokenCreate: vi.fn(),
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
        itemId: "item-123",
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
          plaidCursor: "cursor-123"
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

    expect(result.nextCursor).toBe("cursor-456");
    expect(mockPlaidClient.transactionsSync).toHaveBeenCalledWith({
      access_token: "access-token-123",
      cursor: "cursor-123",
      options: {
        days_requested: 365,
        personal_finance_category_version: "v2"
      }
    });
  });
});
