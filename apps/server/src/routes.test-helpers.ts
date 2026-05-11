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
      getAccountBalance: vi.fn(),
      listCategories: vi.fn(),
      listBankSyncLinks: vi.fn(),
      getExternalSyncAccount: vi.fn(),
      linkExternalSyncAccount: vi.fn(),
      unlinkExternalSyncAccount: vi.fn(),
      listTransactionsByDateRange: vi.fn(),
      importTransactions: vi.fn(),
      previewImportTransactions: vi.fn(),
      reconcileTransactions: vi.fn(),
      ...(overrides.actualService as object | undefined)
    },
    scheduler: {
      requestWakeup: vi.fn(),
      requestWakeupForAccounts: vi.fn(),
      ...(overrides.scheduler as object | undefined)
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
          STRIPE: {
            environment: "test",
            test: {
              publishableKey: "",
              secretKey: ""
            },
            live: {
              publishableKey: "",
              secretKey: ""
            },
            countryCodes: ["US"],
            permissions: ["balances", "transactions"],
            prefetch: ["balances", "transactions"],
            transactionsInitialDays: 90,
            automaticSyncConcurrency: 2
          },
          TELLER: {
            environment: "sandbox",
            sandbox: {
              appId: "",
              sandboxAccessToken: "",
              webhookSigningSecrets: []
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
            webhookSyncDebounceSeconds: 30,
            webhookToleranceSeconds: 180
          },
          MONO: {
            environment: "sandbox",
            sandbox: {
              publicKey: "",
              secretKey: "",
              webhookSecret: ""
            },
            production: {
              publicKey: "",
              secretKey: "",
              webhookSecret: ""
            },
            transactionsInitialDays: 90,
            transactionsOverlapDays: 10,
            automaticSyncConcurrency: 1
          },
          SIMPLEFIN: {
            mode: "sandbox",
            development: {
              serverUrl: ""
            },
            transactionsInitialDays: 45,
            automaticSyncConcurrency: 1
          },
          BELVO: {
            environment: "sandbox",
            sandbox: {
              secretId: "",
              secretPassword: ""
            },
            production: {
              secretId: "",
              secretPassword: ""
            },
            transactionsInitialDays: 90,
            transactionsOverlapDays: 7,
            automaticSyncConcurrency: 2
          },
          HOME_VALUES: {
            automaticSyncConcurrency: 1,
            redfinFetchMethod: "curl",
            movotoFetchMethod: "curl",
            homesFetchMethod: "wget",
            truliaFetchMethod: "wget"
          },
          VEHICLE_VALUES: {
            automaticSyncConcurrency: 1
          }
        },
        plaid: {
          enabled: true,
          environment: "sandbox",
          sandboxToolsEnabled: false
        },
        stripe: {
          enabled: false,
          environment: "test",
          publishableKeyConfigured: false,
          secretKeyConfigured: false
        },
        teller: {
          enabled: false,
          environment: "sandbox",
          mtlsConfigured: false
        },
        mono: {
          enabled: false,
          environment: "sandbox",
          publicKeyConfigured: false,
          secretKeyConfigured: false,
          webhooksConfigured: false
        },
        simplefin: {
          enabled: true,
          mode: "sandbox",
          requiresSetupToken: true
        },
        belvo: {
          enabled: false,
          environment: "sandbox"
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
      createHomeValueConnection: vi.fn(),
      updateHomeValueConnection: vi.fn(),
      createVehicleValueConnection: vi.fn(),
      updateVehicleValueConnection: vi.fn(),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      refreshAllConnections: vi.fn(),
      upsertAccountLink: vi.fn(),
      listRequestedExternalSyncAccountIds: vi.fn().mockResolvedValue([]),
      runRequestedExternalSync: vi.fn().mockResolvedValue(undefined),
      runRequestedExternalSyncs: vi.fn().mockResolvedValue([]),
      runAccountSync: vi.fn(),
      runScheduledLinkSyncs: vi.fn(),
      handlePlaidWebhook: vi.fn(),
      handleTellerWebhook: vi.fn(),
      handleMonoWebhook: vi.fn(),
      handleStripeWebhook: vi.fn(),
      previewAccountSyncReview: vi.fn(),
      commitAccountSyncReview: vi.fn(),
      listSyncRuns: vi.fn(),
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
        STRIPE: {
          environment: "test",
          test: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          live: {
            publishableKey: "",
            secretKey: "",
            webhookSigningSecrets: []
          },
          countryCodes: ["US"],
          permissions: ["balances", "transactions"],
          prefetch: ["balances", "transactions"],
          transactionsInitialDays: 90,
          automaticSyncConcurrency: 2
        },
        TELLER: {
          environment: "sandbox",
          sandbox: {
            appId: "",
            sandboxAccessToken: "",
            webhookSigningSecrets: []
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
          webhookSyncDebounceSeconds: 30,
          webhookToleranceSeconds: 180
        },
        MONO: {
          environment: "sandbox",
          sandbox: {
            publicKey: "",
            secretKey: "",
            webhookSecret: ""
          },
          production: {
            publicKey: "",
            secretKey: "",
            webhookSecret: ""
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 1
        },
        SIMPLEFIN: {
          mode: "sandbox",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 1
        },
        BELVO: {
          environment: "sandbox",
          sandbox: {
            secretId: "",
            secretPassword: ""
          },
          production: {
            secretId: "",
            secretPassword: ""
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 7,
          automaticSyncConcurrency: 2
        },
        HOME_VALUES: {
          automaticSyncConcurrency: 1,
          redfinFetchMethod: "curl",
          movotoFetchMethod: "curl",
          homesFetchMethod: "wget",
          truliaFetchMethod: "wget"
        },
        VEHICLE_VALUES: {
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
      webhooksConfigured: vi.fn().mockReturnValue(true),
      verifyWebhookSignature: vi.fn().mockReturnValue(true),
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
    stripeService: {
      provider: "STRIPE" as const,
      isConfigured: vi.fn().mockReturnValue(false),
      webhooksConfigured: vi.fn().mockReturnValue(false),
      constructWebhookEvent: vi.fn().mockReturnValue(null),
      getAuthorization: vi.fn(),
      syncAccountLinkFromWebhook: vi.fn(),
      createConnectSession: vi.fn(),
      createReauthSession: vi.fn(),
      finalizeAccounts: vi.fn(),
      finalizeReauthSession: vi.fn(),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.stripeService as object | undefined)
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
    monoService: {
      provider: "MONO" as const,
      isConfigured: vi.fn().mockReturnValue(false),
      exchangeCode: vi.fn(),
      getReauthConfig: vi.fn(),
      createReauthSession: vi.fn(),
      webhooksConfigured: vi.fn().mockReturnValue(false),
      verifyWebhookSignature: vi.fn().mockReturnValue(false),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.monoService as object | undefined)
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
    },
    belvoService: {
      provider: "BELVO" as const,
      isConfigured: vi.fn().mockReturnValue(false),
      connectLink: vi.fn(),
      createReauthSession: vi.fn(),
      disconnectConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.belvoService as object | undefined)
    },
    homeValuesService: {
      provider: "HOME_VALUES" as const,
      isConfigured: vi.fn().mockReturnValue(true),
      createConnection: vi.fn(),
      updateConnection: vi.fn(),
      refreshConnection: vi.fn(),
      syncAccountLink: vi.fn(),
      ...(overrides.homeValuesService as object | undefined)
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
