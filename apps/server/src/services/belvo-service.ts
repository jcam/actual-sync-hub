import BelvoClient, {
  type BelvoAccount,
  type BelvoLink,
  type BelvoTransaction
} from "belvo";
import type { ConnectionReauthSessionDto, ProviderConnectResult } from "@actual-sync/shared";
import { getActiveBelvoEnvironmentSettings } from "@actual-sync/shared";
import { prisma } from "../db.js";
import { encryptString } from "../lib/crypto.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { buildProviderCategoryNames } from "./category-matching.js";
import { parseLinkConfig } from "./link-config.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { buildImportedTransactionNotes, sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

export type BelvoConfig = {
  environment: "sandbox" | "production";
  sandbox: {
    secretId: string;
    secretPassword: string;
  };
  production: {
    secretId: string;
    secretPassword: string;
  };
  transactionsInitialDays: number;
  transactionsOverlapDays: number;
  automaticSyncConcurrency: number;
};

export type BelvoConnectPayload = {
  linkId: string;
  label?: string | null;
};

type BelvoRequestError = {
  statusCode?: number;
  detail?: unknown;
  message?: string;
};

export type BelvoService = {
  connectLink(payload: BelvoConnectPayload): Promise<ProviderConnectResult>;
} & ProviderAdapter;

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number) {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return toIsoDate(base);
}

