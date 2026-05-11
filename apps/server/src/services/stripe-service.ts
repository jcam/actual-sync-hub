import type { ProviderConnectResult, SyncHealthDto } from "@actual-sync/shared";
import { getActiveStripeEnvironmentSettings } from "@actual-sync/shared";
import Stripe from "stripe";
import { prisma } from "../db.js";
import { parseJsonObject } from "../lib/json.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { parseLinkConfig } from "./link-config.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

type StripeEnvironmentConfig = {
  publishableKey: string;
  secretKey: string;
  webhookSigningSecrets: string[];
};

type StripeConfig = {
  environment: "test" | "live";
  test: StripeEnvironmentConfig;
  live: StripeEnvironmentConfig;
  countryCodes: string[];
  permissions: Array<"balances" | "transactions" | "ownership" | "payment_method">;
  prefetch: Array<"balances" | "transactions" | "ownership">;
  transactionsInitialDays: number;
  automaticSyncConcurrency: number;
};

type StripeAccount = Stripe.FinancialConnections.Account;
type StripeAuthorization = Stripe.FinancialConnections.Authorization;
type StripeTransaction = Stripe.FinancialConnections.Transaction;
type StripeRefreshFeature = "balance" | "ownership" | "transactions";
type StripeWebhookEventType =
  | "financial_connections.account.created"
  | "financial_connections.account.deactivated"
  | "financial_connections.account.disconnected"
  | "financial_connections.account.reactivated"
  | "financial_connections.account.refreshed_balance"
  | "financial_connections.account.refreshed_ownership"
  | "financial_connections.account.refreshed_transactions";
export type StripeWebhookEvent = Extract<Stripe.Event, { type: StripeWebhookEventType }>;

type StripeConnectionMetadata = {
  stripe?: {
    accountIds?: string[];
    authorizationId?: string | null;
    customerId?: string | null;
    environment?: "test" | "live" | null;
    livemode?: boolean;
    permissions?: string[];
    sessionId?: string | null;
  } | null;
  health?: SyncHealthDto | null;
};

const STRIPE_REFRESH_POLL_INTERVAL_MS = 2_000;
const STRIPE_REFRESH_TIMEOUT_MS = 45_000;

function parseConnectionMetadata(json: string | null | undefined): StripeConnectionMetadata {
  if (!json) {
    return {};
  }

  try {
    const parsed = parseJsonObject(json);
    return parsed ? (parsed as StripeConnectionMetadata) : {};
  } catch {
    return {};
  }
}

function sleep(ms: number) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function getStripeClient(config: StripeConfig) {
  const activeConfig = getActiveStripeEnvironmentSettings(config);
  if (!activeConfig.secretKey) {
    throw new Error("Stripe is not configured");
  }

  return new Stripe(activeConfig.secretKey, {
    maxNetworkRetries: 2
  });
}

function getStripeErrorStatus(error: unknown) {
  return error instanceof Stripe.errors.StripeError ? error.statusCode : undefined;
}

function getStripeErrorCode(error: unknown) {
  return error instanceof Stripe.errors.StripeError ? error.code : undefined;
}

