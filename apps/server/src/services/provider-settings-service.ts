import type {
  Provider,
  ProviderSettingsByProviderDto,
  ProviderSettingsDto,
  StripeProviderSettingsDto,
} from "@actual-sync/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { stripUndefined } from "../lib/strip-undefined.js";

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

const stripeEnvironmentSettingsSchema = z.object({
  publishableKey: z.string(),
  secretKey: z.string(),
  webhookSigningSecrets: z.array(z.string().min(1)).default([])
});

const stripeSettingsSchema = z.object({
  environment: z.enum(["test", "live"]),
  test: stripeEnvironmentSettingsSchema,
  live: stripeEnvironmentSettingsSchema,
  countryCodes: z.array(z.string().min(2)).min(1),
  permissions: z.array(z.enum(["balances", "transactions", "ownership", "payment_method"])).min(1),
  prefetch: z.array(z.enum(["balances", "transactions", "ownership"])),
  transactionsInitialDays: z.coerce.number().int().min(1).max(180),
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

const monoEnvironmentSettingsSchema = z.object({
  publicKey: z.string(),
  secretKey: z.string(),
  webhookSecret: z.string()
});

const monoSettingsSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  sandbox: monoEnvironmentSettingsSchema,
  production: monoEnvironmentSettingsSchema,
  transactionsInitialDays: z.coerce.number().int().min(1).max(3650),
  transactionsOverlapDays: z.coerce.number().int().min(1).max(30),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const simpleFinSettingsSchema = z.object({
  mode: z.enum(["sandbox", "development", "production"]),
  development: z.object({
    serverUrl: z.string()
  }),
  transactionsInitialDays: z.coerce.number().int().min(1).max(90),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const belvoEnvironmentSettingsSchema = z.object({
  secretId: z.string(),
  secretPassword: z.string(),
  webhookAuthorization: z.string().default("")
});

const belvoSettingsSchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  sandbox: belvoEnvironmentSettingsSchema,
  production: belvoEnvironmentSettingsSchema,
  transactionsInitialDays: z.coerce.number().int().min(1).max(3650),
  transactionsOverlapDays: z.coerce.number().int().min(1).max(90),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const homeValuesSettingsSchema = z.object({
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20),
  redfinFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("curl"),
  movotoFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("curl"),
  homesFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("wget"),
  truliaFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("wget")
});

const vehicleValuesSettingsSchema = z.object({
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20),
  kbbFetchMethod: z.enum(["node_fetch", "curl", "wget", "browser", "disabled"]).default("curl"),
  hagertyFetchMethod: z.enum(["node_fetch", "curl", "wget", "browser", "disabled"]).default("browser")
});

export const providerSchemas = {
  PLAID: plaidSettingsSchema,
  STRIPE: stripeSettingsSchema,
  TELLER: tellerSettingsSchema,
  MONO: monoSettingsSchema,
  SIMPLEFIN: simpleFinSettingsSchema,
  BELVO: belvoSettingsSchema,
  HOME_VALUES: homeValuesSettingsSchema,
  VEHICLE_VALUES: vehicleValuesSettingsSchema
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
      automaticSyncConcurrency: 1,
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
      automaticSyncConcurrency: 2
    },
    BELVO: {
      environment: "sandbox",
      sandbox: {
        secretId: "",
        secretPassword: "",
        webhookAuthorization: ""
      },
      production: {
        secretId: "",
        secretPassword: "",
        webhookAuthorization: ""
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
      automaticSyncConcurrency: 1,
      kbbFetchMethod: "curl",
      hagertyFetchMethod: "browser"
    }
  };
}

function parseProviderSettings<T extends Provider>(
  provider: T,
  raw: string | null | undefined
): ProviderSettingsByProviderDto<T> | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return providerSchemas[provider].parse(parsed) as ProviderSettingsByProviderDto<T>;
  } catch {
    return null;
  }
}

export type ProviderSettingsService = {
  getAll(): Promise<ProviderSettingsDto>;
  get<T extends Provider>(provider: T): Promise<ProviderSettingsByProviderDto<T>>;
  update<T extends Provider>(provider: T, settings: ProviderSettingsByProviderDto<T>): Promise<ProviderSettingsByProviderDto<T>>;
}

function reconcileStripeEnvironment(settings: StripeProviderSettingsDto) {
  const hasLiveKeys = Boolean(settings.live.publishableKey.trim() && settings.live.secretKey);
  const hasTestKeys = Boolean(settings.test.publishableKey.trim() && settings.test.secretKey);

  if (settings.environment === "live" && !hasLiveKeys && hasTestKeys) {
    return {
      ...settings,
      environment: "test" as const
    };
  }

  return settings;
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

      return stripUndefined({
        PLAID: parseProviderSettings("PLAID", byProvider.get("PLAID")) ?? defaults.PLAID,
        STRIPE: reconcileStripeEnvironment(parseProviderSettings("STRIPE", byProvider.get("STRIPE")) ?? defaults.STRIPE),
        TELLER: parseProviderSettings("TELLER", byProvider.get("TELLER")) ?? defaults.TELLER,
        MONO: parseProviderSettings("MONO", byProvider.get("MONO")) ?? defaults.MONO,
        SIMPLEFIN: parseProviderSettings("SIMPLEFIN", byProvider.get("SIMPLEFIN")) ?? defaults.SIMPLEFIN,
        BELVO: parseProviderSettings("BELVO", byProvider.get("BELVO")) ?? defaults.BELVO,
        HOME_VALUES: parseProviderSettings("HOME_VALUES", byProvider.get("HOME_VALUES")) ?? defaults.HOME_VALUES,
        VEHICLE_VALUES:
          parseProviderSettings("VEHICLE_VALUES", byProvider.get("VEHICLE_VALUES")) ?? defaults.VEHICLE_VALUES
      });
    },

    async get<T extends Provider>(provider: T) {
      const row = await database.providerSetting.findUnique({
        where: {
          provider
        }
      });

      const parsed = (parseProviderSettings(provider, row?.settingsJson) ??
        defaults[provider]) as ProviderSettingsByProviderDto<T>;

      return (
        provider === "STRIPE"
          ? reconcileStripeEnvironment(parsed as ProviderSettingsByProviderDto<"STRIPE">)
          : parsed
      ) as ProviderSettingsByProviderDto<T>;
    },

    async update<T extends Provider>(provider: T, settings: ProviderSettingsByProviderDto<T>) {
      const parsed = providerSchemas[provider].parse(settings) as ProviderSettingsByProviderDto<T>;
      const effective =
        provider === "STRIPE"
          ? (reconcileStripeEnvironment(parsed as ProviderSettingsByProviderDto<"STRIPE">) as ProviderSettingsByProviderDto<T>)
          : parsed;

      await database.providerSetting.upsert({
        where: {
          provider
        },
        update: {
          settingsJson: JSON.stringify(effective)
        },
        create: {
          provider,
          settingsJson: JSON.stringify(effective)
        }
      });

      return effective;
    }
  };
}
