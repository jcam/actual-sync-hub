import type {
  PlaidProviderSettingsDto,
  Provider,
  ProviderSettingsByProviderDto,
  ProviderSettingsDto,
  SimpleFinProviderSettingsDto,
  TellerProviderSettingsDto
} from "@actual-sync/shared";
import { z } from "zod";
import { prisma } from "../db.js";

type DatabaseClient = typeof prisma;

const plaidEnvironmentSettingsSchema = z.object({
  clientId: z.string(),
  secret: z.string()
});

const plaidSettingsSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  sandbox: plaidEnvironmentSettingsSchema,
  production: plaidEnvironmentSettingsSchema,
  countryCodes: z.array(z.string().min(2)).min(1),
  products: z.array(z.string().min(1)).min(1),
  transactionsDaysRequested: z.coerce.number().int().min(1).max(730),
  personalFinanceCategoryVersion: z.enum(["v1", "v2"]),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const tellerSandboxSettingsSchema = z.object({
  appId: z.string(),
  sandboxAccessToken: z.string(),
  webhookSigningSecrets: z.array(z.string().min(1)).optional().default([])
});

const tellerSecureEnvironmentSettingsSchema = z.object({
  appId: z.string(),
  certificatePem: z.string(),
  keyPem: z.string(),
  webhookSigningSecrets: z.array(z.string().min(1))
});

const tellerSettingsSchema = z.object({
  environment: z.enum(["sandbox", "development", "production"]),
  sandbox: tellerSandboxSettingsSchema,
  development: tellerSecureEnvironmentSettingsSchema,
  production: tellerSecureEnvironmentSettingsSchema,
  transactionsInitialDays: z.coerce.number().int().min(1),
  transactionsOverlapDays: z.coerce.number().int().min(1).max(30),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20),
  webhookSyncDebounceSeconds: z.coerce.number().int().min(0).max(3600),
  webhookToleranceSeconds: z.coerce.number().int().min(1).max(900)
});

const simpleFinSettingsSchema = z.object({
  mode: z.enum(["sandbox", "development", "production"]),
  development: z.object({
    serverUrl: z.string()
  }),
  transactionsInitialDays: z.coerce.number().int().min(1).max(90),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

export const providerSchemas = {
  PLAID: plaidSettingsSchema,
  TELLER: tellerSettingsSchema,
  SIMPLEFIN: simpleFinSettingsSchema
} as const;

function defaultProviderSettings(): ProviderSettingsDto {
  return {
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
      automaticSyncConcurrency: 1,
      webhookSyncDebounceSeconds: 30,
      webhookToleranceSeconds: 180
    },
    SIMPLEFIN: {
      mode: "sandbox",
      development: {
        serverUrl: ""
      },
      transactionsInitialDays: 45,
      automaticSyncConcurrency: 2
    }
  };
}

function normalizePlaidSettings(raw: unknown, defaults: PlaidProviderSettingsDto) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  if ("sandbox" in value || "production" in value) {
    return value;
  }

  const environment = value.environment === "production" ? "production" : defaults.environment;
  const legacySettings = {
    clientId: typeof value.clientId === "string" ? value.clientId : "",
    secret: typeof value.secret === "string" ? value.secret : ""
  };

  return {
    environment,
    sandbox: environment === "sandbox" ? legacySettings : defaults.sandbox,
    production: environment === "production" ? legacySettings : defaults.production,
    countryCodes: value.countryCodes,
    products: value.products,
    transactionsDaysRequested: value.transactionsDaysRequested,
    personalFinanceCategoryVersion: value.personalFinanceCategoryVersion,
    automaticSyncConcurrency: value.automaticSyncConcurrency
  };
}

