import { vi } from "vitest";
import { createServer } from "./server.js";

type AppUnderTest = Awaited<ReturnType<typeof createServer>>;

export function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {} as never,
    actualService: {} as never,
    authService: {
      authenticateUser: vi.fn(),
      ...(overrides.authService as object | undefined)
    },
    appService: {
      getRuntimeInfo: vi.fn(),
      listConnections: vi.fn(),
      listActualAccounts: vi.fn(),
      listActualBankSyncLinks: vi.fn(),
      importExistingSimpleFinLinks: vi.fn(),
      createConnectionReauthSession: vi.fn(),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      refreshAllConnections: vi.fn(),
      upsertAccountLink: vi.fn(),
      runAccountSync: vi.fn(),
      runScheduledLinkSyncs: vi.fn(),
      handleTellerWebhook: vi.fn(),
      previewAccountSyncReview: vi.fn(),
      commitAccountSyncReview: vi.fn(),
      listSyncRuns: vi.fn(),
      ...(overrides.appService as object | undefined)
    },
    plaidService: {
      provider: "PLAID" as const,
      isConfigured: vi.fn().mockReturnValue(true),
      createLinkToken: vi.fn(),
      createUpdateLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      seedSandboxConnection: vi.fn(),
      seedSandboxTransactions: vi.fn(),
      ...(overrides.plaidService as object | undefined)
    },
    tellerService: {
      provider: "TELLER" as const,
      isConfigured: vi.fn().mockReturnValue(false),
      webhooksConfigured: vi.fn().mockReturnValue(false),
      verifyWebhookSignature: vi.fn().mockReturnValue(false),
      getConnectConfig: vi.fn(),
      getReauthConfig: vi.fn(),
      enrollConnection: vi.fn(),
      reuseCachedConnection: vi.fn(),
      seedSandboxConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.tellerService as object | undefined)
    },
    simplefinService: {
      provider: "SIMPLEFIN" as const,
      isConfigured: vi.fn().mockReturnValue(true),
      connectSetupToken: vi.fn(),
      reuseCachedConnection: vi.fn(),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.simplefinService as object | undefined)
    }
  };
}

export function createTrackedApps() {
  const apps: AppUnderTest[] = [];

  return {
    track(app: AppUnderTest) {
      apps.push(app);
      return app;
    },
    async cleanup() {
      await Promise.all(apps.splice(0).map(app => app.close()));
    }
  };
}

export async function loginAsAdmin(app: AppUnderTest) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      username: "admin",
      password: "secret"
    }
  });
  const cookie = login.cookies.find(entry => entry.name.startsWith("sessionId"));
  return cookie ? { [cookie.name]: cookie.value } : {};
}
