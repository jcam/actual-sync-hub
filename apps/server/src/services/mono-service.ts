import type { ConnectionReauthSessionDto, MonoReauthConfigDto, ProviderConnectResult } from "@actual-sync/shared";
import { getActiveMonoEnvironmentSettings } from "@actual-sync/shared";
import { prisma } from "../db.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { buildProviderCategoryNames } from "./category-matching.js";
import { parseConnectionMetadata } from "./connection-metadata.js";
import { parseLinkConfig } from "./link-config.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { buildImportedTransactionNotes, sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

export type MonoConfig = {
  environment: "sandbox" | "production";
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  transactionsInitialDays: number;
  transactionsOverlapDays: number;
  automaticSyncConcurrency: number;
};

type FetchLike = typeof fetch;

type MonoAccount = {
  _id?: string;
  id?: string;
  name?: string | null;
  accountNumber?: string | null;
  currency?: string | null;
  balance?: number | null;
  type?: string | null;
  authMethod?: string | null;
  institution?: {
    name?: string | null;
    bankCode?: string | null;
    type?: string | null;
  } | null;
};

type MonoAccountMeta = {
  auth_method?: string | null;
  data_status?: string | null;
  sync_status?: string | null;
  ref?: string | null;
};

type MonoTransaction = {
  _id?: string;
  id?: string;
  amount?: number | null;
  balance?: number | null;
  type?: string | null;
  narration?: string | null;
  category?: string | null;
  date?: string | null;
  created_at?: string | null;
};

export type MonoWebhookEvent = {
  event: string;
  event_id?: string;
  timestamp?: string;
  data?: {
    account?: MonoAccount | null;
    meta?: MonoAccountMeta | null;
  } | null;
};

type MonoApiEnvelope = {
  message?: string;
  meta?: Record<string, unknown> | null;
  data?: unknown;
  paging?: Record<string, unknown> | null;
  status?: string;
};

type MonoTransactionsPage = {
  transactions: MonoTransaction[];
  nextUrl: string | null;
};

type MonoHealth = ReturnType<typeof toSyncHealth> | null;

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number) {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return toIsoDate(base);
}

function toMajorCurrencyAmount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value / 100;
}

function getAccountId(account: MonoAccount | null | undefined) {
  const accountId = account?._id ?? account?.id ?? null;
  return typeof accountId === "string" && accountId.trim().length > 0 ? accountId : null;
}

function getMaskedAccountNumber(account: MonoAccount | null | undefined) {
  const raw = account?.accountNumber?.trim();
  return raw && raw.length >= 4 ? raw.slice(-4) : null;
}

function normalizeIsoDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function normalizeSyncWindow({
  lastSyncEndDate,
  today,
  initialDays,
  overlapDays
}: {
  lastSyncEndDate: string | undefined;
  today: string;
  initialDays: number;
  overlapDays: number;
}) {
  return {
    startDate: lastSyncEndDate ? shiftIsoDate(lastSyncEndDate, -overlapDays) : shiftIsoDate(today, -(initialDays - 1)),
    endDate: today
  };
}

function getMonoAccountEnvelope(payload: unknown): {
  account: MonoAccount | null;
  meta: MonoAccountMeta | null;
} {
  if (!payload || typeof payload !== "object") {
    return {
      account: null,
      meta: null
    };
  }

  const record = payload as MonoApiEnvelope & Record<string, unknown>;
  const directAccount =
    typeof record.account === "object" && record.account ? (record.account as MonoAccount) : null;
  const directMeta = typeof record.meta === "object" && record.meta ? (record.meta as MonoAccountMeta) : null;

  if (directAccount) {
    return {
      account: directAccount,
      meta: directMeta
    };
  }

  if (!record.data || typeof record.data !== "object") {
    return {
      account: null,
      meta: directMeta
    };
  }

  const nestedData = record.data as Record<string, unknown>;
  const nestedAccount =
    typeof nestedData.account === "object" && nestedData.account
      ? (nestedData.account as MonoAccount)
      : (nestedData as MonoAccount);
  const nestedMeta =
    typeof nestedData.meta === "object" && nestedData.meta ? (nestedData.meta as MonoAccountMeta) : directMeta;

  return {
    account: nestedAccount,
    meta: nestedMeta
  };
}

