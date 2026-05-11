import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppService } from "../services/app-service.js";
import { createAuthService } from "../services/auth.js";
import { createActualService } from "../services/actual-service.js";
import { createHomeValuesService } from "../services/home-values-service.js";
import { belvoService } from "../services/belvo-service.js";
import { createPlaidService } from "../services/plaid-service.js";
import { createProviderSettingsService } from "../services/provider-settings-service.js";
import { simplefinService } from "../services/simplefin-service.js";
import { createTellerService } from "../services/teller-service.js";
import { seedActualSandboxBudget } from "../dev/actual-fixture.js";
import { hashPassword } from "../lib/password.js";
import { createServer } from "../server.js";
import { startActualTestContainer } from "../test/actual-container.js";
import { createTestDatabase } from "../test/test-db.js";

const liveEnabled =
  process.env.FULL_SYNC_TEST_RUN_LIVE === "1" &&
  process.env.ACTUAL_TEST_RUN_LIVE === "1" &&
  process.env.PLAID_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.PLAID_TEST_CLIENT_ID) &&
  Boolean(process.env.PLAID_TEST_SECRET);

const plaidTestConfig = {
  clientId: "",
  secret: "",
  environment: (process.env.PLAID_TEST_ENV || "sandbox") as "sandbox" | "production",
  countryCodes: ["US"],
  products: ["transactions"],
  transactionsDaysRequested: 365,
  personalFinanceCategoryVersion: "v2" as const
};

describe.skipIf(!liveEnabled)("full live sync integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("syncs Plaid sandbox transactions into a real Actual budget through the app routes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const password = process.env.ACTUAL_TEST_PASSWORD || "actual-test-password";
    const container = await startActualTestContainer();
    cleanups.push(() => container.stop());
    await container.setPassword(password);

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-full-sync-live-"));
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
    const plaidService = createPlaidService({
      prisma,
      config: plaidTestConfig
    });
    const tellerService = createTellerService({
      config: {
        appId: "",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      }
    });
    const appService = createAppService({
      prisma,
      actualService,
      plaidService,
      tellerService,
      runtime: {
        instanceLabel: "Live integration test",
        liveSandboxMode: true,
        actualServerUrl: container.serverURL,
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });
    const providerSettingsService = createProviderSettingsService({
      prisma
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
        belvoService,
        plaidService,
        providerSettingsService,
        simplefinService,
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

    const updatePlaidSettingsResponse = await app.inject({
      method: "PUT",
      url: "/api/provider-settings/PLAID",
      cookies,
      payload: {
        environment: plaidTestConfig.environment,
        sandbox: {
          clientId: plaidTestConfig.environment === "sandbox" ? process.env.PLAID_TEST_CLIENT_ID || "" : "",
          secret: plaidTestConfig.environment === "sandbox" ? process.env.PLAID_TEST_SECRET || "" : ""
        },
        production: {
          clientId: plaidTestConfig.environment === "production" ? process.env.PLAID_TEST_CLIENT_ID || "" : "",
          secret: plaidTestConfig.environment === "production" ? process.env.PLAID_TEST_SECRET || "" : ""
        },
        countryCodes: plaidTestConfig.countryCodes,
        products: plaidTestConfig.products,
        transactionsDaysRequested: plaidTestConfig.transactionsDaysRequested,
        personalFinanceCategoryVersion: plaidTestConfig.personalFinanceCategoryVersion,
        automaticSyncConcurrency: 2
      }
    });
    expect(updatePlaidSettingsResponse.statusCode).toBe(200);

    const seedConnectionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/plaid/sandbox/seed-connection",
      cookies,
      payload: {
        label: "Integration Sandbox Bank"
      }
    });
    expect(seedConnectionResponse.statusCode).toBe(200);
    const { connectionId } = seedConnectionResponse.json<{ connectionId: string }>();

    const connectionsResponse = await app.inject({
      method: "GET",
      url: "/api/connections",
      cookies
    });
    expect(connectionsResponse.statusCode).toBe(200);
    const connections = connectionsResponse.json<Array<{
      id: string;
      accounts: Array<{ id: string; type: string; subtype?: string | null }>;
    }>>();
    const connection = connections.find(entry => entry.id === connectionId);
    expect(connection).toBeTruthy();
    const providerAccount = connection?.accounts.find(account => account.type === "depository") ?? connection?.accounts[0];
    expect(providerAccount).toBeTruthy();

    const seedTransactionsResponse = await app.inject({
      method: "POST",
      url: `/api/connections/${connectionId}/plaid/sandbox/seed-transactions`,
      cookies,
      payload: {
        count: 3
      }
    });
    expect(seedTransactionsResponse.statusCode).toBe(200);

    const actualAccountsResponse = await app.inject({
      method: "GET",
      url: "/api/actual/accounts",
      cookies
    });
    expect(actualAccountsResponse.statusCode).toBe(200);
    const actualAccounts = actualAccountsResponse.json<Array<{ id: string; name: string }>>();
    const actualAccount = actualAccounts.find(account => account.name === "Sandbox Checking");
    expect(actualAccount).toBeTruthy();
    if (!actualAccount) {
      throw new Error("Sandbox Checking account was not seeded into Actual");
    }
    const linkResponse = await app.inject({
      method: "PUT",
      url: `/api/account-links/${actualAccount.id}`,
      cookies,
      payload: {
        actualAccountName: actualAccount.name,
        assetType: "BANK",
        provider: "PLAID",
        connectionId,
        connectionAccountId: providerAccount!.id,
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
    expect(syncRuns[0]?.summary).toMatch(/^Imported [1-9]\d* transactions, updated \d+, removed \d+\.$/);

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
