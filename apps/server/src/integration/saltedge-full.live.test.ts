import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppService } from "../services/app-service.js";
import { createAuthService } from "../services/auth.js";
import { createActualService } from "../services/actual-service.js";
import { createHomeValuesService } from "../services/home-values-service.js";
import { createProviderSettingsService } from "../services/provider-settings-service.js";
import { createSaltEdgeService } from "../services/saltedge-service.js";
import { simplefinService } from "../services/simplefin-service.js";
import { tellerService } from "../services/teller-service.js";
import { plaidService } from "../services/plaid-service.js";
import { seedActualSandboxBudget } from "../dev/actual-fixture.js";
import { hashPassword } from "../lib/password.js";
import { createServer } from "../server.js";
import { startActualTestContainer } from "../test/actual-container.js";
import { createTestDatabase } from "../test/test-db.js";

const liveEnabled =
  process.env.SALT_EDGE_TEST_RUN_LIVE === "1" &&
  process.env.ACTUAL_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.SALT_EDGE_TEST_APP_ID) &&
  Boolean(process.env.SALT_EDGE_TEST_SECRET) &&
  Boolean(process.env.SALT_EDGE_TEST_CONNECTION_ID);

const saltEdgeTestEnvironment =
  process.env.SALT_EDGE_TEST_ENVIRONMENT === "sandbox" ||
  process.env.SALT_EDGE_TEST_ENVIRONMENT === "test" ||
  process.env.SALT_EDGE_TEST_ENVIRONMENT === "production"
    ? process.env.SALT_EDGE_TEST_ENVIRONMENT
    : "sandbox";

describe.skipIf(!liveEnabled)("saltedge full live integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("syncs a live Salt Edge connection into a real Actual budget through the app routes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const password = process.env.ACTUAL_TEST_PASSWORD || "actual-test-password";
    const container = await startActualTestContainer();
    cleanups.push(() => container.stop());
    await container.setPassword(password);

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-saltedge-full-live-"));
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
    const saltEdgeService = createSaltEdgeService({
      prisma,
      fetchImpl: fetch,
      providerSettings: providerSettingsService
    });
    const appService = createAppService({
      prisma,
      actualService,
      providerSettingsService,
      saltEdgeService,
      plaidService,
      simplefinService,
      tellerService,
      runtime: {
        instanceLabel: "Salt Edge live integration test",
        liveSandboxMode: false,
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

    const updateSaltEdgeSettingsResponse = await app.inject({
      method: "PUT",
      url: "/api/provider-settings/SALT_EDGE",
      cookies,
      payload: {
        environment: saltEdgeTestEnvironment,
        appId: process.env.SALT_EDGE_TEST_APP_ID || "",
        secret: process.env.SALT_EDGE_TEST_SECRET || "",
        consentDays: 90,
        transactionsFetchDays: 90,
        automaticSyncConcurrency: 2
      }
    });
    expect(updateSaltEdgeSettingsResponse.statusCode).toBe(200);

    const connectSessionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/saltedge/connect-session",
      cookies,
      payload: {
        label: "Codex Salt Edge Integration"
      }
    });
    expect(connectSessionResponse.statusCode).toBe(200);
    const connectSession = connectSessionResponse.json<{
      connectUrl: string;
      expiresAt: string;
      customerId: string;
    }>();
    expect(connectSession.connectUrl).toContain("saltedge.com");
    expect(connectSession.customerId).toMatch(/\S/);

    const finalizeConnectionResponse = await app.inject({
      method: "POST",
      url: "/api/connections/saltedge/finalize",
      cookies,
      payload: {
        connectionId: process.env.SALT_EDGE_TEST_CONNECTION_ID || "",
        connectionSecret: process.env.SALT_EDGE_TEST_CONNECTION_SECRET || undefined,
        customerId: process.env.SALT_EDGE_TEST_CUSTOMER_ID || undefined,
        label: "Salt Edge Integration Account"
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
    const reauth = reauthResponse.json<{ mode: string; connectUrl?: string }>();
    expect(reauth.mode).toBe("saltedge_connect");
    expect(reauth.connectUrl).toContain("saltedge.com");

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
    expect(connection?.provider).toBe("SALT_EDGE");
    expect(connection?.accounts.length).toBeGreaterThan(0);
    const providerAccount =
      (process.env.SALT_EDGE_TEST_ACCOUNT_ID
        ? connection?.accounts.find(account => account.externalAccountId === process.env.SALT_EDGE_TEST_ACCOUNT_ID)
        : undefined) ?? connection?.accounts[0];
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
      throw new Error("Expected a seeded Actual account and Salt Edge provider account");
    }

    const linkResponse = await app.inject({
      method: "PUT",
      url: `/api/account-links/${actualAccount.id}`,
      cookies,
      payload: {
        actualAccountName: actualAccount.name,
        assetType: "BANK",
        provider: "SALT_EDGE",
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
