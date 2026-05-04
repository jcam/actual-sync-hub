import { afterEach, describe, expect, it } from "vitest";
import { Configuration, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { decryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";
import { createPlaidService } from "./plaid-service.js";

const liveEnabled =
  process.env.PLAID_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.PLAID_TEST_CLIENT_ID) &&
  Boolean(process.env.PLAID_TEST_SECRET);

const plaidTestConfig = {
  clientId: process.env.PLAID_TEST_CLIENT_ID || "",
  secret: process.env.PLAID_TEST_SECRET || "",
  environment: (process.env.PLAID_TEST_ENV || "sandbox") as "sandbox" | "production",
  countryCodes: ["US"],
  products: ["transactions"],
  transactionsDaysRequested: 365,
  personalFinanceCategoryVersion: "v2" as const
};

function createSandboxClient() {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[plaidTestConfig.environment],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": plaidTestConfig.clientId,
          "PLAID-SECRET": plaidTestConfig.secret
        }
      }
    })
  );
}

async function createSandboxTransactions(accessToken: string) {
  const serverUrl = PlaidEnvironments[plaidTestConfig.environment];
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch(`${serverUrl}/sandbox/transactions/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": plaidTestConfig.clientId,
      "PLAID-SECRET": plaidTestConfig.secret
    },
    body: JSON.stringify({
      access_token: accessToken,
      transactions: [
        {
          amount: 12.34,
          date_posted: today,
          date_transacted: today,
          description: "Codex Sandbox Test"
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create sandbox transactions: ${response.status} ${await response.text()}`);
  }
}

async function createSandboxPublicToken() {
  const client = createSandboxClient();
  const response = await client.sandboxPublicTokenCreate({
    institution_id: "ins_109508",
    initial_products: [Products.Transactions],
    options: {
      webhook: "https://example.com/webhooks/plaid",
      override_username: "user_transactions_dynamic",
      override_password: "test-password"
    }
  });

  return response.data.public_token;
}

describe.skipIf(!liveEnabled)("plaid service live sandbox", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("exchanges a sandbox public token and syncs posted transactions", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createPlaidService({
      prisma,
      config: plaidTestConfig
    });

    const publicToken = await createSandboxPublicToken();
    const connectionId = await service.exchangePublicToken(publicToken, "Sandbox test connection");
    const connectionWithToken = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      }
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });

    await createSandboxTransactions(decryptString(connectionWithToken.accessTokenCiphertext));

    const connectionAccount = connection.accounts.find(account => account.type === "depository") ?? connection.accounts[0];
    expect(connectionAccount).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const result = await service.syncAccountLink(link.id);

    expect(connection.accounts.length).toBeGreaterThan(0);
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.transactions.every(transaction => transaction.importedId)).toBe(true);
  }, 20_000);
});