function buildSyncWindow({
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
  if (!lastSyncEndDate) {
    return {
      startDate: shiftIsoDate(today, -(initialDays - 1)),
      endDate: today
    };
  }

  return {
    startDate: shiftIsoDate(lastSyncEndDate, -Math.max(overlapDays - 1, 0)),
    endDate: today
  };
}

function getBelvoBaseUrl(environment: BelvoConfig["environment"]) {
  return environment === "production" ? "https://api.belvo.com" : "https://sandbox.belvo.com";
}

function getBelvoClient(config: BelvoConfig) {
  const activeConfig = getActiveBelvoEnvironmentSettings(config);
  if (!activeConfig.secretId.trim() || !activeConfig.secretPassword) {
    throw new Error("Belvo is not configured");
  }

  return new BelvoClient(activeConfig.secretId.trim(), activeConfig.secretPassword, getBelvoBaseUrl(config.environment));
}

async function connectBelvoClient(config: BelvoConfig) {
  const client = getBelvoClient(config);
  await client.connect();
  return client;
}

function getErrorStatus(error: unknown) {
  return typeof error === "object" && error ? (error as BelvoRequestError).statusCode : undefined;
}

function getErrorDetail(error: unknown) {
  return typeof error === "object" && error ? (error as BelvoRequestError).detail : undefined;
}

function getErrorMessage(error: unknown) {
  const detail = getErrorDetail(error);
  if (Array.isArray(detail)) {
    const messages = detail
      .map(item => {
        if (typeof item === "string") {
          return item;
        }

        if (typeof item === "object" && item) {
          if ("message" in item && typeof item.message === "string") {
            return item.message;
          }
          if ("detail" in item && typeof item.detail === "string") {
            return item.detail;
          }
          if ("request" in item && typeof item.request === "string") {
            return item.request;
          }
        }

        return null;
      })
      .filter((value): value is string => Boolean(value));

    if (messages.length > 0) {
      return messages.join("; ");
    }
  }

  if (detail && typeof detail === "object") {
    if ("message" in detail && typeof detail.message === "string") {
      return detail.message;
    }
    if ("detail" in detail && typeof detail.detail === "string") {
      return detail.detail;
    }
  }

  return error instanceof Error ? error.message : "Unknown Belvo error";
}

function classifyBelvoError(error: unknown) {
  if (error instanceof ProviderOperationError) {
    return error;
  }

  const status = getErrorStatus(error);
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (status === 429 || normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (
    status === 428 ||
    normalized.includes("token required") ||
    normalized.includes("mfa") ||
    normalized.includes("otp") ||
    normalized.includes("token_required")
  ) {
    return new ProviderOperationError(message, {
      code: "TOKEN_REQUIRED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  if (status === 404 || normalized.includes("link not found")) {
    return new ProviderOperationError(message, {
      code: "LINK_NOT_FOUND",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  if (status === 401 || status === 403) {
    return new ProviderOperationError(message, {
      code: "BELVO_AUTH_FAILED",
      healthState: "ERROR",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY"
    });
  }

  return new ProviderOperationError(message, {
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

function getAccountMask(account: BelvoAccount) {
  const accountNumber = account.number?.trim();
  return accountNumber && accountNumber.length >= 4 ? accountNumber.slice(-4) : null;
}

function getAccountInstitutionName(_link: BelvoLink, accounts: BelvoAccount[]) {
  const institution = accounts[0]?.institution?.trim();
  return institution || null;
}

function buildConnectionLabel({
  payload,
  link,
  institutionName
}: {
  payload: BelvoConnectPayload;
  link: BelvoLink;
  institutionName: string | null;
}) {
  return payload.label?.trim() || link.external_id?.trim() || institutionName || `Belvo ${link.id.slice(0, 8)}`;
}

function buildConnectionAccountRows(connectionId: string, link: BelvoLink, accounts: BelvoAccount[]) {
  return accounts.map(account => ({
    connectionId,
    externalAccountId: account.id,
    name: account.name?.trim() || account.public_identification_name?.trim() || "Belvo account",
    officialName: account.public_identification_name?.trim() || account.name?.trim() || null,
    mask: getAccountMask(account),
    type: account.category?.trim() || account.type?.trim() || "bank",
    subtype: account.subtype?.trim() || account.type?.trim() || null,
    currentBalance: account.balance?.current ?? null,
    availableBalance: account.balance?.available ?? null,
    providerInstitutionId: link.institution ?? null,
    rawJson: JSON.stringify(account)
  }));
}

function getTransactionDate(transaction: BelvoTransaction) {
  return transaction.accounting_date || transaction.value_date || transaction.collected_at?.slice(0, 10) || null;
}

function getTransactionAmount(transaction: BelvoTransaction) {
  if (typeof transaction.amount !== "number" || !Number.isFinite(transaction.amount)) {
    return null;
  }

  if (transaction.type === "OUTFLOW") {
    return transaction.amount * -1;
  }

  return transaction.amount;
}

function normalizeBelvoTransaction(transaction: BelvoTransaction) {
  const date = getTransactionDate(transaction);
  const amount = getTransactionAmount(transaction);
  if (!date || amount == null) {
    return null;
  }

  const payeeName = transaction.merchant_name?.trim() || transaction.description?.trim() || "Belvo transaction";
  const categoryNames = [
    ...buildProviderCategoryNames(transaction.category),
    ...buildProviderCategoryNames(transaction.subcategory)
  ];

  return stripUndefined({
    date,
    amount,
    payeeName,
    importedPayee: transaction.description?.trim() || payeeName,
    notes: buildImportedTransactionNotes({
      payeeName,
      ...(transaction.reference?.trim() || transaction.description?.trim()
        ? {
            description: transaction.reference?.trim() || transaction.description?.trim() || null
          }
        : {})
    }),
    importedId: transaction.id,
    cleared: transaction.status !== "PENDING",
    categoryNames: [...new Set(categoryNames)],
    searchText: [...new Set(
      [transaction.description, transaction.merchant_name, transaction.reference].filter(
        (value): value is string => Boolean(value?.trim())
      )
    )]
  });
}

async function upsertBelvoConnection({
  database,
  client,
  config,
  payload
}: {
  database: DatabaseClient;
  client: Awaited<ReturnType<typeof connectBelvoClient>>;
  config: BelvoConfig;
  payload: BelvoConnectPayload;
}) {
  const [link, accounts] = await Promise.all([
    client.links.detail(payload.linkId),
    client.accounts.retrieve(payload.linkId, {
      saveData: false
    })
  ]);

  const institutionName = getAccountInstitutionName(link, accounts);
  const label = buildConnectionLabel({
    payload,
    link,
    institutionName
  });
  const refreshedAt = new Date();
  const connection = await database.connection.upsert({
    where: {
      provider_providerItemId: {
        provider: "BELVO",
        providerItemId: payload.linkId
      }
    },
    update: {
      label,
      status: "ACTIVE",
      institutionName,
      institutionId: link.institution ?? null,
      accessTokenCiphertext: encryptString(payload.linkId),
      metadataJson: JSON.stringify({
        belvo: {
          environment: config.environment,
          linkId: payload.linkId,
          status: link.status ?? null,
          accessMode: link.access_mode ?? null,
          externalId: link.external_id ?? null
        },
        health: clearSyncHealth()
      }),
      lastRefreshedAt: refreshedAt
    },
    create: {
      provider: "BELVO",
      providerItemId: payload.linkId,
      label,
      status: "ACTIVE",
      institutionName,
      institutionId: link.institution ?? null,
      accessTokenCiphertext: encryptString(payload.linkId),
      metadataJson: JSON.stringify({
        belvo: {
          environment: config.environment,
          linkId: payload.linkId,
          status: link.status ?? null,
          accessMode: link.access_mode ?? null,
          externalId: link.external_id ?? null
        },
        health: clearSyncHealth()
      }),
      lastRefreshedAt: refreshedAt
    }
  });

  await database.connectionAccount.deleteMany({
    where: {
      connectionId: connection.id
    }
  });

  if (accounts.length > 0) {
    await database.connectionAccount.createMany({
      data: buildConnectionAccountRows(connection.id, link, accounts)
    });
  }

  return connection.id;
}

export function createBelvoService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
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
  } satisfies BelvoConfig
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: BelvoConfig;
} = {}): BelvoService {
  const getEffectiveConfig = async (): Promise<BelvoConfig> => {
    const settings = await providerSettings.get("BELVO");
    return {
      ...config,
      environment: settings.environment,
      sandbox: settings.sandbox,
      production: settings.production,
      transactionsInitialDays: settings.transactionsInitialDays,
      transactionsOverlapDays: settings.transactionsOverlapDays,
      automaticSyncConcurrency: settings.automaticSyncConcurrency
    };
  };

  return {
    provider: "BELVO",
    isConfigured() {
      return false;
    },
    async createReauthSession({
      connectionId
    }: {
      connectionId: string;
      userId: string;
    }): Promise<ConnectionReauthSessionDto> {
      return {
        provider: "BELVO",
        connectionId,
        mode: "manual",
        message: "Belvo reconnection currently requires re-linking or completing the provider challenge outside this app."
      };
    },
    async connectLink(payload: BelvoConnectPayload) {
      const effectiveConfig = await getEffectiveConfig();
      const client = await connectBelvoClient(effectiveConfig);
      const connectionId = await upsertBelvoConnection({
        database,
        client,
        config: effectiveConfig,
        payload
      });
      return {
        connectionId
      };
    },
    async disconnectConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "BELVO") {
        throw new Error("Connection is not a Belvo link");
      }

      if (!connection.providerItemId) {
        return;
      }

      try {
        const client = await connectBelvoClient(effectiveConfig);
        await client.links.delete(connection.providerItemId);
      } catch (error) {
        const providerError = classifyBelvoError(error);
        if (providerError.code === "LINK_NOT_FOUND") {
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

      if (connection.provider !== "BELVO" || !connection.providerItemId) {
        throw new Error("Connection is not a Belvo link");
      }

      try {
        const client = await connectBelvoClient(effectiveConfig);
        await upsertBelvoConnection({
          database,
          client,
          config: effectiveConfig,
          payload: {
            linkId: connection.providerItemId,
            label: connection.label
          }
        });
      } catch (error) {
        const health = toSyncHealth(classifyBelvoError(error));
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              belvo: {
                environment: effectiveConfig.environment,
                linkId: connection.providerItemId
              },
              health
            })
          }
        });
        throw classifyBelvoError(error);
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

      if (!link.connection || !link.connectionAccount || link.connection.provider !== "BELVO" || !link.connection.providerItemId) {
        throw new Error("Belvo link is missing connection details");
      }

      try {
        const client = await connectBelvoClient(effectiveConfig);
        const configState = parseLinkConfig(link.configJson);
        const today = toIsoDate(new Date());
        const { startDate, endDate } = buildSyncWindow({
          lastSyncEndDate: configState.providerSyncState?.windowEndDate ?? undefined,
          today,
          initialDays: effectiveConfig.transactionsInitialDays,
          overlapDays: effectiveConfig.transactionsOverlapDays
        });
        const transactions = await client.transactions.retrieve(link.connection.providerItemId, startDate, {
          account: link.connectionAccount.externalAccountId,
          dateTo: endDate,
          saveData: false
        });
        const normalized = transactions
          .map((transaction: BelvoTransaction) => normalizeBelvoTransaction(transaction))
          .filter((transaction): transaction is NonNullable<typeof transaction> => Boolean(transaction));

        await database.connection.update({
          where: {
            id: link.connection.id
          },
          data: {
            status: "ACTIVE",
            lastRefreshedAt: new Date(),
            metadataJson: JSON.stringify({
              belvo: {
                environment: effectiveConfig.environment,
                linkId: link.connection.providerItemId
              },
              health: clearSyncHealth()
            })
          }
        });

        return sanitizeProviderSyncResult({
          imported: normalized.length,
          transactions: normalized,
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
        const health = toSyncHealth(classifyBelvoError(error));
        await database.connection.update({
          where: {
            id: link.connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              belvo: {
                environment: effectiveConfig.environment,
                linkId: link.connection.providerItemId
              },
              health
            })
          }
        });
        throw classifyBelvoError(error);
      }
    }
  };
}

export const belvoService = createBelvoService();
