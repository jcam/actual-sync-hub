import { vi } from "vitest";
import { type createServer } from "./server.js";

type AppUnderTest = Awaited<ReturnType<typeof createServer>>;

export function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {} as never,
    actualService: {
      shutdown: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue({
        externalSyncWritebackEnabled: false
      }),
      listAccounts: vi.fn(),
      listCategories: vi.fn(),
      listBankSyncLinks: vi.fn(),
      linkExternalSyncAccount: vi.fn(),
      unlinkExternalSyncAccount: vi.fn(),
      listTransactionsByDateRange: vi.fn(),
      importTransactions: vi.fn(),
      previewImportTransactions: vi.fn(),
      reconcileTransactions: vi.fn(),
      ...(overrides.actualService as object | undefined)
    },
    authService: {
      authenticateUser: vi.fn(),
      validateActualToken: vi.fn().mockResolvedValue(true),
      ...(overrides.authService as object | undefined)
    },
    appService: {
      getRuntimeInfo: vi.fn().mockResolvedValue({
        instanceLabel: "Test",
        liveSandboxMode: false,
        providers: [],
        settings: {
          PLAID: {
            environment: "sandbox",
            sandbox: {
              clientId: "",
              secret: ""
            },
            production: {
              clientId: "",
              secret: ""
            },
            countryCodes: ["US"],
            products: ["transactions"],
            transactionsDaysRequested: 365,
            personalFinanceCategoryVersion: "v2",
            automaticSyncConcurrency: 2
          },
          TELLER: {
            environment: "sandbox",
            sandbox: {
              appId: "",
              sandboxAccessToken: ""
            },
            development: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            production: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            transactionsInitialDays: 90,
            transactionsOverlapDays: 10,
            automaticSyncConcurrency: 2,
            webhookSyncDebounceSeconds: 30
          },
          SIMPLEFIN: {
            mode: "sandbox",
            development: {
              serverUrl: ""
            },
            transactionsInitialDays: 45,
            automaticSyncConcurrency: 1
          }
        },
        plaid: {
          enabled: true,
          environment: "sandbox",
          sandboxToolsEnabled: false
        },
        teller: {
          enabled: false,
          environment: "sandbox",
          mtlsConfigured: false
        },
        simplefin: {
          enabled: true,
          mode: "sandbox",
          requiresSetupToken: true
        },
        actual: {
          serverUrl: "http://localhost:5006",
          budgetSyncIdConfigured: true,
          externalSyncWritebackEnabled: false
        }
      }),
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
      getExternalSyncBridgeStatus: vi.fn(),
      runExternalSyncBridgeSync: vi.fn(),
      ...(overrides.appService as object | undefined)
    },
    providerSettingsService: {
      getAll: vi.fn().mockResolvedValue({
        PLAID: {
          environment: "sandbox",
          sandbox: {
            clientId: "",
            secret: ""
          },
          production: {
            clientId: "",
            secret: ""
          },
          countryCodes: ["US"],
          products: ["transactions"],
          transactionsDaysRequested: 365,
          personalFinanceCategoryVersion: "v2",
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: {
            appId: "",
            sandboxAccessToken: ""
          },
          development: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          production: {
            appId: "",
            certificatePem: "",
            keyPem: "",
            webhookSigningSecrets: []
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 2,
          webhookSyncDebounceSeconds: 30
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        }
      }),
      get: vi.fn(),
      update: vi.fn(),
      ...(overrides.providerSettingsService as object | undefined)
    },
    plaidService: {
      provider: "PLAID" as const,
      isConfigured: vi.fn().mockReturnValue(true),
      createLinkToken: vi.fn(),
      createUpdateLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      disconnectConnection: vi.fn(),
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
      disconnectConnection: vi.fn(),
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
