import fs from "node:fs/promises";
import path from "node:path";

const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || "4010");
const runtimeRoot = path.resolve(process.cwd(), ".tmp", "playwright-ui-server");
const dbPath = path.join(runtimeRoot, "playwright-ui.db");
const actualDataDir = path.join(runtimeRoot, "actual-cache");

process.env.NODE_ENV = "test";
process.env.PORT = String(apiPort);
process.env.APP_BASE_URL = `http://127.0.0.1:${apiPort}`;
process.env.APP_INSTANCE_LABEL = "Playwright Full Stack";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "password123";
process.env.DATABASE_URL = `file:${dbPath}`;
process.env.ACTUAL_SERVER_URL = "http://127.0.0.1:5999";
process.env.ACTUAL_SERVER_PASSWORD = "not-used";
process.env.ACTUAL_BUDGET_SYNC_ID = "playwright-test-budget";
process.env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD = "";
process.env.ACTUAL_DATA_DIR = actualDataDir;
process.env.ACTUAL_API_VERSION_MATCH_MODE = "off";
process.env.DISABLE_SCHEDULER = "1";
process.env.LIVE_SANDBOX_MODE = "0";
process.env.PROVIDER_FIXTURE_CACHE_ENABLED = "0";

const [{ createSqliteDatabase }, { hashPassword }, { createServer }, { createProviderSettingsService }] = await Promise.all([
  import("../apps/server/src/test/test-db.ts"),
  import("../apps/server/src/lib/password.ts"),
  import("../apps/server/src/server.ts"),
  import("../apps/server/src/services/provider-settings-service.ts")
]);

await fs.rm(runtimeRoot, { recursive: true, force: true });
await fs.mkdir(runtimeRoot, { recursive: true });
await fs.mkdir(actualDataDir, { recursive: true });

const prisma = await createSqliteDatabase(process.env.DATABASE_URL);

await prisma.user.create({
  data: {
    username: process.env.ADMIN_USERNAME,
    passwordHash: await hashPassword(process.env.ADMIN_PASSWORD)
  }
});

const providerSettingsService = createProviderSettingsService({ prisma });

async function getRuntimeInfo() {
  const settings = await providerSettingsService.getAll();

  return {
    instanceLabel: "Playwright Full Stack",
    liveSandboxMode: false,
    providers: [
      {
        provider: "PLAID",
        label: "Plaid",
        enabled: false,
        ready: false,
        environment: settings.PLAID.environment,
        issues: ["Provider credentials not configured."],
        notes: []
      }
    ],
    settings,
    plaid: {
      enabled: false,
      environment: settings.PLAID.environment,
      sandboxToolsEnabled: false
    },
    stripe: {
      enabled: false,
      environment: settings.STRIPE.environment,
      publishableKeyConfigured: false,
      secretKeyConfigured: false
    },
    teller: {
      enabled: false,
      environment: settings.TELLER.environment,
      mtlsConfigured: false
    },
    simplefin: {
      enabled: false,
      mode: settings.SIMPLEFIN.mode,
      requiresSetupToken: true
    },
    actual: {
      serverUrl: "http://127.0.0.1:5999",
      budgetSyncIdConfigured: true,
      externalSyncWritebackEnabled: false
    }
  };
}

