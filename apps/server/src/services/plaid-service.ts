import type { ConnectionReauthSessionDto, ProviderConnectResult } from "@actual-sync/shared";
import { getActivePlaidEnvironmentSettings } from "@actual-sync/shared";
import {
  Configuration,
  type CountryCode,
  type PersonalFinanceCategoryVersion,
  PlaidApi,
  PlaidEnvironments,
  Products
} from "plaid";
import { prisma } from "../db.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { buildPlaidCategoryNames } from "./category-matching.js";
import { parseLinkConfig } from "./link-config.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { buildImportedTransactionNotes } from "./provider-sync-helpers.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";
type DatabaseClient = typeof prisma;

export type PlaidConfig = {
  clientId: string;
  secret: string;
  environment: "sandbox" | "production";
  countryCodes: string[];
  products: string[];
  transactionsDaysRequested: number;
  personalFinanceCategoryVersion: "v1" | "v2";
}

function getPlaidClient(config: PlaidConfig) {
  if (!config.clientId || !config.secret) {
    throw new Error("Plaid is not configured");
  }

  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.environment],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": config.clientId,
          "PLAID-SECRET": config.secret
        }
      }
    })
  );
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

function getPlaidErrorCode(error: unknown) {
  return typeof error === "object" && error && "response" in error
    ? ((error as { response?: { data?: { error_code?: string } } }).response?.data?.error_code ?? undefined)
    : undefined;
}

