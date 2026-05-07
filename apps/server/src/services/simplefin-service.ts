import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ProviderConnectResult } from "@actual-sync/shared";
import { decryptString, encryptString } from "../lib/crypto.js";
import { buildProviderCategoryNames } from "./category-matching.js";
import { parseLinkConfig } from "./link-config.js";
import { providerFixtureCache } from './provider-fixture-cache.js';
import type { ProviderFixtureCache } from './provider-fixture-cache.js';
import type { ProviderAdapter, ProviderSyncOutcome, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { buildImportedTransactionNotes, sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { createProviderSettingsService } from './provider-settings-service.js';
import type { ProviderSettingsService } from './provider-settings-service.js';
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

const SIMPLEFIN_DEFAULT_LOOKBACK_DAYS = 45;

export type SimpleFinConfig = {
  defaultLookbackDays: number;
  overlapDays: number;
}

export type SimpleFinConnectPayload = {
  setupToken: string;
  label?: string | null;
}

type SimpleFinOrganization = {
  id?: string | null;
  name?: string | null;
  domain?: string | null;
  url?: string | null;
}

type SimpleFinTransaction = {
  id: string;
  amount: string | number;
  payee?: string | null;
  description?: string | null;
  memo?: string | null;
  pending?: number | null;
  posted?: number | null;
  transacted_at?: number | null;
  extra?: {
    category?: string | null;
  } | null;
}

type SimpleFinAccount = {
  id: string;
  name: string;
  balance?: string | number | null;
  "available-balance"?: string | number | null;
  org?: SimpleFinOrganization | null;
  conn_id?: string | null;
  conn_name?: string | null;
  transactions?: SimpleFinTransaction[];
}

type SimpleFinConnectionRecord = {
  conn_id: string;
  name?: string | null;
  org_id?: string | null;
  org_name?: string | null;
  org_url?: string | null;
  sfin_url?: string | null;
}

type SimpleFinAccountsResponse = {
  accounts?: SimpleFinAccount[];
  connections?: SimpleFinConnectionRecord[];
  errors?: string[];
  errlist?: Array<{
    msg?: string;
    message?: string;
    code?: string;
  }>;
}

type FetchLike = typeof fetch;
type SimpleFinLink = Prisma.AccountLinkGetPayload<{
  include: {
    connection: true;
    connectionAccount: true;
  };
}>;

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number) {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return toIsoDate(base);
}

function parseCurrency(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseAccessKey(accessKey: string) {
  const match = accessKey.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (!match) {
    throw new Error("Invalid SimpleFIN access key");
  }

  const [, scheme, username, password, remainder] = match;
  return {
    baseUrl: `${scheme}${remainder}`,
    username,
    password
  };
}

async function exchangeSetupToken(setupToken: string, fetchImpl: FetchLike) {
  const tokenUrl = Buffer.from(setupToken, "base64").toString("utf8");
  if (!/^https?:\/\//.test(tokenUrl)) {
    throw new Error("Invalid SimpleFIN setup token");
  }

  const response = await fetchImpl(tokenUrl, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Failed to exchange SimpleFIN setup token (${response.status})`);
  }

  const accessKey = (await response.text()).trim();
  if (!accessKey) {
    throw new Error("SimpleFIN did not return an access key");
  }

  parseAccessKey(accessKey);
  return accessKey;
}

async function fetchSimpleFinAccounts({
  accessKey,
  fetchImpl,
  accountIds,
  startDate,
  endDate,
  balancesOnly
}: {
  accessKey: string;
  fetchImpl: FetchLike;
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  balancesOnly?: boolean;
}) {
  const { baseUrl, username, password } = parseAccessKey(accessKey);
  const params = new URLSearchParams();

  if (balancesOnly) {
    params.set("balances-only", "1");
  } else {
    if (startDate) {
      params.set("start-date", String(Date.parse(`${startDate}T00:00:00.000Z`) / 1000));
    }
    if (endDate) {
      params.set("end-date", String(Date.parse(`${endDate}T00:00:00.000Z`) / 1000));
    }
    params.set("pending", "1");
  }

  for (const accountId of accountIds || []) {
    params.append("account", accountId);
  }

  const response = await fetchImpl(`${baseUrl}/accounts?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    },
    redirect: "follow"
  });

  if (response.status === 403) {
    throw new Error("Invalid SimpleFIN access token");
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch SimpleFIN accounts (${response.status})`);
  }

  return (await response.json()) as SimpleFinAccountsResponse;
}

function buildSimpleFinConnectionMap(response: SimpleFinAccountsResponse) {
  return new Map((response.connections || []).map(connection => [connection.conn_id, connection]));
}

function buildConnectionMetadata(account: SimpleFinAccount, connection?: SimpleFinConnectionRecord | null) {
  return JSON.stringify({
    accountId: account.id,
    institution: account.org?.name ?? null,
    orgDomain: account.org?.domain ?? null,
    orgId: account.org?.id ?? null,
    connId: account.conn_id ?? connection?.conn_id ?? null,
    connName: account.conn_name ?? connection?.name ?? null,
    connOrgId: connection?.org_id ?? null,
    connOrgName: connection?.org_name ?? null,
    connOrgUrl: connection?.org_url ?? null,
    sfinUrl: connection?.sfin_url ?? null
  });
}

function parseConnectionMetadata(json: string | null | undefined) {
  if (!json) {
    return {};
  }

  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatSimpleFinErrors(payload: SimpleFinAccountsResponse) {
  const legacyErrors = Array.isArray(payload.errors) ? payload.errors.filter(Boolean) : [];
  const structuredErrors = Array.isArray(payload.errlist)
    ? payload.errlist
        .map(error => error.msg || error.message || error.code)
        .filter((value): value is string => Boolean(value))
    : [];

  return [...new Set([...legacyErrors, ...structuredErrors])];
}

function buildConnectionAccountRows(connectionId: string, response: SimpleFinAccountsResponse) {
  const connectionMap = buildSimpleFinConnectionMap(response);
  const accounts = response.accounts || [];
  return accounts.map(account => {
    const connectionRecord = account.conn_id ? connectionMap.get(account.conn_id) : null;
    return {
      connectionId,
      externalAccountId: account.id,
      name: account.name,
      officialName: account.name,
      mask: null,
      type: "bank",
      subtype: null,
      currentBalance: parseCurrency(account.balance),
      availableBalance: parseCurrency(account["available-balance"]),
      providerConnectionId: account.conn_id ?? null,
      providerConnectionName: account.conn_name ?? connectionRecord?.name ?? null,
      providerInstitutionId: account.org?.id ?? connectionRecord?.org_id ?? null,
      providerInstitutionDomain: account.org?.domain ?? null,
      rawJson: buildConnectionMetadata(account, connectionRecord)
    };
  });
}

function classifySimpleFinError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown SimpleFIN error";
  const normalized = message.toLowerCase();

  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (normalized.includes("invalid simplefin access token") || normalized.includes("forbidden")) {
    return new ProviderOperationError(message, {
      code: "INVALID_ACCESS_TOKEN",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "MANUAL_RECONNECT"
    });
  }

  if (normalized.includes("attention")) {
    return new ProviderOperationError(message, {
      code: "ACCOUNT_NEEDS_ATTENTION",
      healthState: "ATTENTION_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "CHECK_PROVIDER"
    });
  }

  return new ProviderOperationError(message, {
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

function normalizeSimpleFinTransactions({
  account,
  startDate
}: {
  account: SimpleFinAccount;
  startDate: string;
}): ProviderSyncTransaction[] {
  return (account.transactions || [])
    .flatMap(transaction => {
      const booked = Boolean(transaction.posted && transaction.posted !== 0);
      const timestamp = booked ? transaction.posted : transaction.transacted_at;
      if (!timestamp) {
        return [];
      }

      const date = toIsoDate(new Date(timestamp * 1000));
      if (date < startDate) {
        return [];
      }

      const payeeName = transaction.payee?.trim() || transaction.description?.trim() || account.name;
      const importedPayee = transaction.payee?.trim() || transaction.description?.trim() || payeeName;
      const notes = buildImportedTransactionNotes({
        payeeName,
        description: transaction.description,
        memo: transaction.memo
      });
      const amount = parseCurrency(transaction.amount);
      if (amount == null) {
        return [];
      }

      return [
        {
          date,
          amount,
          payeeName,
          importedPayee,
          notes,
          importedId: transaction.id,
          cleared: booked,
          categoryNames: buildProviderCategoryNames(transaction.extra?.category),
          searchText: [transaction.payee?.trim(), transaction.description?.trim(), transaction.memo?.trim()].filter(
            (value): value is string => Boolean(value)
          )
        }
      ];
    })
    .sort((left, right) => right.date.localeCompare(left.date));
}

export type SimpleFinService = {
  connectSetupToken(payload: SimpleFinConnectPayload): Promise<ProviderConnectResult>;
  reuseCachedConnection(label?: string | null): Promise<ProviderConnectResult>;
} & ProviderAdapter

export function createSimpleFinService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
    defaultLookbackDays: SIMPLEFIN_DEFAULT_LOOKBACK_DAYS,
    overlapDays: 10
  } satisfies SimpleFinConfig,
  fetchImpl = fetch,
  now = () => new Date(),
  fixtureCache = providerFixtureCache
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: SimpleFinConfig;
  fetchImpl?: FetchLike;
  now?: () => Date;
  fixtureCache?: ProviderFixtureCache;
} = {}): SimpleFinService {
  const getEffectiveConfig = async (): Promise<SimpleFinConfig> => {
    const settings = await providerSettings.get("SIMPLEFIN");
    return {
      defaultLookbackDays: settings.transactionsInitialDays,
      overlapDays: config.overlapDays
    };
  };

  const replaceConnectionAccounts = async (connectionId: string, response: SimpleFinAccountsResponse) => {
    const accounts = response.accounts || [];
    await database.connectionAccount.deleteMany({
      where: {
        connectionId
      }
    });

    if (accounts.length > 0) {
      await database.connectionAccount.createMany({
        data: buildConnectionAccountRows(connectionId, response)
      });
    }
  };

  const markConnectionHealthy = async (connection: { id: string; metadataJson: string | null }) => {
    const metadata = parseConnectionMetadata(connection.metadataJson);
    await database.connection.update({
      where: {
        id: connection.id
      },
      data: {
        status: "ACTIVE",
        lastRefreshedAt: now(),
        metadataJson: JSON.stringify({
          ...metadata,
          health: clearSyncHealth()
        })
      }
    });
  };

  const markConnectionError = async (connection: { id: string; metadataJson: string | null }, error: unknown) => {
    const metadata = parseConnectionMetadata(connection.metadataJson);
    const providerError = classifySimpleFinError(error);
    await database.connection.update({
      where: {
        id: connection.id
      },
      data: {
        status: "ERROR",
        metadataJson: JSON.stringify({
          ...metadata,
          health: toSyncHealth(providerError)
        })
      }
    });
    return providerError;
  };

  const connectAccessKey = async ({
    accessKey,
    label
  }: {
    accessKey: string;
    label?: string | null;
  }): Promise<ProviderConnectResult> => {
    const accountsResponse = await fetchSimpleFinAccounts({
      accessKey,
      fetchImpl,
      balancesOnly: true
    });
    const accounts = accountsResponse.accounts || [];
    const responseConnections = accountsResponse.connections || [];
    const identity = parseAccessKey(accessKey);
    const providerItemId = `${identity.baseUrl}|${identity.username}`;
    const uniqueInstitutions = [
      ...new Set(
        [
          ...responseConnections.map(connection => connection.org_name || connection.name).filter(Boolean),
          ...accounts.map(account => account.org?.name || account.conn_name).filter(Boolean)
        ]
      )
    ];
    const uniqueInstitutionIds = [
      ...new Set(
        [
          ...responseConnections.map(connection => connection.org_id || connection.conn_id).filter(Boolean),
          ...accounts.map(account => account.org?.domain || account.org?.id || account.conn_id).filter(Boolean)
        ]
      )
    ] as string[];
    const nextLabel =
      label?.trim() ||
      (uniqueInstitutions.length === 1 ? uniqueInstitutions[0]! : `SimpleFIN ${now().toLocaleTimeString()}`);

    const connection = await database.connection.upsert({
      where: {
        provider_providerItemId: {
          provider: "SIMPLEFIN",
          providerItemId
        }
      },
      update: {
        label: nextLabel,
        status: "ACTIVE",
        institutionName: uniqueInstitutions.length === 1 ? uniqueInstitutions[0]! : "SimpleFIN",
        institutionId: uniqueInstitutionIds.length === 1 ? uniqueInstitutionIds[0]! : null,
        accessTokenCiphertext: encryptString(accessKey),
        metadataJson: JSON.stringify({
          simplefin: {
            baseUrl: identity.baseUrl,
            username: identity.username,
            connectedAt: now().toISOString()
          },
          health: clearSyncHealth()
        }),
        lastRefreshedAt: now()
      },
      create: {
        provider: "SIMPLEFIN",
        label: nextLabel,
        status: "ACTIVE",
        institutionName: uniqueInstitutions.length === 1 ? uniqueInstitutions[0]! : "SimpleFIN",
        institutionId: uniqueInstitutionIds.length === 1 ? uniqueInstitutionIds[0]! : null,
        providerItemId,
        accessTokenCiphertext: encryptString(accessKey),
        metadataJson: JSON.stringify({
          simplefin: {
            baseUrl: identity.baseUrl,
            username: identity.username,
            connectedAt: now().toISOString()
          },
          health: clearSyncHealth()
        }),
        lastRefreshedAt: now()
      }
    });

    await replaceConnectionAccounts(connection.id, accountsResponse);

    await fixtureCache.setSimpleFin({
      accessKey,
      updatedAt: now().toISOString()
    });

    const errorMessages = formatSimpleFinErrors(accountsResponse);
    if (errorMessages.length > 0) {
      const providerError = classifySimpleFinError(new Error(errorMessages.join(" ")));
      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          status: "ERROR",
          metadataJson: JSON.stringify({
            ...parseConnectionMetadata(connection.metadataJson),
            health: toSyncHealth(providerError)
          })
        }
      });

      return {
        connectionId: connection.id,
        warning: providerError.message
      };
    }

    return {
      connectionId: connection.id
    };
  };

  return {
    provider: "SIMPLEFIN",

    isConfigured() {
      return true;
    },

    async connectSetupToken(payload: SimpleFinConnectPayload) {
      const accessKey = await exchangeSetupToken(payload.setupToken, fetchImpl);
      return connectAccessKey({
        accessKey,
        label: payload.label
      });
    },

    async reuseCachedConnection(label) {
      if (!fixtureCache.isEnabled()) {
        throw new Error("Provider fixture cache is not enabled.");
      }

      const cached = await fixtureCache.getSimpleFin();
      if (!cached?.accessKey) {
        throw new Error("No cached SimpleFIN fixture is available yet.");
      }

      try {
        return await connectAccessKey({
          accessKey: cached.accessKey,
          label
        });
      } catch (error) {
        const providerError = classifySimpleFinError(error);
        if (providerError.code === "INVALID_ACCESS_TOKEN") {
          await fixtureCache.clearSimpleFin();
        }
        throw providerError;
      }
    },

    async disconnectConnection(_connectionId: string) {
      void _connectionId;
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "SIMPLEFIN") {
        throw new Error("Connection is not a SimpleFIN connection");
      }

      try {
        const accessKey = decryptString(connection.accessTokenCiphertext);
        const accountsResponse = await fetchSimpleFinAccounts({
          accessKey,
          fetchImpl,
          balancesOnly: true
        });
        const errorMessages = formatSimpleFinErrors(accountsResponse);
        if (errorMessages.length > 0) {
          throw classifySimpleFinError(new Error(errorMessages.join(" ")));
        }
        await replaceConnectionAccounts(connection.id, accountsResponse);
        await markConnectionHealthy(connection);
      } catch (error) {
        throw await markConnectionError(connection, error);
      }
    },

    async syncAccountLinks(linkIds: string[]) {
      const effectiveConfig = await getEffectiveConfig();
      const links = await database.accountLink.findMany({
        where: {
          id: {
            in: linkIds
          }
        },
        include: {
          connection: true,
          connectionAccount: true
        }
      });
      const outcomes = new Map<string, ProviderSyncOutcome>();
      const today = toIsoDate(now());
      const linksByConnection = new Map<string, SimpleFinLink[]>();

      for (const linkId of linkIds) {
        const link = links.find(candidate => candidate.id === linkId);
        if (!link) {
          outcomes.set(linkId, {
            error: new Error(`SimpleFIN link ${linkId} was not found`)
          });
          continue;
        }

        if (!link.connection || !link.connectionAccount) {
          outcomes.set(linkId, {
            result: {
              imported: 0,
              transactions: [],
              removedImportedIds: []
            }
          });
          continue;
        }

        const group = linksByConnection.get(link.connection.id) || [];
        group.push(link);
        linksByConnection.set(link.connection.id, group);
      }

      for (const connectionLinks of linksByConnection.values()) {
        const connection = connectionLinks[0]?.connection;
        if (!connection) {
          continue;
        }

        const syncPlans = connectionLinks.map(link => {
          const configState = parseLinkConfig(link.configJson);
          const endDate = today;
          const startDate = configState.providerSyncState?.windowEndDate
            ? shiftIsoDate(configState.providerSyncState.windowEndDate, -effectiveConfig.overlapDays)
            : shiftIsoDate(today, -(effectiveConfig.defaultLookbackDays - 1));
          return {
            link,
            startDate,
            endDate
          };
        });
        const requestStartDate = syncPlans
          .map(plan => plan.startDate)
          .sort((left, right) => left.localeCompare(right))[0];

        try {
          const accessKey = decryptString(connection.accessTokenCiphertext);
          const response = await fetchSimpleFinAccounts({
            accessKey,
            fetchImpl,
            accountIds: [...new Set(syncPlans.map(plan => plan.link.connectionAccount!.externalAccountId))],
            startDate: requestStartDate,
            endDate: today,
            balancesOnly: false
          });
          const errorMessages = formatSimpleFinErrors(response);
          if (errorMessages.length > 0) {
            throw classifySimpleFinError(new Error(errorMessages.join(" ")));
          }

          const accountByExternalId = new Map((response.accounts || []).map(account => [account.id, account]));
          await markConnectionHealthy(connection);

          for (const plan of syncPlans) {
            const account = accountByExternalId.get(plan.link.connectionAccount!.externalAccountId);
            if (!account) {
              outcomes.set(plan.link.id, {
                error: new Error(
                  `SimpleFIN account ${plan.link.connectionAccount!.externalAccountId} was not returned by the provider`
                )
              });
              continue;
            }

            const transactions = normalizeSimpleFinTransactions({
              account,
              startDate: plan.startDate
            });
            outcomes.set(plan.link.id, {
              result: sanitizeProviderSyncResult({
                imported: transactions.length,
                transactions,
                removedImportedIds: [],
                configPatch: {
                  providerSyncState: {
                    cursor: null,
                    windowStartDate: plan.startDate,
                    windowEndDate: plan.endDate
                  }
                }
              })
            });
          }
        } catch (error) {
          const providerError = await markConnectionError(connection, error);
          for (const plan of syncPlans) {
            outcomes.set(plan.link.id, {
              error: providerError
            });
          }
        }
      }

      return outcomes;
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const outcomes = await this.syncAccountLinks?.([linkId]);
      const outcome = outcomes?.get(linkId);

      if (!outcome?.result && !outcome?.error) {
        throw new Error(`SimpleFIN sync produced no result for link ${linkId}`);
      }

      if (outcome.error) {
        throw outcome.error;
      }

      return outcome.result!;
    }
  };
}

export const simplefinService = createSimpleFinService();
