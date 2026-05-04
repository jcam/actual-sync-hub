import { CountryCode, PlaidApi, PlaidEnvironments, Products, Configuration } from "plaid";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { buildPlaidCategoryNames } from "./category-matching.js";
type DatabaseClient = typeof prisma;

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: "sandbox" | "production";
  countryCodes: string[];
  products: string[];
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

function parseLinkConfig(configJson: string | null) {
  if (!configJson) {
    return {};
  }

  try {
    return JSON.parse(configJson) as { plaidCursor?: string };
  } catch {
    return {};
  }
}

export interface PlaidSyncTransaction {
  date: string;
  amount: number;
  payeeName: string;
  importedPayee?: string;
  notes?: string;
  importedId: string;
  cleared: boolean;
  categoryNames?: string[];
  searchText?: string[];
}

interface PlaidSyncResult {
  imported: number;
  transactions: PlaidSyncTransaction[];
  removedImportedIds: string[];
  nextCursor: string | null;
}

export interface PlaidService {
  createLinkToken(userId: string): Promise<string>;
  exchangePublicToken(publicToken: string, label?: string): Promise<string>;
  refreshConnection(connectionId: string): Promise<void>;
  syncAccountLink(linkId: string): Promise<PlaidSyncResult>;
  seedSandboxConnection(label?: string): Promise<string>;
  seedSandboxTransactions(connectionId: string, count?: number): Promise<{ added: number }>;
}

function assertSandboxToolsEnabled(config: PlaidConfig) {
  if (config.environment !== "sandbox" || !env.plaidSandboxToolsEnabled) {
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

export function createPlaidService({
  prisma: database = prisma,
  config = {
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    environment: env.PLAID_ENV,
    countryCodes: env.PLAID_COUNTRY_CODES.split(",").map(code => code.trim()).filter(Boolean),
    products: env.PLAID_PRODUCTS.split(",").map(product => product.trim()).filter(Boolean)
  } satisfies PlaidConfig
}: {
  prisma?: DatabaseClient;
  config?: PlaidConfig;
} = {}): PlaidService {
  return {
    async createLinkToken(userId: string) {
      const client = getPlaidClient(config);
      const response = await client.linkTokenCreate({
      client_name: "Actual Sync Hub",
      country_codes: config.countryCodes as CountryCode[],
      language: "en",
      products: config.products as Products[],
      user: {
        client_user_id: userId
      }
    });

      return response.data.link_token;
    },

    async exchangePublicToken(publicToken: string, label?: string) {
      const client = getPlaidClient(config);
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
          country_codes: config.countryCodes as CountryCode[]
        })).data.institution.name
        : null;

      const connection = await database.connection.upsert({
      where: {
        itemId
      },
      update: {
        label: label || institutionName || "Plaid connection",
        status: "ACTIVE",
        institutionId: item.data.item.institution_id || null,
        institutionName,
        accessTokenCiphertext: encryptString(accessToken),
        lastRefreshedAt: new Date(),
        metadataJson: JSON.stringify({
          item: item.data.item
        })
      },
      create: {
        provider: "PLAID",
        label: label || institutionName || "Plaid connection",
        status: "ACTIVE",
        institutionId: item.data.item.institution_id || null,
        institutionName,
        itemId,
        accessTokenCiphertext: encryptString(accessToken),
        lastRefreshedAt: new Date(),
        metadataJson: JSON.stringify({
          item: item.data.item
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

      return connection.id;
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      }
    });

      const client = getPlaidClient(config);
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

      await database.connection.update({
      where: {
        id: connection.id
      },
      data: {
        status: "ACTIVE",
        lastRefreshedAt: new Date()
      }
    });
    },

    async syncAccountLink(linkId: string): Promise<PlaidSyncResult> {
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
        nextCursor: null as string | null
      };
    }

      const client = getPlaidClient(config);
      const accessToken = decryptString(link.connection.accessTokenCiphertext);
      const existingConfig = parseLinkConfig(link.configJson);
      const startingCursor = existingConfig.plaidCursor;
      let cursor = startingCursor;
      let hasMore = true;
      const relevant: PlaidSyncTransaction[] = [];
      const removedImportedIds = new Set<string>();

      while (hasMore) {
        try {
          const response = await client.transactionsSync({
          access_token: accessToken,
          cursor
        });

          const page = response.data;
          const transactions = [...page.added, ...page.modified]
          .filter(transaction => transaction.account_id === link.connectionAccount?.externalAccountId)
          .map(transaction => ({
            date: transaction.authorized_date || transaction.date,
            amount: transaction.amount * -1,
            payeeName:
              transaction.merchant_name ||
              transaction.counterparties?.[0]?.name ||
              transaction.name,
            importedPayee: transaction.name,
            notes: undefined,
            importedId: transaction.pending_transaction_id || transaction.transaction_id,
            cleared: !transaction.pending,
            categoryNames: buildPlaidCategoryNames({
              detailed: transaction.personal_finance_category?.detailed,
              primary: transaction.personal_finance_category?.primary
            }),
            searchText: [
              transaction.name,
              transaction.merchant_name || undefined,
              ...((transaction.counterparties || []).map(counterparty => counterparty.name))
            ].filter((value): value is string => Boolean(value))
          }));

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

          throw error;
        }
      }

      return {
        imported: relevant.length,
        transactions: relevant,
        removedImportedIds: [...removedImportedIds],
        nextCursor: cursor ?? null
      };
    },

    async seedSandboxConnection(label?: string) {
      assertSandboxToolsEnabled(config);
      const client = getPlaidClient(config);
      const response = await client.sandboxPublicTokenCreate({
        institution_id: "ins_109508",
        initial_products: [Products.Transactions],
        options: {
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
      assertSandboxToolsEnabled(config);
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      await createSandboxTransactions({
        config,
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