function classifyPlaidError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Plaid error";
  const errorCode = getPlaidErrorCode(error);
  const status =
    typeof error === "object" && error && "response" in error
      ? ((error as { response?: { status?: number } }).response?.status ?? undefined)
      : undefined;

  if (errorCode === "RATE_LIMIT_EXCEEDED" || status === 429) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (errorCode === "ITEM_LOGIN_REQUIRED" || errorCode === "INVALID_ACCESS_TOKEN") {
    return new ProviderOperationError(message, {
      code: errorCode,
      healthState: "REAUTH_REQUIRED",
      healthScope: errorCode === "ITEM_LOGIN_REQUIRED" ? "BANK_AUTH" : "CONNECTION_AUTH",
      healthAction: errorCode === "ITEM_LOGIN_REQUIRED" ? "REAUTH_BANK" : "REAUTH_CONNECTION"
    });
  }

  return new ProviderOperationError(message, {
    code: errorCode,
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

export type PlaidSyncTransaction = {} & ProviderSyncTransaction

type PlaidSyncResult = {} & ProviderSyncResult

export type PlaidService = {
  createLinkToken(userId: string): Promise<string>;
  createUpdateLinkToken(connectionId: string, userId: string): Promise<string>;
  exchangePublicToken(publicToken: string, label?: string): Promise<ProviderConnectResult>;
  seedSandboxConnection(label?: string): Promise<ProviderConnectResult>;
  seedSandboxTransactions(connectionId: string, count?: number): Promise<{ added: number }>;
} & ProviderAdapter

function assertSandboxToolsEnabled(config: PlaidConfig) {
  if (config.environment !== "sandbox") {
    throw new Error("Plaid sandbox tools are not enabled");
  }
}

async function createSandboxTransactions({
  config,
  accessToken,
  count = 3
}: {
  config: PlaidConfig;
  accessToken: string;
  count?: number;
}) {
  const today = new Date();
  const transactionCount = Math.min(Math.max(count, 1), 10);
  const response = await fetch(`${PlaidEnvironments[config.environment]}/sandbox/transactions/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": config.clientId,
      "PLAID-SECRET": config.secret
    },
    body: JSON.stringify({
      access_token: accessToken,
      transactions: Array.from({ length: transactionCount }, (_value, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() - index);
        const isoDate = date.toISOString().slice(0, 10);

        return {
          amount: Number((12.5 + index * 7.25).toFixed(2)),
          date_posted: isoDate,
          date_transacted: isoDate,
          description: `Sandbox seeded transaction ${index + 1}`
        };
      })
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to seed sandbox transactions: ${response.status} ${await response.text()}`);
  }
}

function getPlaidTransactionsConfig(config: PlaidConfig) {
  return {
    days_requested: config.transactionsDaysRequested
  };
}

export function createPlaidService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
    clientId: "",
    secret: "",
    environment: "sandbox",
    countryCodes: ["US"],
    products: ["transactions"],
    transactionsDaysRequested: 365,
    personalFinanceCategoryVersion: "v2"
  } satisfies PlaidConfig
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: PlaidConfig;
} = {}): PlaidService {
  const getEffectiveConfig = async (): Promise<PlaidConfig> => {
    const settings = await providerSettings.get("PLAID");
    const activeSettings = getActivePlaidEnvironmentSettings(settings);
    return {
      ...config,
      clientId: activeSettings.clientId,
      secret: activeSettings.secret,
      environment: settings.environment,
      countryCodes: settings.countryCodes,
      products: settings.products,
      transactionsDaysRequested: settings.transactionsDaysRequested,
      personalFinanceCategoryVersion: settings.personalFinanceCategoryVersion
    };
  };

  const createLinkTokenPayload = ({
    userId,
    accessToken,
    effectiveConfig
  }: {
    userId: string;
    accessToken?: string;
    effectiveConfig: PlaidConfig;
  }) => ({
    client_name: "Actual Sync Hub",
    country_codes: effectiveConfig.countryCodes as CountryCode[],
    language: "en",
    ...(accessToken
      ? {
          access_token: accessToken
        }
      : {
          products: effectiveConfig.products as Products[],
          transactions: getPlaidTransactionsConfig(effectiveConfig)
        }),
    user: {
      client_user_id: userId
    }
  });

  return {
    provider: "PLAID",
    isConfigured() {
      return false;
    },

    async createLinkToken(userId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const client = getPlaidClient(effectiveConfig);
      const response = await client.linkTokenCreate({
        ...createLinkTokenPayload({
          userId,
          effectiveConfig
        })
      });

      return response.data.link_token;
    },

    async createUpdateLinkToken(connectionId: string, userId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "PLAID") {
        throw new Error("Connection is not a Plaid item");
      }

      const effectiveConfig = await getEffectiveConfig();
      const client = getPlaidClient(effectiveConfig);
      const accessToken = decryptString(connection.accessTokenCiphertext);
      const response = await client.linkTokenCreate({
        ...createLinkTokenPayload({
          userId,
          accessToken,
          effectiveConfig
        })
      });

      return response.data.link_token;
    },

    async createReauthSession({
      connectionId,
      userId
    }: {
      connectionId: string;
      userId: string;
    }): Promise<ConnectionReauthSessionDto> {
      return {
        provider: "PLAID",
        connectionId,
        mode: "plaid_update",
        linkToken: await this.createUpdateLinkToken(connectionId, userId)
      };
    },

    async disconnectConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "PLAID") {
        throw new Error("Connection is not a Plaid item");
      }

      try {
        const client = getPlaidClient(await getEffectiveConfig());
        await client.itemRemove({
          access_token: decryptString(connection.accessTokenCiphertext)
        });
      } catch (error) {
        const errorCode = getPlaidErrorCode(error);
        if (errorCode === "ITEM_NOT_FOUND" || errorCode === "INVALID_ACCESS_TOKEN") {
          return;
        }

        throw classifyPlaidError(error);
      }
    },

    async exchangePublicToken(publicToken: string, label?: string) {
      const effectiveConfig = await getEffectiveConfig();
      const client = getPlaidClient(effectiveConfig);
      const exchange = await client.itemPublicTokenExchange({
      public_token: publicToken
    });

    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;
    const item = await client.itemGet({
      access_token: accessToken
    });
    const accounts = await client.accountsGet({
      access_token: accessToken
    });

      const institutionName = item.data.item.institution_id
        ? (await client.institutionsGetById({
          institution_id: item.data.item.institution_id,
          country_codes: effectiveConfig.countryCodes as CountryCode[]
        })).data.institution.name
        : null;

      const connection = await database.connection.upsert({
      where: {
        provider_providerItemId: {
          provider: "PLAID",
          providerItemId: itemId
        }
      },
      update: {
        label: label || institutionName || "Plaid connection",
        status: "ACTIVE",
        institutionId: item.data.item.institution_id || null,
        institutionName,
        accessTokenCiphertext: encryptString(accessToken),
        lastRefreshedAt: new Date(),
        metadataJson: JSON.stringify({
          item: item.data.item,
          health: clearSyncHealth()
        })
      },
      create: {
        provider: "PLAID",
        label: label || institutionName || "Plaid connection",
        status: "ACTIVE",
        institutionId: item.data.item.institution_id || null,
        institutionName,
        providerItemId: itemId,
        accessTokenCiphertext: encryptString(accessToken),
        lastRefreshedAt: new Date(),
        metadataJson: JSON.stringify({
          item: item.data.item,
          health: clearSyncHealth()
        })
      }
    });

      await database.connectionAccount.deleteMany({
      where: {
        connectionId: connection.id
      }
    });

      await database.connectionAccount.createMany({
      data: accounts.data.accounts.map(account => ({
        connectionId: connection.id,
        externalAccountId: account.account_id,
        name: account.name,
        officialName: account.official_name,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype || null,
        currentBalance: account.balances.current ?? null,
        availableBalance: account.balances.available ?? null,
        rawJson: JSON.stringify(account)
      }))
    });

      return {
        connectionId: connection.id
      };
    },

    async refreshConnection(connectionId: string) {
      const effectiveConfig = await getEffectiveConfig();
      const connection = await database.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      }
    });

      try {
        const client = getPlaidClient(effectiveConfig);
        const accessToken = decryptString(connection.accessTokenCiphertext);
        const accounts = await client.accountsGet({
          access_token: accessToken
        });

        await database.connectionAccount.deleteMany({
          where: {
            connectionId: connection.id
          }
        });

        await database.connectionAccount.createMany({
          data: accounts.data.accounts.map(account => ({
            connectionId: connection.id,
            externalAccountId: account.account_id,
            name: account.name,
            officialName: account.official_name,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype || null,
            currentBalance: account.balances.current ?? null,
            availableBalance: account.balances.available ?? null,
            rawJson: JSON.stringify(account)
          }))
        });

        const metadata = parseConnectionMetadata(connection.metadataJson);
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ACTIVE",
            lastRefreshedAt: new Date(),
            metadataJson: JSON.stringify({
              ...metadata,
              health: clearSyncHealth()
            })
          }
        });
      } catch (error) {
        const metadata = parseConnectionMetadata(connection.metadataJson);
        const health = toSyncHealth(classifyPlaidError(error));
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health
            })
          }
        });
        throw classifyPlaidError(error);
      }
    },

    async syncAccountLink(linkId: string): Promise<PlaidSyncResult> {
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

    if (!link.connection || !link.connectionAccount) {
      return {
        imported: 0,
        transactions: [],
        removedImportedIds: [],
        configPatch: {}
      };
    }

      const client = getPlaidClient(effectiveConfig);
      const accessToken = decryptString(link.connection.accessTokenCiphertext);
      const existingConfig = parseLinkConfig(link.configJson);
      const startingCursor = existingConfig.providerSyncState?.cursor ?? undefined;
      let cursor = startingCursor;
      let hasMore = true;
      const relevant: PlaidSyncTransaction[] = [];
      const removedImportedIds = new Set<string>();

      while (hasMore) {
        try {
          const response = await client.transactionsSync({
          access_token: accessToken,
          cursor,
          options: {
            days_requested: config.transactionsDaysRequested,
            include_original_description: true,
            personal_finance_category_version:
              effectiveConfig.personalFinanceCategoryVersion as PersonalFinanceCategoryVersion
          }
        });

          const page = response.data;
          const transactions = [...page.added, ...page.modified]
            .filter(transaction => transaction.account_id === link.connectionAccount?.externalAccountId)
            .map(transaction => {
              const payeeName =
                transaction.merchant_name ||
                transaction.counterparties?.[0]?.name ||
                transaction.name;

              return {
                date: transaction.authorized_date || transaction.date,
                amount: transaction.amount * -1,
                payeeName,
                importedPayee: transaction.name,
                notes: buildImportedTransactionNotes({
                  payeeName,
                  description: transaction.original_description || transaction.name
                }),
                importedId: transaction.pending_transaction_id || transaction.transaction_id,
                cleared: !transaction.pending,
                categoryNames: buildPlaidCategoryNames({
                  detailed: transaction.personal_finance_category?.detailed,
                  primary: transaction.personal_finance_category?.primary
                }),
                searchText: [...new Set(
                  [
                    transaction.name,
                    transaction.original_description || undefined,
                    transaction.merchant_name || undefined,
                    ...((transaction.counterparties || []).map(counterparty => counterparty.name))
                  ].filter((value): value is string => Boolean(value))
                )]
              };
            });

          for (const transaction of page.removed.filter(
            transaction => transaction.account_id === link.connectionAccount?.externalAccountId
          )) {
            const importedId =
              ("pending_transaction_id" in transaction ? transaction.pending_transaction_id : undefined) ||
              transaction.transaction_id;
            if (typeof importedId === "string" && importedId.length > 0) {
              removedImportedIds.add(importedId);
            }
          }

          relevant.push(...transactions);
          cursor = page.next_cursor;
          hasMore = page.has_more;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown Plaid error";
          if (message.includes("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) {
            cursor = startingCursor;
            hasMore = true;
            relevant.length = 0;
            continue;
          }

          throw classifyPlaidError(error);
        }
      }

      const metadata = parseConnectionMetadata(link.connection.metadataJson);
      await database.connection.update({
        where: {
          id: link.connection.id
        },
        data: {
          status: "ACTIVE",
          lastRefreshedAt: new Date(),
          metadataJson: JSON.stringify({
            ...metadata,
            health: clearSyncHealth()
          })
        }
      });

      return {
        imported: relevant.length,
        transactions: relevant,
        removedImportedIds: [...removedImportedIds],
        configPatch: {
          providerSyncState: {
            cursor: cursor ?? null,
            windowStartDate: null,
            windowEndDate: null
          }
        }
      };
    },

    async seedSandboxConnection(label?: string) {
      const effectiveConfig = await getEffectiveConfig();
      assertSandboxToolsEnabled(effectiveConfig);
      const client = getPlaidClient(effectiveConfig);
      const response = await client.sandboxPublicTokenCreate({
        institution_id: "ins_109508",
        initial_products: [Products.Transactions],
        options: {
          transactions: getPlaidTransactionsConfig(effectiveConfig),
          webhook: "https://example.com/webhooks/plaid",
          override_username: "user_transactions_dynamic",
          override_password: "test-password"
        }
      });

      return this.exchangePublicToken(
        response.data.public_token,
        label || `Sandbox Bank ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      );
    },

    async seedSandboxTransactions(connectionId: string, count = 3) {
      const effectiveConfig = await getEffectiveConfig();
      assertSandboxToolsEnabled(effectiveConfig);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      await createSandboxTransactions({
        config: effectiveConfig,
        accessToken: decryptString(connection.accessTokenCiphertext),
        count
      });

      return {
        added: Math.min(Math.max(count, 1), 10)
      };
    }
  };
}

export const plaidService = createPlaidService();