function normalizeTellerSettings(raw: unknown, defaults: TellerProviderSettingsDto) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  if ("sandbox" in value || "development" in value || "production" in value) {
    return value;
  }

  const environment =
    value.environment === "development" || value.environment === "production"
      ? value.environment
      : defaults.environment;
  const legacyWebhookSigningSecrets = Array.isArray(value.webhookSigningSecrets)
    ? value.webhookSigningSecrets.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    environment,
    sandbox: {
      appId: environment === "sandbox" && typeof value.appId === "string" ? value.appId : "",
      sandboxAccessToken: environment === "sandbox" && typeof value.sandboxAccessToken === "string" ? value.sandboxAccessToken : "",
      webhookSigningSecrets: environment === "sandbox" ? legacyWebhookSigningSecrets : []
    },
    development: {
      appId: environment === "development" && typeof value.appId === "string" ? value.appId : "",
      certificatePem: environment === "development" && typeof value.certificatePem === "string" ? value.certificatePem : "",
      keyPem: environment === "development" && typeof value.keyPem === "string" ? value.keyPem : "",
      webhookSigningSecrets: environment === "development" ? legacyWebhookSigningSecrets : []
    },
    production: {
      appId: environment === "production" && typeof value.appId === "string" ? value.appId : "",
      certificatePem: environment === "production" && typeof value.certificatePem === "string" ? value.certificatePem : "",
      keyPem: environment === "production" && typeof value.keyPem === "string" ? value.keyPem : "",
      webhookSigningSecrets: environment === "production" ? legacyWebhookSigningSecrets : []
    },
    transactionsInitialDays: value.transactionsInitialDays,
    transactionsOverlapDays: value.transactionsOverlapDays,
    automaticSyncConcurrency: value.automaticSyncConcurrency,
    webhookSyncDebounceSeconds: value.webhookSyncDebounceSeconds,
    webhookToleranceSeconds: value.webhookToleranceSeconds
  };
}

function normalizeSimpleFinSettings(raw: unknown, defaults: SimpleFinProviderSettingsDto) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const value = raw as Record<string, unknown>;
  if ("mode" in value || "development" in value) {
    return value;
  }

  return {
    mode: defaults.mode,
    development: defaults.development,
    transactionsInitialDays: value.transactionsInitialDays,
    automaticSyncConcurrency: value.automaticSyncConcurrency
  };
}

function parseProviderSettings<T extends Provider>(
  provider: T,
  raw: string | null | undefined,
  defaults: ProviderSettingsDto
): ProviderSettingsByProviderDto<T> | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const normalized =
      provider === "PLAID"
        ? normalizePlaidSettings(parsed, defaults.PLAID)
        : provider === "TELLER"
          ? normalizeTellerSettings(parsed, defaults.TELLER)
          : normalizeSimpleFinSettings(parsed, defaults.SIMPLEFIN);
    return providerSchemas[provider].parse(normalized) as ProviderSettingsByProviderDto<T>;
  } catch {
    return null;
  }
}

export type ProviderSettingsService = {
  getAll(): Promise<ProviderSettingsDto>;
  get<T extends Provider>(provider: T): Promise<ProviderSettingsByProviderDto<T>>;
  update<T extends Provider>(provider: T, settings: ProviderSettingsByProviderDto<T>): Promise<ProviderSettingsByProviderDto<T>>;
}

export function createProviderSettingsService({
  prisma: database = prisma
}: {
  prisma?: DatabaseClient;
} = {}): ProviderSettingsService {
  const defaults = defaultProviderSettings();

  return {
    async getAll() {
      const rows = await database.providerSetting.findMany();
      const byProvider = new Map(rows.map(row => [row.provider, row.settingsJson] as const));

      return {
        PLAID: parseProviderSettings("PLAID", byProvider.get("PLAID"), defaults) ?? defaults.PLAID,
        TELLER: parseProviderSettings("TELLER", byProvider.get("TELLER"), defaults) ?? defaults.TELLER,
        SIMPLEFIN: parseProviderSettings("SIMPLEFIN", byProvider.get("SIMPLEFIN"), defaults) ?? defaults.SIMPLEFIN
      };
    },

    async get<T extends Provider>(provider: T) {
      const row = await database.providerSetting.findUnique({
        where: {
          provider
        }
      });

      return (parseProviderSettings(provider, row?.settingsJson, defaults) ??
        defaults[provider]) as ProviderSettingsByProviderDto<T>;
    },

    async update<T extends Provider>(provider: T, settings: ProviderSettingsByProviderDto<T>) {
      const parsed = providerSchemas[provider].parse(settings) as ProviderSettingsByProviderDto<T>;

      await database.providerSetting.upsert({
        where: {
          provider
        },
        update: {
          settingsJson: JSON.stringify(parsed)
        },
        create: {
          provider,
          settingsJson: JSON.stringify(parsed)
        }
      });

      return parsed;
    }
  };
}

export const providerSettingsService = createProviderSettingsService();
