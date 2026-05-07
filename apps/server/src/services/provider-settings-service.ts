import type {
  Provider,
  ProviderSettingsByProviderDto,
  ProviderSettingsDto,
  SaltEdgeProviderSettingsDto,
  StripeProviderSettingsDto,
} from "@actual-sync/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";

type DatabaseClient = typeof prisma;
type FetchLike = typeof fetch;
type SaltEdgeClientStatus = "pending" | "test" | "live" | "unknown";

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
  secretKey: z.string()
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

const simpleFinSettingsSchema = z.object({
  mode: z.enum(["sandbox", "development", "production"]),
  development: z.object({
    serverUrl: z.string()
  }),
  transactionsInitialDays: z.coerce.number().int().min(1).max(90),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const saltEdgeSettingsSchema = z.object({
  environment: z.enum(["sandbox", "test", "production"]).default("sandbox"),
  appId: z.string(),
  secret: z.string(),
  consentDays: z.coerce.number().int().min(1).max(365),
  transactionsFetchDays: z.coerce.number().int().min(1).max(365),
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20)
});

const homeValuesSettingsSchema = z.object({
  automaticSyncConcurrency: z.coerce.number().int().min(1).max(20),
  redfinFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("curl"),
  movotoFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("curl"),
  homesFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("wget"),
  truliaFetchMethod: z.enum(["node_fetch", "curl", "wget", "disabled"]).default("wget")
});

export const providerSchemas = {
  PLAID: plaidSettingsSchema,
  STRIPE: stripeSettingsSchema,
  TELLER: tellerSettingsSchema,
  SIMPLEFIN: simpleFinSettingsSchema,
  SALT_EDGE: saltEdgeSettingsSchema,
  HOME_VALUES: homeValuesSettingsSchema
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
    },
    SALT_EDGE: {
      environment: "sandbox",
      appId: "",
      secret: "",
      consentDays: 90,
      transactionsFetchDays: 90,
      automaticSyncConcurrency: 2
    },
    HOME_VALUES: {
      automaticSyncConcurrency: 1,
      redfinFetchMethod: "curl",
      movotoFetchMethod: "curl",
      homesFetchMethod: "wget",
      truliaFetchMethod: "wget"
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
    const parsed = JSON.parse(raw) as unknown;
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

type SaltEdgeProbeResponse<T> = {
  data?: T;
  errorClass?: string | null;
  errorMessage?: string | null;
  ok: boolean;
  status: number;
};

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
  prisma: database = prisma,
  fetchImpl = fetch
}: {
  prisma?: DatabaseClient;
  fetchImpl?: FetchLike;
} = {}): ProviderSettingsService {
  const defaults = defaultProviderSettings();

  const requestSaltEdge = async <T>({
    path,
    settings,
    method = "GET",
    data
  }: {
    path: string;
    settings: SaltEdgeProviderSettingsDto;
    method?: "GET" | "POST" | "DELETE";
    data?: Record<string, unknown>;
  }): Promise<SaltEdgeProbeResponse<T>> => {
    const response = await fetchImpl(`https://www.saltedge.com/api/v6${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "App-id": settings.appId.trim(),
        Secret: settings.secret
      },
      body: data ? JSON.stringify({ data }) : undefined
    });

    const payload = (await response.json().catch(() => null)) as
      | { data?: T; error?: { class?: string; message?: string } | null }
      | null;

    return {
      data: payload?.data,
      errorClass: payload?.error?.class ?? null,
      errorMessage: payload?.error?.message ?? null,
      ok: response.ok,
      status: response.status
    };
  };

  const detectSaltEdgeClientProfile = async (
    settings: SaltEdgeProviderSettingsDto
  ): Promise<{ clientStatus: SaltEdgeClientStatus; sandboxesAvailable: boolean }> => {
    if (!settings.appId.trim() || !settings.secret) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: false
      };
    }

    const defaultCountries = await requestSaltEdge<Array<{ code: string }>>({
      path: "/countries",
      settings
    });
    if (!defaultCountries.ok || !defaultCountries.data) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: false
      };
    }

    const sandboxCountries = await requestSaltEdge<Array<{ code: string }>>({
      path: "/countries?include_sandboxes=true",
      settings
    });
    const sandboxesAvailable = Boolean(sandboxCountries.data?.some(country => country.code === "XF"));
    const defaultHasFakeCountry = defaultCountries.data.some(country => country.code === "XF");

    if (!defaultHasFakeCountry) {
      return {
        clientStatus: "live",
        sandboxesAvailable
      };
    }

    const providers = await requestSaltEdge<Array<{ code: string; country_code: string; status?: string | null }>>({
      path: "/providers?include_sandboxes=false",
      settings
    });
    if (!providers.ok || !providers.data) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: true
      };
    }

    const liveProviders = providers.data.filter(
      provider => provider.country_code !== "XF" && (provider.status ?? "active") === "active"
    );
    if (liveProviders.length === 0) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: true
      };
    }

    const customer = await requestSaltEdge<{ customer_id?: string | null; id?: string | null }>({
      path: "/customers",
      method: "POST",
      settings,
      data: {
        identifier: `saltedge-env-probe-${Date.now()}`
      }
    });
    if (!customer.ok || !customer.data) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: true
      };
    }

    const customerId = customer.data.customer_id ?? customer.data.id;
    if (!customerId) {
      return {
        clientStatus: "unknown",
        sandboxesAvailable: true
      };
    }

    try {
      for (const provider of liveProviders.slice(0, 5)) {
        const connectProbe = await requestSaltEdge<{ connect_url?: string }>({
          path: "/connections/connect",
          method: "POST",
          settings,
          data: {
            customer_id: customerId,
            consent: {
              scopes: ["accounts"],
              period_days: 1
            },
            attempt: {
              fetch_scopes: ["accounts"],
              return_to: `${env.APP_BASE_URL.replace(/\/$/, "")}/connections/saltedge`
            },
            widget: {
              javascript_callback_type: "post_message",
              show_consent_confirmation: false,
              skip_provider_selection: true,
              skip_stages_screen: true
            },
            provider: {
              code: provider.code,
              include_sandboxes: false
            },
            automatic_refresh: false,
            return_error_class: true
          }
        });

        if (connectProbe.ok) {
          return {
            clientStatus: "test",
            sandboxesAvailable: true
          };
        }

        if (connectProbe.errorClass === "ClientPending") {
          return {
            clientStatus: "pending",
            sandboxesAvailable: true
          };
        }
      }
    } finally {
      await requestSaltEdge({
        path: `/customers/${customerId}`,
        method: "DELETE",
        settings
      }).catch(() => undefined);
    }

    return {
      clientStatus: "unknown",
      sandboxesAvailable: true
    };
  };

  const reconcileSaltEdgeEnvironment = async (settings: SaltEdgeProviderSettingsDto) => {
    const profile = await detectSaltEdgeClientProfile(settings);
    if (profile.clientStatus === "pending" && settings.environment !== "sandbox") {
      return {
        ...settings,
        environment: "sandbox" as const
      };
    }

    if (profile.clientStatus === "test" && settings.environment === "production") {
      return {
        ...settings,
        environment: "test" as const
      };
    }

    if (profile.clientStatus === "live" && settings.environment === "sandbox" && !profile.sandboxesAvailable) {
      return {
        ...settings,
        environment: "test" as const
      };
    }

    return settings;
  };

  return {
    async getAll() {
      const rows = await database.providerSetting.findMany();
      const byProvider = new Map(rows.map(row => [row.provider, row.settingsJson] as const));

      return {
        PLAID: parseProviderSettings("PLAID", byProvider.get("PLAID")) ?? defaults.PLAID,
        STRIPE: reconcileStripeEnvironment(parseProviderSettings("STRIPE", byProvider.get("STRIPE")) ?? defaults.STRIPE),
        TELLER: parseProviderSettings("TELLER", byProvider.get("TELLER")) ?? defaults.TELLER,
        SIMPLEFIN: parseProviderSettings("SIMPLEFIN", byProvider.get("SIMPLEFIN")) ?? defaults.SIMPLEFIN,
        SALT_EDGE: parseProviderSettings("SALT_EDGE", byProvider.get("SALT_EDGE")) ?? defaults.SALT_EDGE,
        HOME_VALUES: parseProviderSettings("HOME_VALUES", byProvider.get("HOME_VALUES")) ?? defaults.HOME_VALUES
      };
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
        provider === "SALT_EDGE"
          ? ((await reconcileSaltEdgeEnvironment(parsed as ProviderSettingsByProviderDto<"SALT_EDGE">)) as ProviderSettingsByProviderDto<T>)
          : provider === "STRIPE"
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
