import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { createAppService } from "../services/app-service.js";
import { createAuthService } from "../services/auth.js";
import { createActualService } from "../services/actual-service.js";
import { createHomeValuesService } from "../services/home-values-service.js";
import { plaidService } from "../services/plaid-service.js";
import { createProviderSettingsService } from "../services/provider-settings-service.js";
import { saltEdgeService } from "../services/saltedge-service.js";
import { simplefinService } from "../services/simplefin-service.js";
import { createStripeService } from "../services/stripe-service.js";
import { tellerService } from "../services/teller-service.js";
import { seedActualSandboxBudget } from "../dev/actual-fixture.js";
import { hashPassword } from "../lib/password.js";
import { createServer } from "../server.js";
import { startActualTestContainer } from "../test/actual-container.js";
import { createTestDatabase } from "../test/test-db.js";

const liveEnabled =
  process.env.STRIPE_TEST_RUN_LIVE === "1" &&
  process.env.ACTUAL_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.STRIPE_TEST_PUBLISHABLE_KEY) &&
  Boolean(process.env.STRIPE_TEST_SECRET_KEY) &&
  Boolean(process.env.STRIPE_TEST_CUSTOMER_ID);
const stripeTestEnvironment = process.env.STRIPE_TEST_ENV === "live" ? "live" : "test";

function createStripeApiClient() {
  return new Stripe(process.env.STRIPE_TEST_SECRET_KEY || "", {
    maxNetworkRetries: 2
  });
}

async function listLiveStripeAccounts(customerId: string) {
  const stripe = createStripeApiClient();
  const accounts: Stripe.FinancialConnections.Account[] = [];

  for await (const account of stripe.financialConnections.accounts.list({
    account_holder: {
      customer: customerId
    },
    limit: 100
  })) {
    accounts.push(account);
  }

  return accounts;
}

function selectStripeConnectionAccountGroup(accounts: Stripe.FinancialConnections.Account[]) {
  const activeAccounts = accounts.filter(account => account.status === "active" && Boolean(account.id));
  const preferredAccountId = process.env.STRIPE_TEST_ACCOUNT_ID;
  const selectedAccount =
    (preferredAccountId
      ? activeAccounts.find(account => account.id === preferredAccountId)
      : undefined) ??
    activeAccounts.sort((left, right) => right.created - left.created)[0];

  if (!selectedAccount?.id) {
    throw new Error("No active Stripe Financial Connections accounts were found for STRIPE_TEST_CUSTOMER_ID.");
  }

  const groupedAccountIds = selectedAccount.authorization
    ? activeAccounts
        .filter(account => account.authorization === selectedAccount.authorization && account.id)
        .map(account => account.id!)
    : [selectedAccount.id];

  return {
    selectedAccountId: selectedAccount.id,
    accountIds: [...new Set(groupedAccountIds)]
  };
}

