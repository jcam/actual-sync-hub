import type {
  ConnectionReauthSessionDto,
  ProviderConnectResult,
  SaltEdgeProviderSettingsDto,
  SaltEdgeConnectSessionDto
} from "@actual-sync/shared";
import { getSaltEdgeIncludeSandboxes } from "@actual-sync/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { buildProviderCategoryNames } from "./category-matching.js";
import { parseLinkConfig } from "./link-config.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;
type FetchLike = typeof fetch;

const SALT_EDGE_API_BASE_URL = "https://www.saltedge.com/api/v6";

type SaltEdgeCustomer = {
  id: string;
  customer_id?: string | null;
  secret?: string | null;
  identifier?: string | null;
};

type SaltEdgeConnection = {
  id: string;
  secret?: string | null;
  customer_id: string;
  provider_id?: string | null;
  provider_code?: string | null;
  provider_name?: string | null;
  country_code?: string | null;
  status: "active" | "inactive" | "disabled";
  updated_at?: string | null;
  last_success_at?: string | null;
  next_refresh_possible_at?: string | null;
  last_attempt?: {
    fail_error_class?: string | null;
    fail_message?: string | null;
    updated_at?: string | null;
    success_at?: string | null;
    fail_at?: string | null;
  } | null;
  last_consent_id?: string | null;
};

type SaltEdgeAccount = {
  id: string;
  name: string;
  nature?: string | null;
  balance?: number | null;
  currency_code?: string | null;
  extra?: {
    client_name?: string | null;
    cards?: string[] | null;
  } | null;
  updated_at?: string | null;
};

type SaltEdgeTransaction = {
  id: string;
  mode?: "normal" | "fee" | "transfer" | null;
  status?: "posted" | "pending" | null;
  made_on?: string | null;
  amount?: number | null;
  description?: string | null;
  category?: string | null;
  duplicated?: boolean | null;
  extra?: Record<string, unknown> | null;
};

type SaltEdgeApiEnvelope<T> = {
  data: T;
  meta?: {
    next_id?: string | null;
  } | null;
  error_class?: string | null;
  error_message?: string | null;
};

type SaltEdgeSettings = SaltEdgeProviderSettingsDto;

const SALT_EDGE_CONSENT_SCOPES = ["accounts", "transactions"] as const;
const SALT_EDGE_FETCH_SCOPES = ["accounts", "balance", "transactions"] as const;

