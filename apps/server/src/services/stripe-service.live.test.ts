import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createStripeService } from "./stripe-service.js";

const credentialsEnabled =
  process.env.STRIPE_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.STRIPE_TEST_PUBLISHABLE_KEY) &&
  Boolean(process.env.STRIPE_TEST_SECRET_KEY);
const stripeTestCustomerId = process.env.STRIPE_TEST_CUSTOMER_ID || "";
const finalizedAccountEnabled = credentialsEnabled && Boolean(stripeTestCustomerId);
const stripeTestEnvironment = process.env.STRIPE_TEST_ENV === "live" ? "live" : "test";

function createStripeApiClient() {
  return new Stripe(process.env.STRIPE_TEST_SECRET_KEY || "", {
    maxNetworkRetries: 2
  });
}

async function listLiveStripeAccountIds(customerId: string) {
  const stripe = createStripeApiClient();
  const accountIds: string[] = [];

  for await (const account of stripe.financialConnections.accounts.list({
    account_holder: {
      customer: customerId
    },
    limit: 100
  })) {
    if (account.id) {
      accountIds.push(account.id);
    }
  }

  return [...new Set(accountIds)];
}

function createLiveStripeService(prisma: Awaited<ReturnType<typeof createTestDatabase>>["prisma"]) {
  return createStripeService({
    prisma,
    providerSettings: {
      get: async () => ({
        environment: stripeTestEnvironment,
        test: {
          publishableKey: stripeTestEnvironment === "test" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
          secretKey: stripeTestEnvironment === "test" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
          webhookSigningSecrets:
            stripeTestEnvironment === "test"
              ? (process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS || "")
                  .split(",")
                  .map(value => value.trim())
                  .filter(Boolean)
              : []
        },
        live: {
          publishableKey: stripeTestEnvironment === "live" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
          secretKey: stripeTestEnvironment === "live" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
          webhookSigningSecrets:
            stripeTestEnvironment === "live"
              ? (process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS || "")
                  .split(",")
                  .map(value => value.trim())
                  .filter(Boolean)
              : []
        },
        countryCodes: ["US"],
        permissions: ["balances", "transactions"],
        prefetch: ["balances", "transactions"],
        transactionsInitialDays: 90,
        automaticSyncConcurrency: 2
      })
    } as never
  });
}

describe.skipIf(!credentialsEnabled)("stripe service live", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates a live Stripe Financial Connections session", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createLiveStripeService(prisma);
    const session = await service.createConnectSession("stripe-live-test-user");

    expect(session.sessionId).toMatch(/^fcsess_/);
    expect(session.clientSecret).toMatch(/\S/);
    expect(session.publishableKey).toBe(process.env.STRIPE_TEST_PUBLISHABLE_KEY);
  }, 30_000);

  it.skipIf(!finalizedAccountEnabled)("finalizes, refreshes, reauths, and syncs a live Stripe connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createLiveStripeService(prisma);
    const accountIds = await listLiveStripeAccountIds(stripeTestCustomerId);
    expect(accountIds.length).toBeGreaterThan(0);

    const finalized = await service.finalizeAccounts({
      accountIds,
      label: "Codex Stripe Live"
    });

    const hydratedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: finalized.connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(hydratedConnection.provider).toBe("STRIPE");
    expect(hydratedConnection.accounts.length).toBeGreaterThan(0);

    await service.refreshConnection(hydratedConnection.id);

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: hydratedConnection.id
      },
      include: {
        accounts: true
      }
    });
    expect(refreshedConnection.accounts.length).toBeGreaterThan(0);

    if (typeof service.createReauthSession !== "function") {
      throw new Error("Stripe service does not expose reauth support");
    }

    const reauth = await service.createReauthSession({
      connectionId: refreshedConnection.id,
      userId: "stripe-live-test-user"
    });
    expect(["stripe_relink", "manual"]).toContain(reauth.mode);
    if (reauth.mode === "stripe_relink") {
      expect(reauth.sessionId).toMatch(/^fcsess_/);
      expect(reauth.clientSecret).toMatch(/\S/);
      expect(reauth.publishableKey).toBe(process.env.STRIPE_TEST_PUBLISHABLE_KEY);
    }

    const externalAccountId = process.env.STRIPE_TEST_ACCOUNT_ID;
    const account =
      (externalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === externalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-stripe-1",
        actualAccountName: "Stripe Live Account",
        assetType: "BANK",
        provider: "STRIPE",
        connectionId: refreshedConnection.id,
        connectionAccountId: account!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const syncResult = await service.syncAccountLink(link.id);

    expect(syncResult.imported).toBe(syncResult.transactions.length);
    expect(syncResult.transactions.every(transaction => Boolean(transaction.importedId))).toBe(true);
  }, 90_000);
});