function classifyStripeError(error: unknown) {
  if (error instanceof ProviderOperationError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Unknown Stripe error";
  const normalizedMessage = message.toLowerCase();
  const status = getStripeErrorStatus(error);
  const code = getStripeErrorCode(error);

  if (error instanceof Stripe.errors.StripeRateLimitError || status === 429 || code === "rate_limit" || normalizedMessage.includes("rate limit")) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (
    code === "account_inactive" ||
    code === "account_disconnected" ||
    normalizedMessage.includes("inactive account") ||
    normalizedMessage.includes("relink") ||
    normalizedMessage.includes("disconnected")
  ) {
    return new ProviderOperationError(message, {
      code: code ?? "ACCOUNT_RELINK_REQUIRED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError ||
    status === 401 ||
    status === 403
  ) {
    return new ProviderOperationError(message, {
      code: code ?? "STRIPE_AUTH_FAILED",
      healthState: "ERROR",
      healthScope: "CONNECTION_AUTH",
      healthAction: "RETRY"
    });
  }

  return new ProviderOperationError(message, {
    ...stripUndefined({
      code
    }),
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

function toIsoDate(timestampSeconds: number) {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

function getPrimaryBalanceValue(balance: Record<string, number> | null | undefined) {
  if (!balance) {
    return null;
  }

  const preferred = balance.usd;
  if (typeof preferred === "number" && Number.isFinite(preferred)) {
    return preferred / 100;
  }

  const value = Object.values(balance).find(candidate => typeof candidate === "number" && Number.isFinite(candidate));
  return typeof value === "number" ? value / 100 : null;
}

function getStripeCustomerId(account: StripeAccount) {
  const customer = account.account_holder?.customer;
  if (!customer) {
    return null;
  }

  return typeof customer === "string" ? customer : customer.id;
}

function getUniqueValues<T extends string>(values: Array<T | null | undefined>) {
  return [...new Set(values.filter((value): value is T => Boolean(value)))];
}

function normalizeStripeTransaction(transaction: StripeTransaction): ProviderSyncTransaction | null {
  if (!transaction.id || !Number.isFinite(transaction.amount) || !Number.isFinite(transaction.transacted_at)) {
    return null;
  }

  if (transaction.status === "void") {
    return null;
  }

  const payeeName = transaction.description?.trim() || "Stripe transaction";
  return {
    date: toIsoDate(transaction.transacted_at),
    amount: transaction.amount / 100,
    payeeName,
    importedPayee: payeeName,
    importedId: transaction.id,
    cleared: transaction.status === "posted",
    searchText: [payeeName]
  };
}

async function retrieveStripeAccount(stripe: Stripe, accountId: string): Promise<StripeAccount> {
  return stripe.financialConnections.accounts.retrieve(accountId);
}

async function retrieveStripeAuthorization(stripe: Stripe, authorizationId: string): Promise<StripeAuthorization> {
  return stripe.financialConnections.authorizations.retrieve(authorizationId);
}

async function waitForRefreshCompletion({
  stripe,
  accountId,
  requireBalance,
  requireTransactions
}: {
  stripe: Stripe;
  accountId: string;
  requireBalance: boolean;
  requireTransactions: boolean;
}) {
  const deadline = Date.now() + STRIPE_REFRESH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const account = await retrieveStripeAccount(stripe, accountId);
    const balanceDone = !requireBalance || account.balance_refresh?.status === "succeeded";
    const balanceFailed = requireBalance && account.balance_refresh?.status === "failed";
    const transactionDone = !requireTransactions || account.transaction_refresh?.status === "succeeded";
    const transactionFailed = requireTransactions && account.transaction_refresh?.status === "failed";

    if (balanceFailed || transactionFailed) {
      throw new Error(`Stripe refresh failed for account ${accountId}`);
    }

    if (balanceDone && transactionDone) {
      return account;
    }

    await sleep(STRIPE_REFRESH_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Stripe refresh on account ${accountId}`);
}

async function refreshStripeAccountData({
  stripe,
  account,
  includeBalance,
  includeTransactions
}: {
  stripe: Stripe;
  account: StripeAccount;
  includeBalance: boolean;
  includeTransactions: boolean;
}) {
  if (!account.id) {
    throw new Error("Stripe account is missing an id");
  }

  if (account.status && account.status !== "active") {
    throw new ProviderOperationError("Stripe account needs to be reconnected.", {
      code: "ACCOUNT_RELINK_REQUIRED",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  const features: StripeRefreshFeature[] = [];
  if (includeBalance) {
    features.push("balance");
  }
  if (includeTransactions) {
    features.push("transactions");
  }

  if (features.length === 0) {
    return account;
  }

  await stripe.financialConnections.accounts.refresh(
    account.id,
    {
      features
    }
  );

  return waitForRefreshCompletion({
    stripe,
    accountId: account.id,
    requireBalance: includeBalance,
    requireTransactions: includeTransactions
  });
}

async function listStripeTransactions({
  stripe,
  accountId,
  afterRefreshId,
  initialDays
}: {
  stripe: Stripe;
  accountId: string;
  afterRefreshId?: string | null;
  initialDays: number;
}) {
  const transactions: StripeTransaction[] = [];
  let startingAfter: string | null = null;

  do {
    const startTime = Math.floor(Date.now() / 1000) - (initialDays - 1) * 24 * 60 * 60;
    const page = await stripe.financialConnections.transactions.list(
      stripUndefined({
        account: accountId,
        limit: 100,
        starting_after: startingAfter ?? undefined,
        transaction_refresh: afterRefreshId ? { after: afterRefreshId } : undefined,
        transacted_at: afterRefreshId ? undefined : { gte: startTime }
      })
    );
    transactions.push(...page.data);
    startingAfter = page.has_more ? (page.data[page.data.length - 1]?.id ?? null) : null;
  } while (startingAfter);

  return transactions;
}

async function replaceConnectionAccounts({
  database,
  connectionId,
  accounts
}: {
  database: DatabaseClient;
  connectionId: string;
  accounts: StripeAccount[];
}) {
  const existingAccounts = await database.connectionAccount.findMany({
    where: {
      connectionId
    },
    select: {
      id: true,
      externalAccountId: true
    }
  });
  const existingIdsByExternalAccountId = new Map(
    existingAccounts.map(account => [account.externalAccountId, account.id])
  );
  const nextExternalAccountIds = new Set(accounts.map(account => account.id));

  for (const account of accounts) {
    const data = {
      name: account.display_name || account.institution_name || "Stripe account",
      officialName: null,
      mask: account.last4 || null,
      type: account.category || "bank_account",
      subtype: account.subcategory || null,
      currentBalance: getPrimaryBalanceValue(account.balance?.current),
      availableBalance: getPrimaryBalanceValue(account.balance?.cash?.available),
      rawJson: JSON.stringify(account)
    };
    const existingId = existingIdsByExternalAccountId.get(account.id);

    if (existingId) {
      await database.connectionAccount.update({
        where: {
          id: existingId
        },
        data
      });
      continue;
    }

    await database.connectionAccount.create({
      data: {
        connectionId,
        externalAccountId: account.id,
        ...data
      }
    });
  }

  const staleAccountIds = existingAccounts
    .filter(account => !nextExternalAccountIds.has(account.externalAccountId))
    .map(account => account.id);

  if (staleAccountIds.length > 0) {
    await database.connectionAccount.deleteMany({
      where: {
        id: {
          in: staleAccountIds
        }
      }
    });
  }
}

export type StripeService = {
  createConnectSession(userId: string): Promise<{
    sessionId: string;
    clientSecret: string;
    publishableKey: string;
  }>;
  webhooksConfigured(): Promise<boolean>;
  constructWebhookEvent(rawBody: Buffer | string, signatureHeader: string | string[] | undefined): Promise<StripeWebhookEvent | Stripe.Event | null>;
  getAuthorization(authorizationId: string): Promise<StripeAuthorization>;
  syncAccountLinkFromWebhook(linkId: string): Promise<ProviderSyncResult>;
  finalizeReauthSession(args: {
    connectionId: string;
    accountIds: string[];
    sessionId?: string | null;
  }): Promise<ProviderConnectResult>;
  finalizeAccounts(args: {
    accountIds: string[];
    label?: string | null;
    sessionId?: string | null;
  }): Promise<ProviderConnectResult>;
} & ProviderAdapter;

export function createStripeService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
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
  } satisfies StripeConfig
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: StripeConfig;
} = {}): StripeService {
  const getEffectiveConfig = async (): Promise<StripeConfig> => {
    const settings = await providerSettings.get("STRIPE");
    return {
      ...config,
      environment: settings.environment,
      test: {
        publishableKey: settings.test.publishableKey,
        secretKey: settings.test.secretKey,
        webhookSigningSecrets: settings.test.webhookSigningSecrets
      },
      live: {
        publishableKey: settings.live.publishableKey,
        secretKey: settings.live.secretKey,
        webhookSigningSecrets: settings.live.webhookSigningSecrets
      },
      countryCodes: settings.countryCodes,
      permissions: settings.permissions,
      prefetch: settings.prefetch,
      transactionsInitialDays: settings.transactionsInitialDays,
      automaticSyncConcurrency: settings.automaticSyncConcurrency
    };
  };

  const createFinancialConnectionsSession = async ({
    stripe,
    customerId,
    permissions,
    prefetch,
    relinkOptions
  }: {
    stripe: Stripe;
    customerId: string;
    permissions: StripeConfig["permissions"];
    prefetch: StripeConfig["prefetch"];
    relinkOptions?: {
      authorization: string;
      account?: string;
    };
  }) => {
    const effectiveConfig = await getEffectiveConfig();
    const activeConfig = getActiveStripeEnvironmentSettings(effectiveConfig);

    if (!activeConfig.publishableKey) {
      throw new Error("Stripe is not configured");
    }

    const session = await stripe.financialConnections.sessions.create({
      account_holder: {
        type: "customer",
        customer: customerId
      },
      filters: {
        countries: effectiveConfig.countryCodes
      },
      permissions,
      prefetch,
      ...(relinkOptions ? { relink_options: relinkOptions } : {})
    });

    if (!session.client_secret) {
      throw new Error("Stripe did not return a Financial Connections client secret.");
    }

    return {
      sessionId: session.id,
      clientSecret: session.client_secret,
      publishableKey: activeConfig.publishableKey
    };
  };

  const syncStripeAccountLink = async ({
    linkId,
    skipRefresh
  }: {
    linkId: string;
    skipRefresh: boolean;
  }): Promise<ProviderSyncResult> => {
    const effectiveConfig = await getEffectiveConfig();
    const stripe = getStripeClient(effectiveConfig);
    const link = await database.accountLink.findUniqueOrThrow({
      where: {
        id: linkId
      },
      include: {
        connection: true,
        connectionAccount: true
      }
    });

    if (!link.connection || !link.connectionAccount) {
      return {
        imported: 0,
        transactions: [],
        removedImportedIds: [],
        configPatch: {}
      };
    }

    try {
      const connectionMetadata = parseConnectionMetadata(link.connection.metadataJson);
      const account = await retrieveStripeAccount(stripe, link.connectionAccount.externalAccountId);
      const syncedAccount = skipRefresh
        ? account
        : await refreshStripeAccountData({
            stripe,
            account,
            includeBalance: Boolean(account.permissions?.includes("balances")),
            includeTransactions: true
          });

      await database.connectionAccount.update({
        where: {
          id: link.connectionAccount.id
        },
        data: {
          name: syncedAccount.display_name || syncedAccount.institution_name || link.connectionAccount.name,
          mask: syncedAccount.last4 || null,
          type: syncedAccount.category || link.connectionAccount.type,
          subtype: syncedAccount.subcategory || null,
          currentBalance: getPrimaryBalanceValue(syncedAccount.balance?.current),
          availableBalance: getPrimaryBalanceValue(syncedAccount.balance?.cash?.available),
          rawJson: JSON.stringify(syncedAccount)
        }
      });

      const existingConfig = parseLinkConfig(link.configJson);
      const transactions = await listStripeTransactions({
        stripe,
        accountId: syncedAccount.id,
        afterRefreshId: existingConfig.providerSyncState?.cursor ?? null,
        initialDays: effectiveConfig.transactionsInitialDays
      });
      const removedImportedIds = transactions
        .filter(transaction => transaction.status === "void")
        .map(transaction => transaction.id);
      const syncedTransactions = transactions
        .map(transaction => normalizeStripeTransaction(transaction))
        .filter((transaction): transaction is ProviderSyncTransaction => Boolean(transaction));

      await database.connection.update({
        where: {
          id: link.connection.id
        },
        data: {
          status: "ACTIVE",
          lastRefreshedAt: new Date(),
          metadataJson: JSON.stringify({
            ...connectionMetadata,
            health: clearSyncHealth()
          } satisfies StripeConnectionMetadata)
        }
      });

      return sanitizeProviderSyncResult({
        imported: syncedTransactions.length,
        transactions: syncedTransactions,
        removedImportedIds,
        configPatch: {
          providerSyncState: {
            cursor: syncedAccount.transaction_refresh?.id ?? existingConfig.providerSyncState?.cursor ?? null,
            windowStartDate: null,
            windowEndDate: null
          }
        }
      });
    } catch (error) {
      const metadata = parseConnectionMetadata(link.connection.metadataJson);
      const health = toSyncHealth(classifyStripeError(error));
      await database.connection.update({
        where: {
          id: link.connection.id
        },
        data: {
          status: "ERROR",
          metadataJson: JSON.stringify({
            ...metadata,
            health
          } satisfies StripeConnectionMetadata)
        }
      });
      throw classifyStripeError(error);
    }
  };

  return {
    provider: "STRIPE",

    isConfigured() {
      return false;
    },

    async webhooksConfigured() {
      const effectiveConfig = await getEffectiveConfig();
      const activeConfig = getActiveStripeEnvironmentSettings(effectiveConfig);
      return activeConfig.webhookSigningSecrets.length > 0;
    },

    async constructWebhookEvent(rawBody: Buffer | string, signatureHeader: string | string[] | undefined) {
      const effectiveConfig = await getEffectiveConfig();
      const activeConfig = getActiveStripeEnvironmentSettings(effectiveConfig);
      if (activeConfig.webhookSigningSecrets.length === 0) {
        return null;
      }

      const signatureValue = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!signatureValue) {
        return null;
      }

      const stripe = getStripeClient(effectiveConfig);
      const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");

      for (const secret of activeConfig.webhookSigningSecrets) {
        try {
          return stripe.webhooks.constructEvent(payload, signatureValue, secret);
        } catch {
          continue;
        }
      }

      return null;
    },

    async getAuthorization(authorizationId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      return retrieveStripeAuthorization(stripe, authorizationId);
    },

    async syncAccountLinkFromWebhook(linkId: string) {
      return syncStripeAccountLink({
        linkId,
        skipRefresh: true
      });
    },

    async createConnectSession(userId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const activeConfig = getActiveStripeEnvironmentSettings(effectiveConfig);
      if (!activeConfig.publishableKey || !activeConfig.secretKey) {
        throw new Error("Stripe is not configured");
      }
      const stripe = getStripeClient(effectiveConfig);

      const customer = await stripe.customers.create({
        name: `Actual Sync Hub ${userId}`,
        metadata: {
          actual_sync_user_id: userId
        }
      });
      return createFinancialConnectionsSession({
        stripe,
        customerId: customer.id,
        permissions: effectiveConfig.permissions,
        prefetch: effectiveConfig.prefetch
      });
    },

    async createReauthSession({
      connectionId
    }: {
      connectionId: string;
      userId: string;
    }) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        include: {
          accounts: {
            orderBy: {
              createdAt: "asc"
            }
          }
        }
      });

      if (connection.provider !== "STRIPE") {
        throw new Error("Connection is not a Stripe Financial Connections account");
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const fallbackAccount =
        connection.accounts.length > 0 ? await retrieveStripeAccount(stripe, connection.accounts[0]!.externalAccountId) : null;
      const customerId = metadata.stripe?.customerId ?? (fallbackAccount ? getStripeCustomerId(fallbackAccount) : null);
      const authorizationId = metadata.stripe?.authorizationId ?? fallbackAccount?.authorization ?? connection.providerItemId ?? null;

      if (!customerId || !authorizationId) {
        return {
          provider: "STRIPE",
          connectionId,
          mode: "manual",
          message: "Stripe relink is unavailable for this connection. Reconnect it from the Stripe Connections page."
        };
      }

      const authorization = await retrieveStripeAuthorization(stripe, authorizationId);
      if (
        authorization.status === "inactive" &&
        authorization.status_details.inactive?.action !== "relink_required"
      ) {
        return {
          provider: "STRIPE",
          connectionId,
          mode: "manual",
          message: "Stripe reported that this authorization cannot be repaired with relink. Reconnect it from the Stripe Connections page."
        };
      }

      const permissions = getUniqueValues([
        ...effectiveConfig.permissions,
        ...(metadata.stripe?.permissions ?? [])
      ]) as StripeConfig["permissions"];
      const prefetch = getUniqueValues(effectiveConfig.prefetch) as StripeConfig["prefetch"];
      const targetAccountId = connection.accounts.length === 1 ? connection.accounts[0]!.externalAccountId : undefined;
      const session = await createFinancialConnectionsSession({
        stripe,
        customerId,
        permissions,
        prefetch,
        relinkOptions: {
          authorization: authorizationId,
          ...(targetAccountId ? { account: targetAccountId } : {})
        }
      });

      return {
        provider: "STRIPE",
        connectionId,
        mode: "stripe_relink",
        ...session
      };
    },

    async finalizeAccounts({
      accountIds,
      label,
      sessionId
    }: {
      accountIds: string[];
      label?: string | null;
      sessionId?: string | null;
    }) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      const uniqueAccountIds = [...new Set(accountIds.map(accountId => accountId.trim()).filter(Boolean))];
      if (uniqueAccountIds.length === 0) {
        throw new Error("No Stripe accounts were returned from Financial Connections.");
      }

      const accounts = await Promise.all(uniqueAccountIds.map(accountId => retrieveStripeAccount(stripe, accountId)));
      const primaryAccount = accounts[0];
      const authorizationId =
        accounts.every(account => account.authorization && account.authorization === primaryAccount?.authorization)
          ? primaryAccount?.authorization ?? null
          : null;
      const institutionName = primaryAccount?.institution_name || "Stripe Financial Connections";
      const connectionLabel = label?.trim() || institutionName;
      const metadata = {
        stripe: {
          accountIds: uniqueAccountIds,
          authorizationId,
          customerId: primaryAccount ? getStripeCustomerId(primaryAccount) : null,
          environment: effectiveConfig.environment,
          livemode: primaryAccount?.livemode ?? effectiveConfig.environment === "live",
          permissions: primaryAccount?.permissions ?? effectiveConfig.permissions,
          sessionId: sessionId ?? null
        },
        health: clearSyncHealth()
      } satisfies StripeConnectionMetadata;

      const connection =
        authorizationId != null
          ? await database.connection.upsert({
              where: {
                provider_providerItemId: {
                  provider: "STRIPE",
                  providerItemId: authorizationId
                }
              },
              update: {
                label: connectionLabel,
                status: "ACTIVE",
                institutionName,
                institutionId: null,
                accessTokenCiphertext: "",
                metadataJson: JSON.stringify(metadata),
                lastRefreshedAt: new Date()
              },
              create: {
                provider: "STRIPE",
                providerItemId: authorizationId,
                label: connectionLabel,
                status: "ACTIVE",
                institutionName,
                institutionId: null,
                accessTokenCiphertext: "",
                metadataJson: JSON.stringify(metadata),
                lastRefreshedAt: new Date()
              }
            })
          : await database.connection.create({
              data: {
                provider: "STRIPE",
                label: connectionLabel,
                status: "ACTIVE",
                institutionName,
                institutionId: null,
                accessTokenCiphertext: "",
                metadataJson: JSON.stringify(metadata),
                lastRefreshedAt: new Date()
              }
            });

      await replaceConnectionAccounts({
        database,
        connectionId: connection.id,
        accounts
      });

      return {
        connectionId: connection.id
      };
    },

    async finalizeReauthSession({
      connectionId,
      accountIds,
      sessionId
    }: {
      connectionId: string;
      accountIds: string[];
      sessionId?: string | null;
    }) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        include: {
          accounts: true
        }
      });

      if (connection.provider !== "STRIPE") {
        throw new Error("Connection is not a Stripe Financial Connections account");
      }

      const uniqueAccountIds = [...new Set(accountIds.map(accountId => accountId.trim()).filter(Boolean))];
      if (uniqueAccountIds.length === 0) {
        throw new Error("No Stripe accounts were returned from Financial Connections relink.");
      }

      const accounts = await Promise.all(uniqueAccountIds.map(accountId => retrieveStripeAccount(stripe, accountId)));
      const primaryAccount = accounts[0];
      const authorizationId =
        accounts.every(account => account.authorization && account.authorization === primaryAccount?.authorization)
          ? primaryAccount?.authorization ?? null
          : null;

      if (authorizationId) {
        const conflictingConnection = await database.connection.findUnique({
          where: {
            provider_providerItemId: {
              provider: "STRIPE",
              providerItemId: authorizationId
            }
          },
          select: {
            id: true
          }
        });

        if (conflictingConnection && conflictingConnection.id !== connectionId) {
          throw new Error("Stripe relink returned an authorization already connected elsewhere. Disconnect the duplicate and try again.");
        }
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const nextMetadata = {
        ...metadata,
        stripe: {
          ...(metadata.stripe ?? {}),
          accountIds: uniqueAccountIds,
          authorizationId,
          customerId: primaryAccount ? getStripeCustomerId(primaryAccount) : metadata.stripe?.customerId ?? null,
          environment: effectiveConfig.environment,
          livemode: primaryAccount?.livemode ?? metadata.stripe?.livemode ?? effectiveConfig.environment === "live",
          permissions: primaryAccount?.permissions ?? metadata.stripe?.permissions ?? effectiveConfig.permissions,
          sessionId: sessionId ?? null
        },
        health: clearSyncHealth()
      } satisfies StripeConnectionMetadata;

      await database.connection.update({
        where: {
          id: connectionId
        },
        data: {
          providerItemId: authorizationId,
          status: "ACTIVE",
          institutionName: primaryAccount?.institution_name || connection.institutionName,
          metadataJson: JSON.stringify(nextMetadata),
          lastRefreshedAt: new Date()
        }
      });

      await replaceConnectionAccounts({
        database,
        connectionId,
        accounts
      });

      return {
        connectionId
      };
    },

    async disconnectConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        include: {
          accounts: true
        }
      });

      if (connection.provider !== "STRIPE") {
        throw new Error("Connection is not a Stripe Financial Connections account");
      }

      for (const account of connection.accounts) {
        try {
          await stripe.financialConnections.accounts.disconnect(
            account.externalAccountId,
            {}
          );
        } catch (error) {
          const providerError = classifyStripeError(error);
          if (providerError.healthAction === "MANUAL_RECONNECT") {
            continue;
          }
          throw providerError;
        }
      }
    },

    async refreshConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const stripe = getStripeClient(effectiveConfig);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        include: {
          accounts: true
        }
      });

      if (connection.provider !== "STRIPE") {
        throw new Error("Connection is not a Stripe Financial Connections account");
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const connectionCanRefreshBalances = metadata.stripe?.permissions?.includes("balances");

      try {
        const refreshedAccounts = await Promise.all(
          connection.accounts.map(async linkedAccount => {
            const account = await retrieveStripeAccount(stripe, linkedAccount.externalAccountId);
            const canRefreshBalance =
              account.permissions?.includes("balances") || connectionCanRefreshBalances;
            return refreshStripeAccountData({
              stripe,
              account,
              includeBalance: Boolean(canRefreshBalance),
              includeTransactions: false
            });
          })
        );

        await replaceConnectionAccounts({
          database,
          connectionId: connection.id,
          accounts: refreshedAccounts
        });

        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ACTIVE",
            lastRefreshedAt: new Date(),
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...(metadata.stripe ?? {}),
                accountIds: refreshedAccounts.map(account => account.id),
                authorizationId:
                  refreshedAccounts.every(account => account.authorization && account.authorization === refreshedAccounts[0]?.authorization)
                    ? refreshedAccounts[0]?.authorization ?? metadata.stripe?.authorizationId ?? null
                    : metadata.stripe?.authorizationId ?? null
              },
              health: clearSyncHealth()
            } satisfies StripeConnectionMetadata)
          }
        });
      } catch (error) {
        const health = toSyncHealth(classifyStripeError(error));
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health
            } satisfies StripeConnectionMetadata)
          }
        });
        throw classifyStripeError(error);
      }
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      return syncStripeAccountLink({
        linkId,
        skipRefresh: false
      });
    }
  };
}

export const stripeService = createStripeService();