function getMonoTransactionsPage(payload: unknown): MonoTransactionsPage {
  if (!payload || typeof payload !== "object") {
    return {
      transactions: [],
      nextUrl: null
    };
  }

  const record = payload as MonoApiEnvelope & Record<string, unknown>;
  const directTransactions = Array.isArray(record.data) ? (record.data as MonoTransaction[]) : [];
  const meta =
    typeof record.meta === "object" && record.meta
      ? (record.meta as Record<string, unknown>)
      : typeof record.paging === "object" && record.paging
        ? (record.paging as Record<string, unknown>)
        : {};
  const nextValue = meta.next;

  return {
    transactions: directTransactions,
    nextUrl: typeof nextValue === "string" && nextValue.length > 0 ? nextValue : null
  };
}

function getErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const nestedData = typeof record.data === "object" && record.data ? (record.data as Record<string, unknown>) : null;

  return (
    (typeof record.message === "string" && record.message) ||
    (typeof record.error === "string" && record.error) ||
    (nestedData && typeof nestedData.message === "string" && nestedData.message) ||
    fallback
  );
}

function classifyMonoError(error: unknown) {
  if (error instanceof ProviderOperationError) {
    return error;
  }

  const status =
    typeof error === "object" && error && "status" in error ? ((error as { status?: number }).status ?? undefined) : undefined;
  const code =
    typeof error === "object" && error && "code" in error ? ((error as { code?: string }).code ?? undefined) : undefined;
  const message = error instanceof Error ? error.message : "Unknown Mono error";
  const upperCode = code?.toUpperCase();
  const upperMessage = message.toUpperCase();

  if (status === 429 || upperCode === "RATE_LIMIT_EXCEEDED") {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (upperCode === "REAUTHORISATION_REQUIRED" || upperMessage.includes("REAUTHORISATION_REQUIRED")) {
    return new ProviderOperationError(message, {
      code: upperCode ?? "REAUTHORISATION_REQUIRED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "REAUTH_BANK"
    });
  }

  if (upperCode === "ACCOUNT_UNLINKED" || upperMessage.includes("ACCOUNT UNLINKED")) {
    return new ProviderOperationError(message, {
      code: upperCode ?? "ACCOUNT_UNLINKED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  if (upperCode === "DATA_PROCESSING" || upperCode === "DATA_UNAVAILABLE") {
    return new ProviderOperationError(message, {
      code: upperCode,
      healthState: "ATTENTION_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY"
    });
  }

  return new ProviderOperationError(
    message,
    upperCode
      ? {
          code: upperCode,
          healthState: status && status >= 500 ? "ERROR" : "ATTENTION_REQUIRED",
          healthScope: "CONNECTION_AUTH",
          healthAction: "RETRY"
        }
      : {
          healthState: status && status >= 500 ? "ERROR" : "ATTENTION_REQUIRED",
          healthScope: "CONNECTION_AUTH",
          healthAction: "RETRY"
        }
  );
}

function getMonoHealth(meta: MonoAccountMeta | null | undefined): MonoHealth {
  const syncStatus = meta?.sync_status?.toUpperCase();
  const dataStatus = meta?.data_status?.toUpperCase();

  if (syncStatus === "REAUTHORISATION_REQUIRED") {
    return toSyncHealth(
      new ProviderOperationError("Mono requires the linked bank account to be reauthorised.", {
        code: "REAUTHORISATION_REQUIRED",
        healthState: "REAUTH_REQUIRED",
        healthScope: "BANK_AUTH",
        healthAction: "REAUTH_BANK"
      })
    );
  }

  if (dataStatus === "PROCESSING") {
    return toSyncHealth(
      new ProviderOperationError("Mono is still processing account data.", {
        code: "DATA_PROCESSING",
        healthState: "ATTENTION_REQUIRED",
        healthScope: "CONNECTION_AUTH",
        healthAction: "RETRY"
      })
    );
  }

  if (dataStatus === "UNAVAILABLE" || dataStatus === "FAILED") {
    return toSyncHealth(
      new ProviderOperationError("Mono reported that account data is currently unavailable.", {
        code: dataStatus === "FAILED" ? "DATA_FAILED" : "DATA_UNAVAILABLE",
        healthState: "ATTENTION_REQUIRED",
        healthScope: "CONNECTION_AUTH",
        healthAction: "RETRY"
      })
    );
  }

  return clearSyncHealth();
}

async function parseMonoResponse<T>(
  response: Response,
  fallbackMessage: string
): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    payload = JSON.parse(text);
  }

  if (!response.ok) {
    const providerError = classifyMonoError(
      Object.assign(new Error(getErrorMessage(payload, fallbackMessage)), {
        status: response.status
      })
    );
    throw providerError;
  }

  return payload as T;
}

export type MonoService = {
  exchangeCode(args: { code: string; label?: string | null }): Promise<ProviderConnectResult>;
  getReauthConfig(connectionId: string): Promise<MonoReauthConfigDto>;
  webhooksConfigured(): Promise<boolean>;
  verifyWebhookSignature(signatureHeader: string | string[] | undefined): Promise<boolean>;
} & ProviderAdapter;

export function createMonoService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
    environment: "sandbox",
    publicKey: "",
    secretKey: "",
    webhookSecret: "",
    transactionsInitialDays: 90,
    transactionsOverlapDays: 10,
    automaticSyncConcurrency: 1
  } satisfies MonoConfig,
  fetchImpl = fetch,
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: MonoConfig;
  fetchImpl?: FetchLike;
  now?: () => Date;
} = {}): MonoService {
  const getEffectiveConfig = async (): Promise<MonoConfig> => {
    const settings = await providerSettings.get("MONO");
    const activeSettings = getActiveMonoEnvironmentSettings(settings);

    return {
      ...config,
      environment: settings.environment,
      publicKey: activeSettings.publicKey,
      secretKey: activeSettings.secretKey,
      webhookSecret: activeSettings.webhookSecret,
      transactionsInitialDays: settings.transactionsInitialDays,
      transactionsOverlapDays: settings.transactionsOverlapDays,
      automaticSyncConcurrency: settings.automaticSyncConcurrency
    };
  };

  const monoRequest = async <T>({
    effectiveConfig,
    path,
    method = "GET",
    body,
    query
  }: {
    effectiveConfig: MonoConfig;
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string>;
  }) => {
    if (!effectiveConfig.secretKey.trim()) {
      throw new Error("Mono is not configured");
    }

    const url = new URL(path, "https://api.withmono.com");
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    return parseMonoResponse<T>(
      await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "mono-sec-key": effectiveConfig.secretKey
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      `Mono request failed: ${method} ${url.pathname}`
    );
  };

  const fetchAccountDetails = async ({
    effectiveConfig,
    accountId
  }: {
    effectiveConfig: MonoConfig;
    accountId: string;
  }) => {
    const payload = await monoRequest<unknown>({
      effectiveConfig,
      path: `/v2/accounts/${accountId}`
    });

    const result = getMonoAccountEnvelope(payload);
    if (!getAccountId(result.account)) {
      throw new Error("Mono did not return an account payload.");
    }

    return result;
  };

  const listTransactionsInWindow = async ({
    effectiveConfig,
    accountId,
    startDate,
    endDate
  }: {
    effectiveConfig: MonoConfig;
    accountId: string;
    startDate: string;
    endDate: string;
  }) => {
    const collected: MonoTransaction[] = [];
    let nextPath = `/v2/accounts/${accountId}/transactions`;
    let nextQuery: Record<string, string> | undefined = {
      from: startDate,
      to: endDate,
      paginate: "false"
    };

    while (nextPath) {
      const payload = await monoRequest<unknown>({
        effectiveConfig,
        path: nextPath,
        query: nextQuery
      });
      const page = getMonoTransactionsPage(payload);
      collected.push(...page.transactions);

      if (!page.nextUrl) {
        break;
      }

      const nextUrl = new URL(page.nextUrl, "https://api.withmono.com");
      nextPath = nextUrl.pathname;
      nextQuery = Object.fromEntries(nextUrl.searchParams.entries());
    }

    return collected;
  };

  const upsertConnectionAccount = async ({
    connectionId,
    account,
    meta,
    health
  }: {
    connectionId: string;
    account: MonoAccount;
    meta: MonoAccountMeta | null;
    health: MonoHealth;
  }) => {
    const accountId = getAccountId(account);
    if (!accountId) {
      throw new Error("Mono account id is missing.");
    }

    await database.connectionAccount.deleteMany({
      where: {
        connectionId
      }
    });

    await database.connectionAccount.create({
      data: {
        connectionId,
        externalAccountId: accountId,
        name: account.name?.trim() || "Mono account",
        officialName: account.accountNumber ?? account.name ?? null,
        mask: getMaskedAccountNumber(account),
        type: account.type?.toLowerCase() || "bank",
        subtype: null,
        currentBalance: toMajorCurrencyAmount(account.balance),
        availableBalance: toMajorCurrencyAmount(account.balance),
        providerInstitutionId: account.institution?.bankCode ?? null,
        rawJson: JSON.stringify({
          account,
          meta
        })
      }
    });

    const connection = await database.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      }
    });
    const existingMetadata = parseConnectionMetadata(connection.metadataJson);

    await database.connection.update({
      where: {
        id: connectionId
      },
      data: {
        status: health ? "ERROR" : "ACTIVE",
        institutionName: account.institution?.name ?? connection.institutionName,
        institutionId: account.institution?.bankCode ?? connection.institutionId,
        lastRefreshedAt: now(),
        metadataJson: JSON.stringify({
          ...existingMetadata,
          mono: {
            accountId,
            environment: existingMetadata.mono && typeof existingMetadata.mono === "object"
              ? (existingMetadata.mono as Record<string, unknown>).environment ?? null
              : null,
            authMethod: meta?.auth_method ?? account.authMethod ?? null,
            dataStatus: meta?.data_status ?? null,
            syncStatus: meta?.sync_status ?? null,
            ref: meta?.ref ?? null,
            currency: account.currency ?? null
          },
          health
        })
      }
    });
  };

  const upsertMonoConnection = async ({
    accountId,
    label
  }: {
    accountId: string;
    label?: string | null | undefined;
  }) => {
    const effectiveConfig = await getEffectiveConfig();
    const { account, meta } = await fetchAccountDetails({
      effectiveConfig,
      accountId
    });
    if (!account) {
      throw new Error("Mono did not return account details.");
    }

    const health = getMonoHealth(meta);
    const connectionLabel =
      label?.trim() ||
      account.institution?.name?.trim() ||
      account.name?.trim() ||
      `Mono ${now().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    const connection = await database.connection.upsert({
      where: {
        provider_providerItemId: {
          provider: "MONO",
          providerItemId: accountId
        }
      },
      update: {
        label: connectionLabel,
        status: health ? "ERROR" : "ACTIVE",
        institutionName: account.institution?.name ?? "Mono",
        institutionId: account.institution?.bankCode ?? null,
        accessTokenCiphertext: "",
        metadataJson: JSON.stringify({
          mono: {
            accountId,
            environment: effectiveConfig.environment,
            authMethod: meta?.auth_method ?? account.authMethod ?? null,
            dataStatus: meta?.data_status ?? null,
            syncStatus: meta?.sync_status ?? null,
            ref: meta?.ref ?? null,
            currency: account.currency ?? null
          },
          health
        }),
        lastRefreshedAt: now()
      },
      create: {
        provider: "MONO",
        providerItemId: accountId,
        label: connectionLabel,
        status: health ? "ERROR" : "ACTIVE",
        institutionName: account.institution?.name ?? "Mono",
        institutionId: account.institution?.bankCode ?? null,
        accessTokenCiphertext: "",
        metadataJson: JSON.stringify({
          mono: {
            accountId,
            environment: effectiveConfig.environment,
            authMethod: meta?.auth_method ?? account.authMethod ?? null,
            dataStatus: meta?.data_status ?? null,
            syncStatus: meta?.sync_status ?? null,
            ref: meta?.ref ?? null,
            currency: account.currency ?? null
          },
          health
        }),
        lastRefreshedAt: now()
      }
    });

    await upsertConnectionAccount({
      connectionId: connection.id,
      account,
      meta,
      health
    });

    return stripUndefined({
      connectionId: connection.id,
      warning: health?.message ?? undefined
    }) satisfies ProviderConnectResult;
  };

  return {
    provider: "MONO",

    isConfigured() {
      return false;
    },

    async exchangeCode({
      code,
      label
    }: {
      code: string;
      label?: string | null;
    }) {
      const effectiveConfig = await getEffectiveConfig();
      const payload = await monoRequest<unknown>({
        effectiveConfig,
        path: "/v2/accounts/auth",
        method: "POST",
        body: {
          code
        }
      });

      const responseRecord = payload as Record<string, unknown> | null;
      const nestedData =
        responseRecord && typeof responseRecord.data === "object" && responseRecord.data
          ? (responseRecord.data as Record<string, unknown>)
          : null;
      const accountId = [nestedData?.id, responseRecord?.id].find(
        value => typeof value === "string" && value.trim().length > 0
      ) as string | undefined;

      if (!accountId) {
        throw new Error("Mono did not return an account id after exchanging the code.");
      }

      return upsertMonoConnection(stripUndefined({
        accountId,
        label
      }));
    },

    async getReauthConfig(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "MONO" || !connection.providerItemId) {
        throw new Error("Connection is not a Mono account");
      }

      return {
        accountId: connection.providerItemId,
        publicKey: effectiveConfig.publicKey,
        environment: effectiveConfig.environment
      } satisfies MonoReauthConfigDto;
    },

    async createReauthSession({
      connectionId
    }: {
      connectionId: string;
      userId: string;
    }): Promise<ConnectionReauthSessionDto> {
      return {
        provider: "MONO",
        connectionId,
        mode: "mono_reauth",
        config: await this.getReauthConfig(connectionId)
      };
    },

    async webhooksConfigured() {
      const effectiveConfig = await getEffectiveConfig();
      return Boolean(effectiveConfig.webhookSecret.trim());
    },

    async verifyWebhookSignature(signatureHeader: string | string[] | undefined) {
      const effectiveConfig = await getEffectiveConfig();
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      return Boolean(signature && effectiveConfig.webhookSecret && signature === effectiveConfig.webhookSecret);
    },

    async disconnectConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "MONO" || !connection.providerItemId) {
        throw new Error("Connection is not a Mono account");
      }

      try {
        await monoRequest({
          effectiveConfig,
          path: `/v2/accounts/${connection.providerItemId}/unlink`,
          method: "POST"
        });
      } catch (error) {
        const providerError = classifyMonoError(error);
        if (providerError.code === "ACCOUNT_UNLINKED") {
          return;
        }
        throw providerError;
      }
    },

    async refreshConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "MONO" || !connection.providerItemId) {
        throw new Error("Connection is not a Mono account");
      }

      try {
        const { account, meta } = await fetchAccountDetails({
          effectiveConfig,
          accountId: connection.providerItemId
        });

        if (!account) {
          throw new Error("Mono did not return account details.");
        }

        const health = getMonoHealth(meta);
        await upsertConnectionAccount({
          connectionId,
          account,
          meta,
          health
        });
      } catch (error) {
        const metadata = parseConnectionMetadata(connection.metadataJson);
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health: toSyncHealth(classifyMonoError(error))
            })
          }
        });
        throw classifyMonoError(error);
      }
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const effectiveConfig = await getEffectiveConfig();
      const link = await database.accountLink.findUniqueOrThrow({
        where: {
          id: linkId
        },
        include: {
          connection: true,
          connectionAccount: true
        }
      });

      if (!link.connection || !link.connectionAccount || !link.connection.providerItemId) {
        return {
          imported: 0,
          transactions: [],
          removedImportedIds: [],
          configPatch: {}
        };
      }

      try {
        const { account, meta } = await fetchAccountDetails({
          effectiveConfig,
          accountId: link.connection.providerItemId
        });

        if (!account) {
          throw new Error("Mono did not return account details.");
        }

        const health = getMonoHealth(meta);
        if (health) {
          await upsertConnectionAccount({
            connectionId: link.connection.id,
            account,
            meta,
            health
          });
          throw classifyMonoError(
            Object.assign(new Error(health.message ?? "Mono account requires attention."), {
              code:
                health.code === "REAUTHORISATION_REQUIRED"
                  ? "REAUTHORISATION_REQUIRED"
                  : health.code === "DATA_UNAVAILABLE"
                    ? "DATA_UNAVAILABLE"
                    : "DATA_PROCESSING"
            })
          );
        }

        const configState = parseLinkConfig(link.configJson);
        const today = toIsoDate(now());
        const { startDate, endDate } = normalizeSyncWindow({
          lastSyncEndDate: configState.providerSyncState?.windowEndDate ?? undefined,
          today,
          initialDays: effectiveConfig.transactionsInitialDays,
          overlapDays: effectiveConfig.transactionsOverlapDays
        });
        const monoTransactions = await listTransactionsInWindow({
          effectiveConfig,
          accountId: link.connection.providerItemId,
          startDate,
          endDate
        });

        await upsertConnectionAccount({
          connectionId: link.connection.id,
          account,
          meta,
          health
        });

        const transactions = monoTransactions.reduce<ProviderSyncTransaction[]>((result, transaction) => {
          const importedId = transaction._id ?? transaction.id;
          const date = normalizeIsoDate(transaction.date ?? transaction.created_at ?? null);
          if (!importedId || !date || typeof transaction.amount !== "number" || !transaction.type) {
            return result;
          }

          const narration = transaction.narration?.trim() || transaction.type;
          const normalizedAmount = toMajorCurrencyAmount(transaction.amount);
          if (normalizedAmount == null) {
            return result;
          }

          const amount = transaction.type.toLowerCase() === "credit" ? normalizedAmount * -1 : normalizedAmount;
          result.push(
            stripUndefined({
              date,
              amount,
              payeeName: narration,
              importedPayee: narration,
              notes: buildImportedTransactionNotes({
                payeeName: narration,
                description: narration
              }),
              importedId,
              cleared: true,
              categoryNames: buildProviderCategoryNames(transaction.category),
              searchText: [narration, transaction.category ?? undefined, transaction.type].filter(
                (value): value is string => Boolean(value)
              )
            }) satisfies ProviderSyncTransaction
          );

          return result;
        }, []);
        transactions.sort((left, right) => right.date.localeCompare(left.date));

        return sanitizeProviderSyncResult({
          imported: transactions.length,
          transactions,
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: null,
              windowStartDate: startDate,
              windowEndDate: endDate
            }
          }
        });
      } catch (error) {
        const metadata = parseConnectionMetadata(link.connection.metadataJson);
        await database.connection.update({
          where: {
            id: link.connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health: toSyncHealth(classifyMonoError(error))
            })
          }
        });
        throw classifyMonoError(error);
      }
    }
  };
}

export const monoService = createMonoService();