export type SaltEdgeService = ProviderAdapter & {
  createConnectSession(args: { userId: string; label?: string | null }): Promise<SaltEdgeConnectSessionDto>;
  finalizeConnection(args: {
    connectionId: string;
    customerId?: string | null;
    connectionSecret?: string | null;
    label?: string | null;
  }): Promise<ProviderConnectResult>;
};

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number) {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return toIsoDate(base);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMask(account: SaltEdgeAccount) {
  const cards = Array.isArray(account.extra?.cards) ? account.extra.cards : [];
  for (const card of cards) {
    const digits = card.replace(/\D+/g, "");
    if (digits.length >= 4) {
      return digits.slice(-4);
    }
  }

  return null;
}

function normalizeLabel(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function getSaltEdgeCustomerId(customer: SaltEdgeCustomer) {
  return customer.customer_id ?? customer.id;
}

function buildSaltEdgeReturnToUrl() {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/connections/saltedge`;
}

function classifySaltEdgeFailureMessage(message: string, errorClass?: string | null) {
  const normalized = `${errorClass || ""} ${message}`.toLowerCase();

  if (
    normalized.includes("ratelimitexceeded") ||
    normalized.includes("backgroundfetchlimitexceeded") ||
    normalized.includes("rate limit")
  ) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (normalized.includes("consentexpired") || normalized.includes("consentrevoked")) {
    return new ProviderOperationError(message, {
      code: errorClass ?? "CONSENT_INVALID",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "REAUTH_CONNECTION"
    });
  }

  if (
    normalized.includes("invalid credentials") ||
    normalized.includes("credentials") ||
    normalized.includes("account blocked") ||
    normalized.includes("provider asked to update") ||
    normalized.includes("no active accounts were found")
  ) {
    return new ProviderOperationError(message, {
      code: errorClass ?? "ACCOUNT_NEEDS_ATTENTION",
      healthState: normalized.includes("invalid credentials") ? "REAUTH_REQUIRED" : "ATTENTION_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "REAUTH_BANK"
    });
  }

  if (normalized.includes("providerinactive") || normalized.includes("providerdisabled")) {
    return new ProviderOperationError(message, {
      code: errorClass ?? "PROVIDER_UNAVAILABLE",
      healthState: "ATTENTION_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "CHECK_PROVIDER"
    });
  }

  if (normalized.includes("connectionnotfound")) {
    return new ProviderOperationError(message, {
      code: errorClass ?? "CONNECTION_NOT_FOUND",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "REAUTH_CONNECTION"
    });
  }

  return new ProviderOperationError(message, {
    code: errorClass ?? undefined,
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

function classifySaltEdgeError(error: unknown) {
  if (error instanceof ProviderOperationError) {
    return error;
  }

  if (error instanceof Error) {
    return classifySaltEdgeFailureMessage(error.message);
  }

  return classifySaltEdgeFailureMessage(String(error));
}

function buildRemoteConnectionHealth(connection: SaltEdgeConnection) {
  if (connection.status === "active") {
    return clearSyncHealth();
  }

  const failMessage = connection.last_attempt?.fail_message?.trim() || `Salt Edge connection is ${connection.status}.`;
  return toSyncHealth(
    classifySaltEdgeFailureMessage(failMessage, connection.last_attempt?.fail_error_class ?? null),
    {
      scope: "CONNECTION_AUTH",
      action: "REAUTH_CONNECTION",
      code: connection.last_attempt?.fail_error_class ?? null
    }
  );
}

function buildConnectionMetadata(connection: SaltEdgeConnection, health: ReturnType<typeof buildRemoteConnectionHealth>) {
  return {
    saltEdge: {
      customerId: connection.customer_id,
      providerId: connection.provider_id ?? null,
      providerCode: connection.provider_code ?? null,
      providerName: connection.provider_name ?? null,
      countryCode: connection.country_code ?? null,
      nextRefreshPossibleAt: connection.next_refresh_possible_at ?? null,
      lastSuccessAt: connection.last_success_at ?? null,
      lastAttemptUpdatedAt: connection.last_attempt?.updated_at ?? null,
      lastFailErrorClass: connection.last_attempt?.fail_error_class ?? null,
      lastFailMessage: connection.last_attempt?.fail_message ?? null,
      lastConsentId: connection.last_consent_id ?? null,
      remoteStatus: connection.status
    },
    health
  };
}

function buildConnectionStatus(connection: SaltEdgeConnection) {
  if (connection.status === "disabled") {
    return "DISCONNECTED" as const;
  }

  return connection.status === "active" ? ("ACTIVE" as const) : ("ERROR" as const);
}

function normalizeSaltEdgeTransaction(transaction: SaltEdgeTransaction) {
  if (
    transaction.status !== "posted" ||
    !transaction.id ||
    !transaction.made_on ||
    typeof transaction.amount !== "number" ||
    !Number.isFinite(transaction.amount)
  ) {
    return null;
  }

  const categoryNames = [
    ...(transaction.mode === "transfer" ? ["TRANSFER"] : []),
    ...buildProviderCategoryNames(transaction.category)
  ];
  const payeeName = transaction.description?.trim() || "Salt Edge transaction";

  return {
    date: transaction.made_on,
    amount: transaction.amount,
    payeeName,
    importedPayee: payeeName,
    importedId: transaction.id,
    cleared: true,
    categoryNames: categoryNames.length > 0 ? categoryNames : undefined,
    searchText: transaction.description ? [transaction.description] : undefined
  };
}

export function createSaltEdgeService({
  prisma: database = prisma,
  fetchImpl = fetch,
  now = () => new Date(),
  providerSettings = createProviderSettingsService({ prisma: database })
}: {
  prisma?: DatabaseClient;
  fetchImpl?: FetchLike;
  now?: () => Date;
  providerSettings?: ProviderSettingsService;
} = {}): SaltEdgeService {
  const getSettings = () => providerSettings.get("SALT_EDGE");

  const requestSaltEdge = async <T>({
    path,
    method = "GET",
    data,
    settings
  }: {
    path: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    data?: Record<string, unknown>;
    settings?: SaltEdgeSettings;
  }): Promise<T> => {
    const effectiveSettings = settings ?? (await getSettings());
    if (!effectiveSettings.appId.trim() || !effectiveSettings.secret) {
      throw new Error("Salt Edge credentials are not configured");
    }

    const response = await fetchImpl(`${SALT_EDGE_API_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "App-id": effectiveSettings.appId.trim(),
        Secret: effectiveSettings.secret
      },
      body: data ? JSON.stringify({ data }) : undefined
    });

    const payload = (await response.json().catch(() => null)) as SaltEdgeApiEnvelope<T> | null;

    if (!response.ok || (payload?.error_class && payload?.error_message)) {
      const message =
        payload?.error_message ||
        payload?.error_class ||
        `Salt Edge request failed with status ${response.status}`;
      throw classifySaltEdgeFailureMessage(message, payload?.error_class ?? null);
    }

    if (!payload) {
      throw new Error("Salt Edge returned an empty response");
    }

    return payload.data;
  };

  const listSaltEdgePages = async <T>({
    path,
    settings
  }: {
    path: string;
    settings?: SaltEdgeSettings;
  }) => {
    const effectiveSettings = settings ?? (await getSettings());
    const results: T[] = [];
    let nextPath: string | null = path;

    while (nextPath) {
      const response = await fetchImpl(`${SALT_EDGE_API_BASE_URL}${nextPath}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "App-id": effectiveSettings.appId.trim(),
          Secret: effectiveSettings.secret
        }
      });

      const payload = (await response.json().catch(() => null)) as SaltEdgeApiEnvelope<T[]> | null;
      if (!response.ok || (payload?.error_class && payload?.error_message)) {
        const message =
          payload?.error_message ||
          payload?.error_class ||
          `Salt Edge request failed with status ${response.status}`;
        throw classifySaltEdgeFailureMessage(message, payload?.error_class ?? null);
      }

      if (!payload) {
        throw new Error("Salt Edge returned an empty response");
      }

      results.push(...payload.data);
      nextPath = payload.meta?.next_id ? `${path}${path.includes("?") ? "&" : "?"}from_id=${payload.meta.next_id}` : null;
    }

    return results;
  };

  const showConnection = (connectionId: string, settings?: SaltEdgeSettings) =>
    requestSaltEdge<SaltEdgeConnection>({
      path: `/connections/${connectionId}`,
      settings
    });

  const buildConsent = (settings: SaltEdgeSettings, fromDate: string) => ({
    scopes: [...SALT_EDGE_CONSENT_SCOPES],
    from_date: fromDate,
    period_days: settings.consentDays
  });

  const buildAttempt = (fromDate: string, label?: string | null) => ({
    fetch_scopes: [...SALT_EDGE_FETCH_SCOPES],
    fetch_from_date: fromDate,
    return_to: buildSaltEdgeReturnToUrl(),
    custom_fields: normalizeLabel(label) ? { label: normalizeLabel(label) } : {}
  });

  const buildWidget = () => ({
    javascript_callback_type: "post_message" as const,
    show_consent_confirmation: false,
    skip_stages_screen: true
  });

  const buildProvider = (settings: SaltEdgeSettings) => ({
    include_sandboxes: getSaltEdgeIncludeSandboxes(settings)
  });

  const listAccounts = (connectionId: string, settings?: SaltEdgeSettings) =>
    listSaltEdgePages<SaltEdgeAccount>({
      path: `/accounts?connection_id=${encodeURIComponent(connectionId)}`,
      settings
    });

  const listTransactions = ({
    connectionId,
    accountId,
    fromId,
    settings
  }: {
    connectionId: string;
    accountId: string;
    fromId?: string | null;
    settings?: SaltEdgeSettings;
  }) =>
    listSaltEdgePages<SaltEdgeTransaction>({
      path: `/transactions?connection_id=${encodeURIComponent(connectionId)}&account_id=${encodeURIComponent(accountId)}${
        fromId ? `&from_id=${encodeURIComponent(fromId)}` : ""
      }`,
      settings
    });

  const upsertConnectionState = async ({
    remoteConnection,
    remoteAccounts,
    label,
    connectionSecret
  }: {
    remoteConnection: SaltEdgeConnection;
    remoteAccounts: SaltEdgeAccount[];
    label?: string | null;
    connectionSecret?: string | null;
  }) => {
    const health = buildRemoteConnectionHealth(remoteConnection);
    const metadata = buildConnectionMetadata(remoteConnection, health);
    const remoteLabel = normalizeLabel(label) || remoteConnection.provider_name || `Salt Edge ${remoteConnection.id}`;
    const existing = await database.connection.findUnique({
      where: {
        provider_providerItemId: {
          provider: "SALT_EDGE",
          providerItemId: remoteConnection.id
        }
      }
    });

    const connection = existing
      ? await database.connection.update({
          where: {
            id: existing.id
          },
          data: {
            label: remoteLabel,
            status: buildConnectionStatus(remoteConnection),
            institutionName: remoteConnection.provider_name ?? null,
            institutionId: remoteConnection.provider_code ?? remoteConnection.provider_id ?? null,
            accessTokenCiphertext:
              connectionSecret != null ? encryptString(connectionSecret) : existing.accessTokenCiphertext,
            metadataJson: JSON.stringify(metadata),
            lastRefreshedAt: now()
          }
        })
      : await database.connection.create({
          data: {
            provider: "SALT_EDGE",
            providerItemId: remoteConnection.id,
            label: remoteLabel,
            status: buildConnectionStatus(remoteConnection),
            institutionName: remoteConnection.provider_name ?? null,
            institutionId: remoteConnection.provider_code ?? remoteConnection.provider_id ?? null,
            accessTokenCiphertext: encryptString(connectionSecret ?? remoteConnection.secret ?? remoteConnection.id),
            metadataJson: JSON.stringify(metadata),
            lastRefreshedAt: now()
          }
        });

    await database.$transaction(async tx => {
      await tx.connectionAccount.deleteMany({
        where: {
          connectionId: connection.id
        }
      });

      if (remoteAccounts.length === 0) {
        return;
      }

      await tx.connectionAccount.createMany({
        data: remoteAccounts.map(account => ({
          connectionId: connection.id,
          externalAccountId: account.id,
          name: account.name,
          officialName: account.extra?.client_name ?? account.name,
          mask: parseMask(account),
          type: "bank",
          subtype: account.nature ?? null,
          currentBalance: account.balance ?? null,
          availableBalance: null,
          providerConnectionId: remoteConnection.id,
          providerConnectionName: remoteConnection.provider_name ?? null,
          providerInstitutionId: remoteConnection.provider_id ?? null,
          providerInstitutionDomain: null,
          rawJson: JSON.stringify(account)
        }))
      });
    });

    return {
      connectionId: connection.id,
      warning: health?.message || undefined
    } satisfies ProviderConnectResult;
  };

  const markConnectionHealthy = async (connectionId: string, remoteConnection?: SaltEdgeConnection) => {
    const nextConnection = remoteConnection ?? (await showConnection(connectionId));
    const current = await database.connection.findUnique({
      where: {
        provider_providerItemId: {
          provider: "SALT_EDGE",
          providerItemId: connectionId
        }
      }
    });

    if (!current) {
      return;
    }

    const metadata = buildConnectionMetadata(nextConnection, clearSyncHealth());
    await database.connection.update({
      where: {
        id: current.id
      },
      data: {
        status: buildConnectionStatus(nextConnection),
        institutionName: nextConnection.provider_name ?? null,
        institutionId: nextConnection.provider_code ?? nextConnection.provider_id ?? null,
        metadataJson: JSON.stringify(metadata),
        lastRefreshedAt: now()
      }
    });
  };

  const markConnectionError = async (localConnectionId: string, error: unknown) => {
    const providerError = classifySaltEdgeError(error);
    const connection = await database.connection.findUnique({
      where: {
        id: localConnectionId
      }
    });

    if (connection) {
      let metadata: Record<string, unknown> = {};
      if (connection.metadataJson) {
        try {
          metadata = JSON.parse(connection.metadataJson) as Record<string, unknown>;
        } catch {
          metadata = {};
        }
      }

      await database.connection.update({
        where: {
          id: localConnectionId
        },
        data: {
          status: providerError.healthState === "REAUTH_REQUIRED" ? "DISCONNECTED" : "ERROR",
          metadataJson: JSON.stringify({
            ...metadata,
            health: toSyncHealth(providerError)
          })
        }
      });
    }

    return providerError;
  };

  const pollForRefreshCompletion = async ({
    connectionId,
    previousUpdatedAt,
    settings
  }: {
    connectionId: string;
    previousUpdatedAt?: string | null;
    settings: SaltEdgeSettings;
  }) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const remoteConnection = await showConnection(connectionId, settings);
      if (
        !previousUpdatedAt ||
        remoteConnection.updated_at !== previousUpdatedAt ||
        Boolean(remoteConnection.last_attempt?.success_at) ||
        Boolean(remoteConnection.last_attempt?.fail_at)
      ) {
        return remoteConnection;
      }

      await sleep(1000);
    }

    return showConnection(connectionId, settings);
  };

  return {
    provider: "SALT_EDGE",

    isConfigured() {
      return true;
    },

    async createConnectSession({ userId, label }) {
      const settings = await getSettings();
      if (!settings.appId.trim() || !settings.secret) {
        throw new Error("Salt Edge credentials are not configured");
      }

      const customer = await requestSaltEdge<SaltEdgeCustomer>({
        path: "/customers",
        method: "POST",
        data: {
          identifier: `${userId}:${Date.now()}`
        },
        settings
      });
      const today = toIsoDate(now());
      const fromDate = shiftIsoDate(today, -(settings.transactionsFetchDays - 1));
      const session = await requestSaltEdge<{
        connect_url: string;
        expires_at: string;
        customer_id?: string;
      }>({
        path: "/connections/connect",
        method: "POST",
        data: {
          customer_id: getSaltEdgeCustomerId(customer),
          consent: buildConsent(settings, fromDate),
          attempt: buildAttempt(fromDate, label),
          widget: buildWidget(),
          provider: buildProvider(settings),
          return_error_class: true,
          automatic_refresh: true
        },
        settings
      });

      return {
        connectUrl: session.connect_url,
        expiresAt: session.expires_at,
        customerId: session.customer_id ?? getSaltEdgeCustomerId(customer)
      };
    },

    async finalizeConnection({ connectionId, customerId, connectionSecret, label }) {
      const settings = await getSettings();
      const remoteConnection = await showConnection(connectionId, settings);
      const remoteAccounts = await listAccounts(connectionId, settings);
      return upsertConnectionState({
        remoteConnection: {
          ...remoteConnection,
          customer_id: remoteConnection.customer_id || customerId || ""
        },
        remoteAccounts,
        label,
        connectionSecret
      });
    },

    async createReauthSession({
      connectionId
    }: {
      connectionId: string;
      userId: string;
    }): Promise<ConnectionReauthSessionDto> {
      const settings = await getSettings();
      const localConnection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (localConnection.provider !== "SALT_EDGE" || !localConnection.providerItemId) {
        throw new Error("Connection is not a Salt Edge connection");
      }

      const today = toIsoDate(now());
      const fromDate = shiftIsoDate(today, -(settings.transactionsFetchDays - 1));
      const session = await requestSaltEdge<{
        connect_url: string;
        expires_at?: string;
        customer_id?: string;
      }>({
        path: `/connections/${localConnection.providerItemId}/reconnect`,
        method: "POST",
        data: {
          consent: buildConsent(settings, fromDate),
          attempt: buildAttempt(fromDate),
          widget: buildWidget(),
          return_error_class: true,
          automatic_refresh: true
        },
        settings
      });

      return {
        provider: "SALT_EDGE",
        connectionId,
        mode: "saltedge_connect",
        connectUrl: session.connect_url
      };
    },

    async disconnectConnection(connectionId: string) {
      const localConnection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (localConnection.provider !== "SALT_EDGE" || !localConnection.providerItemId) {
        throw new Error("Connection is not a Salt Edge connection");
      }

      try {
        await requestSaltEdge<{ id: string; removed: boolean }>({
          path: `/connections/${localConnection.providerItemId}`,
          method: "DELETE"
        });
      } catch (error) {
        const providerError = classifySaltEdgeError(error);
        if (providerError.code !== "CONNECTION_NOT_FOUND") {
          throw providerError;
        }
      }
    },

    async refreshConnection(connectionId: string) {
      const localConnection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (localConnection.provider !== "SALT_EDGE" || !localConnection.providerItemId) {
        throw new Error("Connection is not a Salt Edge connection");
      }

      const settings = await getSettings();

      try {
        const before = await showConnection(localConnection.providerItemId, settings);
        await requestSaltEdge<{
          connect_url?: string;
          expires_at?: string;
          customer_id?: string;
        }>({
          path: `/connections/${localConnection.providerItemId}/refresh`,
          method: "POST",
          data: {
            attempt: buildAttempt(shiftIsoDate(toIsoDate(now()), -(settings.transactionsFetchDays - 1))),
            widget: buildWidget(),
            return_error_class: true
          },
          settings
        });

        const remoteConnection = await pollForRefreshCompletion({
          connectionId: localConnection.providerItemId,
          previousUpdatedAt: before.updated_at ?? null,
          settings
        });
        const remoteAccounts = await listAccounts(localConnection.providerItemId, settings);
        await upsertConnectionState({
          remoteConnection,
          remoteAccounts,
          label: localConnection.label,
          connectionSecret: decryptString(localConnection.accessTokenCiphertext)
        });
        await markConnectionHealthy(localConnection.providerItemId, remoteConnection);
      } catch (error) {
        throw await markConnectionError(localConnection.id, error);
      }
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const link = await database.accountLink.findUniqueOrThrow({
        where: {
          id: linkId
        },
        include: {
          connection: true,
          connectionAccount: true
        }
      });

      if (!link.connection || !link.connectionAccount || link.connection.provider !== "SALT_EDGE" || !link.connection.providerItemId) {
        return {
          imported: 0,
          transactions: [],
          removedImportedIds: []
        };
      }

      try {
        const remoteConnection = await showConnection(link.connection.providerItemId);
        const health = buildRemoteConnectionHealth(remoteConnection);
        if (health) {
          throw classifySaltEdgeFailureMessage(
            health.message || "Salt Edge connection requires attention.",
            health.code
          );
        }

        const remoteAccounts = await listAccounts(link.connection.providerItemId);
        const remoteAccount = remoteAccounts.find(account => account.id === link.connectionAccount!.externalAccountId);
        if (!remoteAccount) {
          throw new Error(
            `Salt Edge account ${link.connectionAccount.externalAccountId} was not returned by the provider`
          );
        }

        await database.connectionAccount.update({
          where: {
            id: link.connectionAccount.id
          },
          data: {
            name: remoteAccount.name,
            officialName: remoteAccount.extra?.client_name ?? remoteAccount.name,
            mask: parseMask(remoteAccount),
            subtype: remoteAccount.nature ?? null,
            currentBalance: remoteAccount.balance ?? null,
            rawJson: JSON.stringify(remoteAccount)
          }
        });
        await markConnectionHealthy(link.connection.providerItemId, remoteConnection);

        const config = parseLinkConfig(link.configJson);
        const transactions = (await listTransactions({
          connectionId: link.connection.providerItemId,
          accountId: link.connectionAccount.externalAccountId,
          fromId: config.providerSyncState?.cursor ?? null
        }))
          .map(normalizeSaltEdgeTransaction)
          .filter((transaction): transaction is NonNullable<typeof transaction> => Boolean(transaction));

        const lastImportedId = transactions[transactions.length - 1]?.importedId ?? config.providerSyncState?.cursor ?? null;

        return sanitizeProviderSyncResult({
          imported: transactions.length,
          transactions,
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: lastImportedId,
              windowStartDate: null,
              windowEndDate: null
            }
          }
        });
      } catch (error) {
        throw await markConnectionError(link.connection.id, error);
      }
    }
  };
}

export const saltEdgeService = createSaltEdgeService();