const app = await createServer({
  sessionSecret: process.env.SESSION_SECRET,
  nodeEnv: "test",
  enableStatic: false,
  context: {
    prisma,
    authService: {
      async authenticateUser(username, password) {
        const user = await prisma.user.findUnique({
          where: {
            username
          }
        });

        if (!user) {
          return null;
        }

        const valid = await (await import("../apps/server/src/lib/password.ts")).verifyPassword(password, user.passwordHash);
        if (!valid) {
          return null;
        }

        return {
          id: user.id,
          username: user.username
        };
      },
      async validateActualToken() {
        return false;
      }
    },
    appService: {
      async getRuntimeInfo() {
        return getRuntimeInfo();
      },
      async listConnections() {
        return [];
      },
      async listActualAccounts() {
        return {
          accounts: [],
          options: [],
          actualCategories: []
        };
      },
      async listActualBankSyncLinks() {
        return [];
      },
      async listSyncRuns() {
        return [];
      },
      async importExistingSimpleFinLinks() {
        return {
          imported: 0,
          updated: 0,
          skipped: 0,
          unmatched: 0
        };
      },
      async createSaltEdgeConnectSession() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async finalizeSaltEdgeConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async createConnectionReauthSession() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async createHomeValueConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async updateHomeValueConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async disconnectConnection() {
        return {
          ok: true
        };
      },
      async refreshConnection() {
        return {
          ok: true
        };
      },
      async refreshAllConnections() {
        return {
          ok: true
        };
      },
      async upsertAccountLink() {
        return {
          ok: true
        };
      },
      async listRequestedExternalSyncAccountIds() {
        return [];
      },
      async runRequestedExternalSync() {
        return;
      },
      async runRequestedExternalSyncs() {
        return [];
      },
      async runAccountSync() {
        return {
          ok: true
        };
      },
      async runScheduledLinkSyncs() {
        return [];
      },
      async handlePlaidWebhook() {
        return;
      },
      async handleTellerWebhook() {
        return;
      },
      async handleStripeWebhook() {
        return;
      },
      async previewAccountSyncReview() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async commitAccountSyncReview() {
        return {
          ok: true
        };
      }
    } as never,
    homeValuesService: {} as never,
    plaidService: {
      async createLinkToken() {
        return "playwright-link-token";
      },
      async exchangePublicToken() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async seedSandboxConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async seedSandboxTransactions() {
        return {
          added: 0
        };
      },
      async webhooksConfigured() {
        return false;
      },
      async verifyWebhookSignature() {
        return false;
      },
      async refreshConnection() {
        return;
      },
      async getConnectionAccounts() {
        return [];
      },
      async syncAccountLink() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async disconnectConnection() {
        return;
      },
      async createReauthSession() {
        return undefined;
      }
    } as never,
    providerSettingsService,
    simplefinService: {
      async connectSetupToken() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async reuseCachedConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async refreshConnection() {
        return;
      },
      async getConnectionAccounts() {
        return [];
      },
      async syncAccountLink() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async disconnectConnection() {
        return;
      },
      async createReauthSession() {
        return undefined;
      }
    } as never,
    stripeService: {
      async webhooksConfigured() {
        return false;
      },
      async constructWebhookEvent() {
        return null;
      },
      async createConnectSession() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async finalizeAccounts() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async finalizeReauthSession() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async refreshConnection() {
        return;
      },
      async getConnectionAccounts() {
        return [];
      },
      async syncAccountLink() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async disconnectConnection() {
        return;
      },
      async createReauthSession() {
        return undefined;
      }
    } as never,
    tellerService: {
      async webhooksConfigured() {
        return false;
      },
      async verifyWebhookSignature() {
        return false;
      },
      async getConnectConfig() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async enrollConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async reuseCachedConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async seedSandboxConnection() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async refreshConnection() {
        return;
      },
      async getConnectionAccounts() {
        return [];
      },
      async syncAccountLink() {
        throw new Error("Not implemented for Playwright UI server");
      },
      async disconnectConnection() {
        return;
      },
      async createReauthSession() {
        return undefined;
      }
    } as never,
    actualService: {
      async getCapabilities() {
        return {
          externalSyncWritebackEnabled: false
        };
      },
      async shutdown() {
        return;
      }
    } as never
  }
});

const close = async () => {
  await app.close();
  await prisma.$disconnect();
};

process.on("SIGINT", () => {
  void close().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().then(() => process.exit(0));
});

await app.listen({
  port: apiPort,
  host: "127.0.0.1"
});
