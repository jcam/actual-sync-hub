import type {
  ActualAccountDto,
  ActualBankSyncLinkDto,
  ActualCategoryDto,
  CommitMigrationPayload,
  ConnectionReauthSessionDto,
  ConnectionAccountOptionDto,
  ConnectionDto,
  MigrationPreviewDto,
  Provider,
  RuntimeInfoDto,
  SyncRunDto,
  UpdateAccountLinkPayload
} from "@actual-sync/shared";
import type { Prisma, Provider as PrismaProvider } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { actualService, type ReconcileTransactionInput } from "./actual-service.js";
import { getTellerMetadata, parseConnectionMetadata } from "./connection-metadata.js";
import { learnCategoryMappingsFromHistory, pruneImportedTransactionLedger } from "./imported-transaction-ledger.js";
import {
  CURRENT_LINK_STATUSES,
  type LinkConfigData,
  linkIdentityChanged,
  parseLinkConfig,
  selectCurrentLink,
  serializeLinkConfig,
  toLinkDto
} from "./link-config.js";
import { plaidService, type PlaidService } from "./plaid-service.js";
import {
  getPrimarySourceCategory,
  resolveTransactionCategoryId,
  resolveTransferActualAccountId,
} from "./provider-sync-helpers.js";
import { simplefinService, type SimpleFinService } from "./simplefin-service.js";
import { createSyncReviewService } from "./sync-review-service.js";
import { tellerService, type TellerService } from "./teller-service.js";
import type { TellerWebhookEvent } from "./teller-service.js";
import type { ProviderAdapter, ProviderSyncOutcome, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { clearSyncHealth, isBlockingSyncHealth, isRateLimitedSyncError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;
type ActualService = typeof actualService;
type AutomaticSyncConcurrencyConfig = Record<Provider, number>;
type SiblingLink = Prisma.AccountLinkGetPayload<{
  include: {
    connectionAccount: true;
  };
}>;
type SyncableLink = Prisma.AccountLinkGetPayload<{
  include: {
    connection: true;
    connectionAccount: true;
  };
}>;

function createConcurrencyGate(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function runWithGate<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>(resolve => {
        queue.push(resolve);
      });
    }

    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function toPrismaProvider(provider: Provider | null | undefined): PrismaProvider | null | undefined {
  return provider as PrismaProvider | null | undefined;
}

export interface AppService {
  getRuntimeInfo(): Promise<RuntimeInfoDto>;
  listConnections(): Promise<ConnectionDto[]>;
  listActualAccounts(): Promise<ActualAccountDto[]>;
  listActualBankSyncLinks(): Promise<ActualBankSyncLinkDto[]>;
  importExistingSimpleFinLinks(connectionId: string): Promise<{
    imported: number;
    updated: number;
    skipped: number;
    unmatched: number;
  }>;
  createConnectionReauthSession(connectionId: string, userId: string): Promise<ConnectionReauthSessionDto>;
  disconnectConnection(connectionId: string): Promise<void>;
  refreshConnection(connectionId: string): Promise<void>;
  refreshAllConnections(): Promise<void>;
  upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload): Promise<unknown>;
  runAccountSync(actualAccountId: string): Promise<void>;
  runScheduledLinkSyncs(linkIds: string[]): Promise<void>;
  handleTellerWebhook(event: TellerWebhookEvent): Promise<void>;
  previewAccountSyncReview(actualAccountId: string): Promise<MigrationPreviewDto>;
  commitAccountSyncReview(actualAccountId: string, payload: CommitMigrationPayload): Promise<void>;
  listSyncRuns(limit?: number): Promise<SyncRunDto[]>;
}

export function createAppService({
  prisma: database = prisma,
  actualService: actual = actualService,
  plaidService: plaid = plaidService,
  simplefinService: simplefin = simplefinService,
  tellerService: teller = tellerService,
  runtime = {
    instanceLabel: env.APP_INSTANCE_LABEL,
    liveSandboxMode: env.liveSandboxMode,
    actualServerUrl: env.ACTUAL_SERVER_URL,
    actualBudgetSyncIdConfigured: Boolean(env.ACTUAL_BUDGET_SYNC_ID),
    plaidEnabled: env.plaidEnabled,
    plaidEnvironment: env.PLAID_ENV,
    plaidSandboxToolsEnabled: env.plaidSandboxToolsEnabled,
    plaidAutomaticSyncConcurrency: env.PLAID_AUTOMATIC_SYNC_CONCURRENCY,
    tellerEnabled: env.tellerEnabled,
    tellerEnvironment: env.TELLER_ENV,
    tellerMtlsConfigured: env.tellerMtlsConfigured,
    tellerWebhookSyncDebounceSeconds: env.TELLER_WEBHOOK_SYNC_DEBOUNCE_SECONDS,
    tellerAutomaticSyncConcurrency: env.TELLER_AUTOMATIC_SYNC_CONCURRENCY,
    simplefinAutomaticSyncConcurrency: env.SIMPLEFIN_AUTOMATIC_SYNC_CONCURRENCY,
    automaticSyncBackoffBaseMinutes: env.AUTOMATIC_SYNC_BACKOFF_BASE_MINUTES,
    automaticSyncBackoffMaxMinutes: env.AUTOMATIC_SYNC_BACKOFF_MAX_MINUTES
  },
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  actualService?: ActualService;
  plaidService?: PlaidService;
  simplefinService?: SimpleFinService;
  tellerService?: TellerService;
  runtime?: {
    instanceLabel: string;
    liveSandboxMode: boolean;
    actualServerUrl: string;
    actualBudgetSyncIdConfigured: boolean;
    plaidEnabled: boolean;
    plaidEnvironment: "sandbox" | "production";
    plaidSandboxToolsEnabled: boolean;
    plaidAutomaticSyncConcurrency: number;
    tellerEnabled: boolean;
    tellerEnvironment: "sandbox" | "development" | "production";
    tellerMtlsConfigured: boolean;
    tellerWebhookSyncDebounceSeconds: number;
    tellerAutomaticSyncConcurrency: number;
    simplefinAutomaticSyncConcurrency: number;
    automaticSyncBackoffBaseMinutes: number;
    automaticSyncBackoffMaxMinutes: number;
  };
  now?: () => Date;
} = {}): AppService {
  const providerAdapters = {
    PLAID: plaid,
    SIMPLEFIN: simplefin,
    TELLER: teller
  } satisfies Record<Provider, ProviderAdapter>;
  const automaticSyncConcurrency: AutomaticSyncConcurrencyConfig = {
    PLAID: runtime.plaidAutomaticSyncConcurrency,
    TELLER: runtime.tellerAutomaticSyncConcurrency,
    SIMPLEFIN: runtime.simplefinAutomaticSyncConcurrency
  };
  const providerBackgroundSyncGates = new Map<Provider, ReturnType<typeof createConcurrencyGate>>();

  const getProviderAdapter = (provider: Provider | null | undefined) => {
    if (!provider) {
      return null;
    }

    return providerAdapters[provider];
  };

  const runWithProviderBackgroundGate = async <T>(provider: Provider, task: () => Promise<T>) => {
    const existingGate = providerBackgroundSyncGates.get(provider);
    const gate = existingGate || createConcurrencyGate(automaticSyncConcurrency[provider]);
    if (!existingGate) {
      providerBackgroundSyncGates.set(provider, gate);
    }

    return gate(task);
  };

  const buildSiblingLinks = async (link: {
    connectionId: string | null;
    provider: Provider | null;
  }): Promise<SiblingLink[]> => {
    if (!link.connectionId || !link.provider) {
      return [];
    }

    return database.accountLink.findMany({
      where: {
        status: {
          in: [...CURRENT_LINK_STATUSES]
        },
        connectionId: link.connectionId,
        provider: toPrismaProvider(link.provider),
        connectionAccountId: {
          not: null
        }
      },
      include: {
        connectionAccount: true
      }
    });
  };

  const buildReconcileTransactions = ({
    actualAccountId,
    actualCategories,
    linkConfig,
    siblingLinks,
    transactions
  }: {
    actualAccountId: string;
    actualCategories: ActualCategoryDto[];
    linkConfig: LinkConfigData;
    siblingLinks: Awaited<ReturnType<typeof buildSiblingLinks>>;
    transactions: ProviderSyncTransaction[];
  }) =>
    transactions.map(transaction => {
      const resolvedCategoryId = resolveTransactionCategoryId({
        transaction,
        actualCategories,
        categoryMappings: linkConfig.categoryMappings || []
      });

      return {
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payeeName,
        imported_payee: transaction.importedPayee,
        notes: transaction.notes,
        imported_id: transaction.importedId,
        cleared: transaction.cleared,
        category_names: transaction.categoryNames,
        resolved_category_id: resolvedCategoryId,
        transfer_actual_account_id: resolveTransferActualAccountId({
          transaction,
          siblings: siblingLinks.map(sibling => ({
            actualAccountId: sibling.actualAccountId,
            actualAccountName: sibling.actualAccountName,
            connectionAccount: sibling.connectionAccount
              ? {
                  name: sibling.connectionAccount.name,
                  officialName: sibling.connectionAccount.officialName,
                  mask: sibling.connectionAccount.mask
                }
              : null
          })),
          currentActualAccountId: actualAccountId
        })
      };
    });

  const getAutomaticSyncBlockReason = (link: Pick<SyncableLink, "configJson" | "connection">) => {
    const linkHealth = parseLinkConfig(link.configJson).health;
    if (isBlockingSyncHealth(linkHealth)) {
      return linkHealth?.message || "Link requires attention before automatic sync can continue.";
    }

    const connectionHealth = parseConnectionMetadata(link.connection?.metadataJson).health;
    if (isBlockingSyncHealth(connectionHealth)) {
      return connectionHealth?.message || "Connection requires attention before automatic sync can continue.";
    }

    return null;
  };

  const isAutomaticSyncBackoffActive = (link: Pick<SyncableLink, "configJson">) => {
    const backoffUntil = parseLinkConfig(link.configJson).automaticSyncBackoffUntil;
    if (!backoffUntil) {
      return false;
    }

    const backoffUntilMs = Date.parse(backoffUntil);
    return Number.isFinite(backoffUntilMs) && backoffUntilMs > now().getTime();
  };

  const loadCurrentSyncLink = async (actualAccountId: string): Promise<SyncableLink> =>
    database.accountLink.findFirstOrThrow({
      where: {
        actualAccountId,
        status: {
          in: [...CURRENT_LINK_STATUSES]
        }
      },
      include: {
        connection: true,
        connectionAccount: true
      },
      orderBy: [
        {
          status: "asc"
        },
        {
          updatedAt: "desc"
        },
        {
          createdAt: "desc"
        }
      ]
    });

  const createSyncRunForLink = async (link: Pick<SyncableLink, "id" | "connectionId">) =>
    database.syncRun.create({
      data: {
        accountLinkId: link.id,
        connectionId: link.connectionId,
        status: "RUNNING"
      }
    });

  const markSyncRunFailure = async ({
    link,
    syncRunId,
    error,
    summary = "Unknown sync failure",
    automatic = false
  }: {
    link: Pick<SyncableLink, "id" | "configJson">;
    syncRunId: string;
    error: unknown;
    summary?: string;
    automatic?: boolean;
  }) => {
    const existingConfig = parseLinkConfig(link.configJson);
    const nextAutomaticSyncFailureCount = automatic ? (existingConfig.automaticSyncFailureCount || 0) + 1 : 0;
    const backoffBaseMinutes = isRateLimitedSyncError(error)
      ? Math.min(runtime.automaticSyncBackoffMaxMinutes, runtime.automaticSyncBackoffBaseMinutes * 4)
      : runtime.automaticSyncBackoffBaseMinutes;
    const nextAutomaticSyncBackoffUntil = automatic
      ? new Date(
          now().getTime() +
            Math.min(
              runtime.automaticSyncBackoffMaxMinutes,
              backoffBaseMinutes * 2 ** Math.max(nextAutomaticSyncFailureCount - 1, 0)
            ) *
              60 *
              1000
        ).toISOString()
      : null;
    await database.syncRun.update({
      where: {
        id: syncRunId
      },
      data: {
        status: "FAILED",
        finishedAt: now(),
        error: error instanceof Error ? error.message : summary
      }
    });
    await database.accountLink.update({
      where: {
        id: link.id
      },
      data: {
        configJson: serializeLinkConfig({
          ...existingConfig,
          health: toSyncHealth(error, {
            scope: "ACTUAL_BACKEND",
            action: "RETRY"
          }),
          automaticSyncBackoffUntil: nextAutomaticSyncBackoffUntil,
          automaticSyncFailureCount: nextAutomaticSyncFailureCount,
          categoryMappings: existingConfig.categoryMappings || [],
          seenCategoryNames: existingConfig.seenCategoryNames || []
        })
      }
    });
  };

  const applySyncResultToLink = async ({
    link,
    syncRunId,
    syncResult
  }: {
    link: SyncableLink;
    syncRunId: string;
    syncResult: ProviderSyncResult;
  }) => {
    const actualCategories = (await actual.listCategories()).map(category => ({
      id: category.id,
      name: category.name
    }));
    let linkConfig = parseLinkConfig(link.configJson);
    linkConfig = await learnCategoryMappingsFromHistory({
      database,
      actual,
      link: {
        id: link.id,
        actualAccountId: link.actualAccountId
      },
      linkConfig,
      actualCategories,
      now: now()
    });

    const siblingLinks = await buildSiblingLinks(link);
    const reconcileTransactions: ReconcileTransactionInput[] = buildReconcileTransactions({
      actualAccountId: link.actualAccountId,
      actualCategories,
      linkConfig,
      siblingLinks,
      transactions: syncResult.transactions
    });
    const removedImportedIds = syncResult.removedImportedIds.filter(
      importedId => !reconcileTransactions.some(transaction => transaction.imported_id === importedId)
    );
    const migrating = link.status === "MIGRATING";
    const migrationImportPayload = reconcileTransactions.map(transaction => ({
      date: transaction.date,
      amount: transaction.amount,
      payee_name: transaction.payee_name,
      imported_payee: transaction.imported_payee,
      notes: transaction.notes,
      imported_id: transaction.imported_id,
      cleared: transaction.cleared,
      category: transaction.resolved_category_id,
      transfer_actual_account_id: transaction.transfer_actual_account_id
    }));
    const migrationResult = migrating ? await actual.importTransactions(link.actualAccountId, migrationImportPayload) : null;
    if (migrationResult?.errors.length) {
      throw new Error(migrationResult.errors[0]?.message || "Actual migration import failed");
    }
    const reconcileResult = !migrating && (reconcileTransactions.length || removedImportedIds.length)
      ? await actual.reconcileTransactions(link.actualAccountId, reconcileTransactions, removedImportedIds)
      : !migrating
        ? { added: 0, updated: 0, removed: 0, renamedPayees: 0 }
        : null;

    const refreshedTransactions =
      reconcileTransactions.length > 0
        ? await actual.listTransactionsByImportedIds(
            link.actualAccountId,
            reconcileTransactions.map(transaction => transaction.imported_id)
          )
        : [];
    const actualTransactionIdByImportedId = new Map(
      refreshedTransactions
        .filter(transaction => transaction.imported_id)
        .map(transaction => [transaction.imported_id as string, transaction.id])
    );

    if (reconcileTransactions.length > 0) {
      await Promise.all(
        reconcileTransactions.map((transaction, index) =>
          database.importedTransaction.upsert({
            where: {
              accountLinkId_providerImportedId: {
                accountLinkId: link.id,
                providerImportedId: transaction.imported_id
              }
            },
            update: {
              providerImportedId: transaction.imported_id,
              actualAccountId: link.actualAccountId,
              actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
              transactionDate: transaction.date,
              amount: transaction.amount,
              payeeName: transaction.payee_name,
              importedPayee: transaction.imported_payee,
              primarySourceCategory: getPrimarySourceCategory(syncResult.transactions[index]!),
              sourceCategoryNamesJson: JSON.stringify(syncResult.transactions[index]?.categoryNames || []),
              appliedCategoryId: transaction.resolved_category_id ?? null,
              lastSeenAt: now()
            },
            create: {
              accountLinkId: link.id,
              importedId: transaction.imported_id,
              providerImportedId: transaction.imported_id,
              actualAccountId: link.actualAccountId,
              actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
              transactionDate: transaction.date,
              amount: transaction.amount,
              payeeName: transaction.payee_name,
              importedPayee: transaction.imported_payee,
              primarySourceCategory: getPrimarySourceCategory(syncResult.transactions[index]!),
              sourceCategoryNamesJson: JSON.stringify(syncResult.transactions[index]?.categoryNames || []),
              appliedCategoryId: transaction.resolved_category_id ?? null,
              observedCategoryId: transaction.resolved_category_id ?? null,
              lastSeenAt: now()
            }
          })
        )
      );
    }

    if (!migrating && removedImportedIds.length > 0) {
      await database.importedTransaction.deleteMany({
        where: {
          accountLinkId: link.id,
          importedId: {
            in: removedImportedIds
          }
        }
      });
    }

    await pruneImportedTransactionLedger({
      database,
      accountLinkId: link.id,
      now: now()
    });

    const syncCompletedAt = now();
    await database.accountLink.update({
      where: {
        id: link.id
      },
      data: {
        status: migrating ? "ACTIVE" : link.status,
        lastSyncedAt: syncCompletedAt,
        migrationCompletedAt: migrating ? syncCompletedAt : link.migrationCompletedAt,
        configJson: serializeLinkConfig({
          ...linkConfig,
          ...syncResult.configPatch,
          health: clearSyncHealth(),
          automaticSyncBackoffUntil: null,
          automaticSyncFailureCount: 0,
          categoryMappings: linkConfig.categoryMappings || [],
          seenCategoryNames: [
            ...(linkConfig.seenCategoryNames || []),
            ...syncResult.transactions.flatMap(transaction => transaction.categoryNames || [])
          ]
        })
      }
    });

    await database.syncRun.update({
      where: {
        id: syncRunId
      },
      data: {
        status: "SUCCESS",
        finishedAt: now(),
        summary: migrating
          ? `Migration sync imported ${migrationResult?.added.length ?? 0} transactions, updated ${migrationResult?.updated.length ?? 0}, removed 0.`
          : `Imported ${reconcileResult?.added ?? 0} transactions, updated ${reconcileResult?.updated ?? 0}, removed ${reconcileResult?.removed ?? 0}.`
      }
    });
  };

  const runLoadedLinkSyncBatch = async (links: SyncableLink[]) => {
    const eligibleLinks: SyncableLink[] = [];

    for (const link of links) {
      if (isAutomaticSyncBackoffActive(link)) {
        continue;
      }

      const blockReason = getAutomaticSyncBlockReason(link);
      if (!blockReason) {
        eligibleLinks.push(link);
        continue;
      }

      await database.syncRun.create({
        data: {
          accountLinkId: link.id,
          connectionId: link.connectionId,
          status: "SKIPPED",
          finishedAt: now(),
          summary: `Skipped automatic sync: ${blockReason}`
        }
      });
    }

    if (eligibleLinks.length === 0) {
      return;
    }

    const syncRunsByLinkId = new Map<string, string>();
    for (const link of eligibleLinks) {
      const syncRun = await createSyncRunForLink(link);
      syncRunsByLinkId.set(link.id, syncRun.id);
    }

    const groups = new Map<string, SyncableLink[]>();
    for (const link of eligibleLinks) {
      const batchKey = link.provider && link.connectionId ? `${link.provider}:${link.connectionId}` : `single:${link.id}`;
      const group = groups.get(batchKey) || [];
      group.push(link);
      groups.set(batchKey, group);
    }

    for (const group of groups.values()) {
      const adapter = getProviderAdapter(group[0]?.provider);
      if (!adapter) {
        for (const link of group) {
          const syncRunId = syncRunsByLinkId.get(link.id);
          if (!syncRunId) {
            continue;
          }

          await database.syncRun.update({
            where: {
              id: syncRunId
            },
            data: {
              status: "SKIPPED",
              finishedAt: now(),
              summary: "No provider configured"
            }
          });
        }
        continue;
      }

      if (!adapter.syncAccountLinks || group.length === 1) {
        for (const link of group) {
          const syncRunId = syncRunsByLinkId.get(link.id);
          if (!syncRunId) {
            continue;
          }

          try {
            const syncResult = await runWithProviderBackgroundGate(link.provider!, () => adapter.syncAccountLink(link.id));
            await applySyncResultToLink({
              link,
              syncRunId,
              syncResult
            });
          } catch (error) {
            await markSyncRunFailure({
              link,
              syncRunId,
              error,
              automatic: true
            });
          }
        }
        continue;
      }

      let outcomes: Map<string, ProviderSyncOutcome>;
      try {
        outcomes = await runWithProviderBackgroundGate(group[0]!.provider!, () =>
          adapter.syncAccountLinks!(group.map(link => link.id))
        );
      } catch (error) {
        outcomes = new Map(group.map(link => [link.id, { error } satisfies ProviderSyncOutcome]));
      }

      for (const link of group) {
        const syncRunId = syncRunsByLinkId.get(link.id);
        if (!syncRunId) {
          continue;
        }

        const outcome = outcomes.get(link.id);
        const syncResult = outcome?.result;
        const syncError = outcome?.error ?? (!syncResult ? new Error(`No sync result returned for link ${link.id}`) : null);
        if (syncError) {
          await markSyncRunFailure({
            link,
            syncRunId,
            error: syncError,
            automatic: true
          });
          continue;
        }

        try {
          await applySyncResultToLink({
            link,
            syncRunId,
            syncResult: syncResult!
          });
        } catch (error) {
          await markSyncRunFailure({
            link,
            syncRunId,
            error,
            automatic: true
          });
        }
      }
    }
  };

  const syncReviewService = createSyncReviewService({
    database,
    actual,
    currentLinkStatuses: CURRENT_LINK_STATUSES,
    getProviderAdapter,
    buildSiblingLinks,
    buildReconcileTransactions,
    now
  });

  return {
    async getRuntimeInfo(): Promise<RuntimeInfoDto> {
      return {
        instanceLabel: runtime.instanceLabel,
        liveSandboxMode: runtime.liveSandboxMode,
        plaid: {
          enabled: runtime.plaidEnabled,
          environment: runtime.plaidEnvironment,
          sandboxToolsEnabled: runtime.plaidSandboxToolsEnabled
        },
        teller: {
          enabled: runtime.tellerEnabled,
          environment: runtime.tellerEnvironment,
          mtlsConfigured: runtime.tellerMtlsConfigured
        },
        actual: {
          serverUrl: runtime.actualServerUrl,
          budgetSyncIdConfigured: runtime.actualBudgetSyncIdConfigured
        }
      };
    },

    async listConnections(): Promise<ConnectionDto[]> {
      const connections = await database.connection.findMany({
        include: {
          accounts: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      return connections.map(connection => {
        const metadata = parseConnectionMetadata(connection.metadataJson);

        return {
          id: connection.id,
          provider: connection.provider,
          label: connection.label,
          status: connection.status,
          institutionName: connection.institutionName,
          institutionId: connection.institutionId,
          lastRefreshedAt: connection.lastRefreshedAt?.toISOString() ?? null,
          health: metadata.health ?? null,
          accounts: connection.accounts.map(account => ({
            id: account.id,
            externalAccountId: account.externalAccountId,
            name: account.name,
            officialName: account.officialName,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            currentBalance: account.currentBalance,
            availableBalance: account.availableBalance
          }))
        };
      });
    },

    async listActualAccounts(): Promise<ActualAccountDto[]> {
      const [actualAccounts, actualCategories, links, connections] = await Promise.all([
      actual.listAccounts(),
      actual.listCategories(),
      database.accountLink.findMany({
        where: {
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        orderBy: [
          {
            updatedAt: "desc"
          },
          {
            createdAt: "desc"
          }
        ]
      }),
      database.connection.findMany({
        include: {
          accounts: true
        }
      })
    ]);

    const linksByActualId = new Map<string, typeof links>();
    for (const link of links) {
      const group = linksByActualId.get(link.actualAccountId) || [];
      group.push(link);
      linksByActualId.set(link.actualAccountId, group);
    }
    const options: ConnectionAccountOptionDto[] = connections.flatMap(connection =>
      connection.accounts.map(account => {
        const metadata = parseConnectionMetadata(connection.metadataJson);
        return {
          connectionId: connection.id,
          connectionLabel: connection.label,
          connectionStatus: connection.status,
          connectionHealth: metadata.health ?? null,
          connectionAccountId: account.id,
          externalAccountId: account.externalAccountId,
          provider: connection.provider,
          institutionName: connection.institutionName,
          accountName: account.name,
          mask: account.mask,
          type: account.type,
          subtype: account.subtype
        };
      })
    );
    const categoryOptions: ActualCategoryDto[] = actualCategories.map(category => ({
      id: category.id,
      name: category.name
    }));

    const results: ActualAccountDto[] = [];
    for (const account of actualAccounts) {
      const link = selectCurrentLink(linksByActualId.get(account.id) || []) ?? null;

      results.push({
        id: account.id,
        name: account.name,
        balance: account.balance,
        offbudget: account.offbudget,
        closed: account.closed,
        link: toLinkDto(link, {
          actualAccountId: account.id,
          actualAccountName: account.name
        }),
        options,
        actualCategories: categoryOptions
      });
    }

      return results;
    },

    async listActualBankSyncLinks(): Promise<ActualBankSyncLinkDto[]> {
      const [actualBankSyncLinks, links] = await Promise.all([
        actual.listBankSyncLinks(),
        database.accountLink.findMany({
          where: {
            status: {
              in: [...CURRENT_LINK_STATUSES]
            }
          },
          orderBy: [
            {
              updatedAt: "desc"
            },
            {
              createdAt: "desc"
            }
          ]
        })
      ]);

      const linksByActualId = new Map<string, typeof links>();
      for (const link of links) {
        const group = linksByActualId.get(link.actualAccountId) || [];
        group.push(link);
        linksByActualId.set(link.actualAccountId, group);
      }

      return actualBankSyncLinks.map(link => {
        const currentLink = selectCurrentLink(linksByActualId.get(link.actualAccountId) || []) ?? null;
        return {
          ...link,
          currentLinkId: currentLink?.id ?? null,
          currentLinkProvider: currentLink?.provider ?? null,
          currentLinkStatus: currentLink?.status ?? null
        };
      });
    },

    async importExistingSimpleFinLinks(connectionId: string) {
      const [connection, actualBankSyncLinks, currentLinks] = await Promise.all([
        database.connection.findUniqueOrThrow({
          where: {
            id: connectionId
          },
          include: {
            accounts: true
          }
        }),
        actual.listBankSyncLinks(),
        database.accountLink.findMany({
          where: {
            status: {
              in: [...CURRENT_LINK_STATUSES]
            }
          },
          orderBy: [
            {
              updatedAt: "desc"
            },
            {
              createdAt: "desc"
            }
          ]
        })
      ]);

      if (connection.provider !== "SIMPLEFIN") {
        throw new Error("Connection is not a SimpleFIN connection");
      }

      const linksByActualId = new Map<string, typeof currentLinks>();
      for (const link of currentLinks) {
        const group = linksByActualId.get(link.actualAccountId) || [];
        group.push(link);
        linksByActualId.set(link.actualAccountId, group);
      }

      const connectionAccountsByExternalId = new Map(
        connection.accounts.map(account => [account.externalAccountId, account])
      );

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let unmatched = 0;

      for (const actualLink of actualBankSyncLinks.filter(link => link.accountSyncSource === "simpleFin")) {
        const connectionAccount = connectionAccountsByExternalId.get(actualLink.externalAccountId);
        if (!connectionAccount) {
          unmatched += 1;
          continue;
        }

        const currentLink = selectCurrentLink(linksByActualId.get(actualLink.actualAccountId) || []) ?? null;
        if (!currentLink) {
          await database.accountLink.create({
            data: {
              status: "ACTIVE",
              actualAccountId: actualLink.actualAccountId,
              actualAccountName: actualLink.actualAccountName,
              assetType: "BANK",
              provider: "SIMPLEFIN",
              connectionId: connection.id,
              connectionAccountId: connectionAccount.id,
              syncFrequency: "MANUAL",
              isEnabled: false,
              configJson: serializeLinkConfig({})
            }
          });
          imported += 1;
          continue;
        }

        if (
          currentLink.provider === "SIMPLEFIN" &&
          currentLink.connectionId === connection.id &&
          currentLink.connectionAccountId === connectionAccount.id
        ) {
          await database.accountLink.update({
            where: {
              id: currentLink.id
            },
            data: {
              actualAccountName: actualLink.actualAccountName
            }
          });
          updated += 1;
          continue;
        }

        skipped += 1;
      }

      return {
        imported,
        updated,
        skipped,
        unmatched
      };
    },

    async createConnectionReauthSession(connectionId: string, userId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          provider: true
        }
      });

      const adapter = getProviderAdapter(connection.provider);
      if (adapter?.createReauthSession) {
        return adapter.createReauthSession({
          connectionId,
          userId
        });
      }

      if (connection.provider === "SIMPLEFIN") {
        return {
          provider: "SIMPLEFIN",
          connectionId,
          mode: "manual",
          message: "SimpleFIN requires a new setup token. Reconnect it from the SimpleFIN Connections page."
        };
      }

      throw new Error("Reauthentication is not supported for this provider");
    },

    async disconnectConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          provider: true
        }
      });

      if (connection.provider !== "SIMPLEFIN") {
        throw new Error("Disconnect is only implemented for SimpleFIN today");
      }

      await simplefin.disconnectConnection(connectionId);
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          provider: true
        }
      });

      const adapter = getProviderAdapter(connection.provider);
      if (!adapter) {
        throw new Error("No provider adapter configured");
      }

      await adapter.refreshConnection(connectionId);
    },

    async refreshAllConnections() {
      const connections = await database.connection.findMany({
        select: {
          id: true,
          provider: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      await Promise.all(
        connections.map(connection => {
          const adapter = getProviderAdapter(connection.provider);
          if (!adapter) {
            return Promise.resolve();
          }

          return adapter.refreshConnection(connection.id);
        })
      );
    },

    async upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload) {
      const currentLink = await database.accountLink.findFirst({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        orderBy: [
          {
            status: "asc"
          },
          {
            updatedAt: "desc"
          },
          {
            createdAt: "desc"
          }
        ]
      });

      const mappingChanged = linkIdentityChanged(currentLink, payload);
      const existingConfig = parseLinkConfig(currentLink?.configJson);
      const nextConfig = {
        providerSyncState: mappingChanged ? undefined : existingConfig.providerSyncState,
        health: mappingChanged ? null : existingConfig.health ?? null,
        categoryMappings: mappingChanged ? [] : payload.categoryMappings,
        seenCategoryNames: mappingChanged ? [] : existingConfig.seenCategoryNames || []
      };

      const hasHistoricalImports = currentLink
        ? (await database.importedTransaction.count({
            where: {
              accountLinkId: currentLink.id
            }
          })) > 0
        : false;
      const shouldReplaceCurrentLink =
        Boolean(currentLink) &&
        Boolean(currentLink?.provider) &&
        Boolean(payload.provider) &&
        mappingChanged &&
        (hasHistoricalImports || Boolean(currentLink?.lastSyncedAt));

      if (!currentLink) {
        return database.accountLink.create({
          data: {
            status: "ACTIVE",
            actualAccountId,
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
            configJson: serializeLinkConfig(nextConfig)
          }
        });
      }

      if (!shouldReplaceCurrentLink) {
        return database.accountLink.update({
          where: {
            id: currentLink.id
          },
          data: {
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
            configJson: serializeLinkConfig(nextConfig)
          }
        });
      }

      const timestamp = now();
      return database.$transaction(async tx => {
        const replacement = await tx.accountLink.create({
          data: {
            status: "MIGRATING",
            actualAccountId,
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
            migrationStartedAt: timestamp,
            configJson: serializeLinkConfig(nextConfig)
          }
        });

        await tx.accountLink.update({
          where: {
            id: currentLink.id
          },
          data: {
            status: "INACTIVE",
            isEnabled: false,
            supersededAt: timestamp,
            replacedByLinkId: replacement.id
          }
        });

        return replacement;
      });
    },

    async runAccountSync(actualAccountId: string) {
      const link = await loadCurrentSyncLink(actualAccountId);
      const syncRun = await createSyncRunForLink(link);
      const adapter = getProviderAdapter(link.provider);
      if (!adapter) {
        await database.syncRun.update({
          where: {
            id: syncRun.id
          },
          data: {
            status: "SKIPPED",
            finishedAt: now(),
            summary: "No provider configured"
          }
        });
        return;
      }

      try {
        const syncResult = await adapter.syncAccountLink(link.id);
        await applySyncResultToLink({
          link,
          syncRunId: syncRun.id,
          syncResult
        });
      } catch (error) {
        await markSyncRunFailure({
          link,
          syncRunId: syncRun.id,
          error
        });
        throw error;
      }
    },

    async runScheduledLinkSyncs(linkIds: string[]) {
      if (linkIds.length === 0) {
        return;
      }

      const links = await database.accountLink.findMany({
        where: {
          id: {
            in: linkIds
          },
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: {
          connection: true,
          connectionAccount: true
        },
        orderBy: [
          {
            provider: "asc"
          },
          {
            connectionId: "asc"
          },
          {
            updatedAt: "desc"
          }
        ]
      });

      await runLoadedLinkSyncBatch(links);
    },

    async handleTellerWebhook(event: TellerWebhookEvent) {
      if (event.type === "webhook.test") {
        return;
      }

      const enrollmentId = event.payload.enrollment_id;
      if (!enrollmentId) {
        return;
      }

      const connection = await database.connection.findUnique({
        where: {
          provider_providerItemId: {
            provider: "TELLER",
            providerItemId: enrollmentId
          }
        },
        select: {
          id: true,
          metadataJson: true
        }
      });

      if (!connection) {
        return;
      }

      if (event.type === "enrollment.disconnected") {
        const metadata =
          connection.metadataJson && connection.metadataJson.length > 0
            ? (JSON.parse(connection.metadataJson) as Record<string, unknown>)
            : {};
        const disconnectReason = event.payload.reason ?? "Teller enrollment disconnected";
        const disconnectHealthState =
          disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
            ? "ATTENTION_REQUIRED"
            : "REAUTH_REQUIRED";

        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "DISCONNECTED",
            metadataJson: JSON.stringify({
              ...metadata,
              health: {
                state: disconnectHealthState,
                scope: disconnectReason.includes("credentials") || disconnectReason.includes("mfa") || disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
                  ? "BANK_AUTH"
                  : "CONNECTION_AUTH",
                action: disconnectReason.includes("credentials") || disconnectReason.includes("mfa") || disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
                  ? "REAUTH_BANK"
                  : "REAUTH_CONNECTION",
                code: "DISCONNECTED",
                message: disconnectReason,
                updatedAt: event.timestamp
              },
              teller: {
                ...(typeof metadata.teller === "object" && metadata.teller ? (metadata.teller as object) : {}),
                lastDisconnectReason: event.payload.reason ?? null,
                lastWebhookAt: event.timestamp
              }
            })
          }
        });

        await database.accountLink.updateMany({
          where: {
            connectionId: connection.id,
            status: {
              in: ["ACTIVE", "MIGRATING"]
            }
          },
          data: {
            isEnabled: false
          }
        });
        return;
      }

      if (event.type !== "transactions.processed") {
        return;
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const tellerMetadata = getTellerMetadata(metadata);
      const nowIso = now().toISOString();
      const lastWebhookSyncStartedAt =
        typeof tellerMetadata.lastWebhookSyncStartedAt === "string" ? tellerMetadata.lastWebhookSyncStartedAt : null;
      if (runtime.tellerWebhookSyncDebounceSeconds > 0 && lastWebhookSyncStartedAt) {
        const debounceMs = runtime.tellerWebhookSyncDebounceSeconds * 1000;
        const lastSyncMs = Date.parse(lastWebhookSyncStartedAt);
        if (Number.isFinite(lastSyncMs) && now().getTime() - lastSyncMs < debounceMs) {
          await database.connection.update({
            where: {
              id: connection.id
            },
            data: {
              metadataJson: JSON.stringify({
                ...metadata,
                teller: {
                  ...tellerMetadata,
                  lastWebhookAt: event.timestamp,
                  lastWebhookSkippedAt: nowIso,
                  lastWebhookSkipReason: "debounced"
                }
              })
            }
          });
          return;
        }
      }

      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          metadataJson: JSON.stringify({
            ...metadata,
            teller: {
              ...tellerMetadata,
              lastWebhookAt: event.timestamp,
              lastWebhookSyncStartedAt: nowIso
            }
          })
        }
      });

      const eligibleLinks = await database.accountLink.findMany({
        where: {
          connectionId: connection.id,
          provider: "TELLER",
          status: "ACTIVE",
          isEnabled: true,
          syncFrequency: {
            not: "MANUAL"
          }
        },
        select: {
          id: true
        }
      });

      await this.runScheduledLinkSyncs(eligibleLinks.map(link => link.id));
    },

    previewAccountSyncReview: syncReviewService.previewAccountSyncReview,

    commitAccountSyncReview: syncReviewService.commitAccountSyncReview,

    async listSyncRuns(limit = 20): Promise<SyncRunDto[]> {
      const runs = await database.syncRun.findMany({
      orderBy: {
        startedAt: "desc"
      },
      take: limit
    });

      return runs.map(run => ({
      id: run.id,
      accountLinkId: run.accountLinkId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      summary: run.summary,
      error: run.error
      }));
    }
  };
}

export const appService = createAppService();