describe.skipIf(!liveEnabled)("stripe full live integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("syncs a live Stripe connection into a real Actual budget through the app routes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const password = process.env.ACTUAL_TEST_PASSWORD || "actual-test-password";
    const container = await startActualTestContainer();
    cleanups.push(() => container.stop());
    await container.setPassword(password);

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-stripe-full-live-"));
    cleanups.push(() => fs.rm(cacheDir, { recursive: true, force: true }));

    const seed = await seedActualSandboxBudget({
      serverURL: container.serverURL,
      password,
      dataDir: path.join(cacheDir, "seed")
    });

    await prisma.user.create({
      data: {
        username: "admin",
        passwordHash: await hashPassword("super-secret-password")
      }
    });

    const actualService = createActualService({
      config: {
        serverURL: container.serverURL,
        password,
        budgetSyncId: seed.syncId,
        dataDir: path.join(cacheDir, "service")
      }
    });
    cleanups.push(() => actualService.shutdown?.() ?? Promise.resolve());

    const providerSettingsService = createProviderSettingsService({
      prisma
    });
    const stripeService = createStripeService({
      prisma,
      providerSettings: providerSettingsService
    });
    const appService = createAppService({
      prisma,
      actualService,
      providerSettingsService,
      plaidService,
      saltEdgeService,
      simplefinService,
      stripeService,
      tellerService,
      runtime: {
        instanceLabel: "Stripe live integration test",
        liveSandboxMode: stripeTestEnvironment === "test",
        actualServerUrl: container.serverURL,
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });
    const homeValuesService = createHomeValuesService({
      prisma,
      providerSettings: providerSettingsService
    });
    const authService = createAuthService({
      prisma
    });

    const app = await createServer({
      sessionSecret: "0123456789abcdef0123456789abcdef",
      nodeEnv: "test",
      enableStatic: false,
      context: {
        prisma,
        actualService,
        homeValuesService,
        plaidService,
        providerSettingsService,
        saltEdgeService,
        simplefinService,
        stripeService,
        tellerService,
        appService,
        authService
      }
    });
    cleanups.push(() => app.close());

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        username: "admin",
        password: "super-secret-password"
      }
    });
    expect(login.statusCode).toBe(200);
    const sessionCookie = login.cookies.find(cookie => cookie.name.startsWith("sessionId"));
    const cookies = sessionCookie ? { [sessionCookie.name]: sessionCookie.value } : {};

    const updateStripeSettingsResponse = await app.inject({
      method: "PUT",
      url: "/api/provider-settings/STRIPE",
      cookies,
      payload: {
        environment: stripeTestEnvironment,
        test: {
          publishableKey: stripeTestEnvironment === "test" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
          secretKey: stripeTestEnvironment === "test" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
          webhookSigningSecrets:
            stripeTestEnvironment === "test"
              ? (process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS || "").split(",").map(value => value.trim()).filter(Boolean)
              : []
        },
        live: {
          publishableKey: stripeTestEnvironment === "live" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
          secretKey: stripeTestEnvironment === "live" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
          webhookSigningSecrets:
            stripeTestEnvironment === "live"
              ? (process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS || "").split(",").map(value => value.trim()).filter(Boolean)
              : []
        },
        countryCodes: ["US"],
        permissions: ["balances", "transactions"],
        prefetch: ["balances", "transactions"],
        transactionsInitialDays: 90,
        automaticSyncConcurrency: 2
      }
    });
    expect(updateStripeSettingsResponse.statusCode).toBe(200);

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/stripe/session",
      cookies
    });
    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json<{
      sessionId: string;
      clientSecret: string;
      publishableKey: string;
    }>();
    expect(session.sessionId).toMatch(/^fcsess_/);
    expect(session.clientSecret).toMatch(/\S/);
    expect(session.publishableKey).toBe(process.env.STRIPE_TEST_PUBLISHABLE_KEY);

    const liveAccounts = await listLiveStripeAccounts(process.env.STRIPE_TEST_CUSTOMER_ID || "");
    const { selectedAccountId, accountIds } = selectStripeConnectionAccountGroup(liveAccounts);

    const finalizeConnectionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/stripe/finalize",
      cookies,
      payload: {
        label: "Stripe Integration Account",
        accountIds
      }
    });
    expect(finalizeConnectionResponse.statusCode).toBe(200);
    const { connectionId } = finalizeConnectionResponse.json<{ connectionId: string }>();

    const reauthResponse = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/reauth-session`,
      cookies
    });
    expect(reauthResponse.statusCode).toBe(200);
    const reauth = reauthResponse.json<{ mode: string; sessionId?: string; clientSecret?: string; publishableKey?: string }>();
    expect(["stripe_relink", "manual"]).toContain(reauth.mode);
    if (reauth.mode === "stripe_relink") {
      expect(reauth.sessionId).toMatch(/^fcsess_/);
      expect(reauth.clientSecret).toMatch(/\S/);
      expect(reauth.publishableKey).toBe(process.env.STRIPE_TEST_PUBLISHABLE_KEY);
    }

    const connectionsResponse = await app.inject({
      method: "GET",
      url: "/api/connections",
      cookies
    });
    expect(connectionsResponse.statusCode).toBe(200);
    const connections = connectionsResponse.json<Array<{
      id: string;
      provider: string;
      accounts: Array<{ id: string; externalAccountId: string }>;
    }>>();
    const connection = connections.find(entry => entry.id === connectionId);
    expect(connection?.provider).toBe("STRIPE");
    expect(connection?.accounts.length).toBeGreaterThan(0);
    const providerAccount = connection?.accounts.find(account => account.externalAccountId === selectedAccountId) ?? connection?.accounts[0];
    expect(providerAccount).toBeTruthy();

    const actualAccountsResponse = await app.inject({
      method: "GET",
      url: "/api/actual/accounts",
      cookies
    });
    expect(actualAccountsResponse.statusCode).toBe(200);
    const actualAccounts = actualAccountsResponse.json<Array<{ id: string; name: string; closed?: boolean }>>();
    const actualAccount = actualAccounts.find(account => account.name === "Sandbox Checking" && !account.closed) ?? actualAccounts[0];
    expect(actualAccount).toBeTruthy();
    if (!actualAccount || !providerAccount) {
      throw new Error("Expected a seeded Actual account and Stripe provider account");
    }

    const linkResponse = await app.inject({
      method: "PUT",
      url: `/api/account-links/${actualAccount.id}`,
      cookies,
      payload: {
        actualAccountName: actualAccount.name,
        assetType: "BANK",
        provider: "STRIPE",
        connectionId,
        connectionAccountId: providerAccount.id,
        syncFrequency: "MANUAL",
        syncHour: null,
        syncDayOfWeek: null,
        isEnabled: true
      }
    });
    expect(linkResponse.statusCode).toBe(200);

    const syncResponse = await app.inject({
      method: "POST",
      url: `/api/account-links/${actualAccount.id}/sync`,
      cookies
    });
    expect(syncResponse.statusCode).toBe(200);

    const syncRunsResponse = await app.inject({
      method: "GET",
      url: "/api/sync-runs",
      cookies
    });
    expect(syncRunsResponse.statusCode).toBe(200);
    const syncRuns = syncRunsResponse.json<Array<{ status: string; summary?: string | null }>>();
    expect(syncRuns[0]?.status).toBe("SUCCESS");
    expect(syncRuns[0]?.summary).toMatch(/^Imported \d+ transactions, updated \d+, removed \d+\.$/);

    const persistedLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: actualAccount.id,
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });
    expect(persistedLink.lastSyncedAt).toBeTruthy();
  }, 180_000);
});
