import type {
  ActualAccountDto,
  ActualCategoryDto,
  CommitMigrationPayload,
  CategoryMappingDto,
  ConnectionAccountOptionDto,
  ConnectionDto,
  LinkConfigDto,
  MigrationPreviewDto,
  RuntimeInfoDto,
  SyncRunDto,
  UpdateAccountLinkPayload
} from "@actual-sync/shared";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { actualService, type ReconcileTransactionInput } from "./actual-service.js";
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
  mapPreviewItemByImportedId,
  resolveTransactionCategoryId,
  resolveTransferActualAccountId,
  toImportTransactionInput
} from "./plaid-sync-helpers.js";

type DatabaseClient = typeof prisma;
type ActualService = typeof actualService;

const CATEGORY_LEARNING_WINDOW_DAYS = 45;
const CATEGORY_LEARNING_MIN_MATCHES = 2;
const IMPORTED_TRANSACTION_RETENTION_DAYS = 180;
const IMPORTED_TRANSACTION_MAX_ROWS_PER_LINK = 2_000;
const MIGRATION_LOOKBACK_DAYS = 90;

async function learnCategoryMappingsFromHistory({
  database,
  actual,
  link,
  linkConfig,
  actualCategories,
  now
}: {
  database: DatabaseClient;
  actual: ActualService;
  link: {
    id: string;
    actualAccountId: string;
  };
  linkConfig: LinkConfigData;
  actualCategories: ActualCategoryDto[];
  now: Date;
}) {
  const recentImportedTransactions = await database.importedTransaction.findMany({
    where: {
      accountLinkId: link.id,
      primarySourceCategory: {
        not: null
      },
      lastSeenAt: {
        gte: new Date(now.getTime() - CATEGORY_LEARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      }
    },
    orderBy: {
      lastSeenAt: "desc"
    },
    take: 250
  });

  if (recentImportedTransactions.length === 0) {
    return linkConfig;
  }

  const currentTransactions = await actual.listTransactionsByImportedIds(
    link.actualAccountId,
    recentImportedTransactions.map(transaction => transaction.importedId)
  );
  const currentCategoryByImportedId = new Map(
    currentTransactions
      .filter(transaction => transaction.imported_id)
      .map(transaction => [transaction.imported_id as string, transaction.category ?? null])
  );

  const ledgerUpdates = recentImportedTransactions
    .filter(transaction => currentCategoryByImportedId.has(transaction.importedId))
    .filter(transaction => transaction.observedCategoryId !== currentCategoryByImportedId.get(transaction.importedId))
    .map(transaction =>
      database.importedTransaction.update({
        where: {
          id: transaction.id
        },
        data: {
          observedCategoryId: currentCategoryByImportedId.get(transaction.importedId) ?? null
        }
      })
    );
  if (ledgerUpdates.length > 0) {
    await Promise.all(ledgerUpdates);
  }

  const existingMappings = new Map((linkConfig.categoryMappings || []).map(mapping => [mapping.sourceCategory, mapping.actualCategoryId]));
  const evidence = new Map<string, Map<string, number>>();

  for (const transaction of recentImportedTransactions) {
    const sourceCategory = transaction.primarySourceCategory;
    if (!sourceCategory || existingMappings.has(sourceCategory)) {
      continue;
    }

    const currentCategoryId = currentCategoryByImportedId.get(transaction.importedId);
    if (!currentCategoryId || currentCategoryId === transaction.appliedCategoryId) {
      continue;
    }

    const categoryCounts = evidence.get(sourceCategory) || new Map<string, number>();
    categoryCounts.set(currentCategoryId, (categoryCounts.get(currentCategoryId) || 0) + 1);
    evidence.set(sourceCategory, categoryCounts);
  }

  const knownCategoryIds = new Set(actualCategories.map(category => category.id));
  const learnedMappings: CategoryMappingDto[] = [];
  for (const [sourceCategory, categoryCounts] of evidence) {
    const ranked = [...categoryCounts.entries()].sort((left, right) => right[1] - left[1]);
    if (ranked.length !== 1) {
      continue;
    }

    const [actualCategoryId, count] = ranked[0];
    if (count < CATEGORY_LEARNING_MIN_MATCHES || !knownCategoryIds.has(actualCategoryId)) {
      continue;
    }

    learnedMappings.push({
      sourceCategory,
      actualCategoryId
    });
  }

  if (learnedMappings.length === 0) {
    return linkConfig;
  }

  return {
    ...linkConfig,
    categoryMappings: [...(linkConfig.categoryMappings || []), ...learnedMappings]
  } satisfies LinkConfigData;
}

async function pruneImportedTransactionLedger({
  database,
  accountLinkId,
  now
}: {
  database: DatabaseClient;
  accountLinkId: string;
  now: Date;
}) {
  const retentionCutoff = new Date(
    now.getTime() - IMPORTED_TRANSACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  await database.importedTransaction.deleteMany({
    where: {
      accountLinkId,
      lastSeenAt: {
        lt: retentionCutoff
      }
    }
  });

  const overflowRows = await database.importedTransaction.findMany({
    where: {
      accountLinkId
    },
    orderBy: [
      {
        lastSeenAt: "desc"
      },
      {
        createdAt: "desc"
      }
    ],
    skip: IMPORTED_TRANSACTION_MAX_ROWS_PER_LINK,
    select: {
      id: true
    }
  });

  if (overflowRows.length > 0) {
    await database.importedTransaction.deleteMany({
      where: {
        id: {
          in: overflowRows.map(row => row.id)
        }
      }
    });
  }
}

export interface AppService {
  getRuntimeInfo(): Promise<RuntimeInfoDto>;
  listConnections(): Promise<ConnectionDto[]>;
  listActualAccounts(): Promise<ActualAccountDto[]>;
  refreshAllConnections(): Promise<void>;
  upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload): Promise<unknown>;
  runAccountSync(actualAccountId: string): Promise<void>;
  previewAccountSyncReview(actualAccountId: string): Promise<MigrationPreviewDto>;
  commitAccountSyncReview(actualAccountId: string, payload: CommitMigrationPayload): Promise<void>;
  listSyncRuns(limit?: number): Promise<SyncRunDto[]>;
}

export function createAppService({
  prisma: database = prisma,
  actualService: actual = actualService,
  plaidService: plaid = plaidService,
  runtime = {
    instanceLabel: env.APP_INSTANCE_LABEL,
    liveSandboxMode: env.liveSandboxMode,
    actualServerUrl: env.ACTUAL_SERVER_URL,
    actualBudgetSyncIdConfigured: Boolean(env.ACTUAL_BUDGET_SYNC_ID),
    plaidEnabled: env.plaidEnabled,
    plaidEnvironment: env.PLAID_ENV,
    plaidSandboxToolsEnabled: env.plaidSandboxToolsEnabled
  },
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  actualService?: ActualService;
  plaidService?: PlaidService;
  runtime?: {
    instanceLabel: string;
    liveSandboxMode: boolean;
    actualServerUrl: string;
    actualBudgetSyncIdConfigured: boolean;
    plaidEnabled: boolean;
    plaidEnvironment: "sandbox" | "production";
    plaidSandboxToolsEnabled: boolean;
  };
  now?: () => Date;
} = {}): AppService {
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

      return connections.map(connection => ({
      id: connection.id,
      provider: connection.provider,
      label: connection.label,
      status: connection.status,
      institutionName: connection.institutionName,
      institutionId: connection.institutionId,
      lastRefreshedAt: connection.lastRefreshedAt?.toISOString() ?? null,
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
      }));
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
      connection.accounts.map(account => ({
        connectionId: connection.id,
        connectionLabel: connection.label,
        connectionStatus: connection.status,
        connectionAccountId: account.id,
        externalAccountId: account.externalAccountId,
        provider: connection.provider,
        institutionName: connection.institutionName,
        accountName: account.name,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype
      }))
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

    async refreshAllConnections() {
      const connections = await database.connection.findMany({
        select: {
          id: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      await Promise.all(connections.map(connection => plaid.refreshConnection(connection.id)));
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
        plaidCursor: mappingChanged ? undefined : existingConfig.plaidCursor,
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
            provider: payload.provider ?? null,
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
            provider: payload.provider ?? null,
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
            provider: payload.provider ?? null,
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
      const link = await database.accountLink.findFirstOrThrow({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: {
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

      const syncRun = await database.syncRun.create({
      data: {
        accountLinkId: link.id,
        connectionId: link.connectionId,
        status: "RUNNING"
      }
    });

    try {
      if (link.provider !== "PLAID") {
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

      const plaidResult = await plaid.syncAccountLink(link.id);
      const siblingLinks = link.connectionId
        ? await database.accountLink.findMany({
            where: {
              status: {
                in: [...CURRENT_LINK_STATUSES]
              },
              connectionId: link.connectionId,
              provider: "PLAID",
              connectionAccountId: {
                not: null
              }
            },
            include: {
              connectionAccount: true
            }
          })
        : [];
      const reconcileTransactions: ReconcileTransactionInput[] = plaidResult.transactions.map(transaction => {
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
      const removedImportedIds = plaidResult.removedImportedIds.filter(
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
      const migrationResult = migrating
        ? await actual.importTransactions(actualAccountId, migrationImportPayload)
        : null;
      if (migrationResult?.errors.length) {
        throw new Error(migrationResult.errors[0]?.message || "Actual migration import failed");
      }
      const reconcileResult = !migrating && (reconcileTransactions.length || removedImportedIds.length)
        ? await actual.reconcileTransactions(actualAccountId, reconcileTransactions, removedImportedIds)
        : !migrating
          ? { added: 0, updated: 0, removed: 0, renamedPayees: 0 }
          : null;

      const refreshedTransactions =
        reconcileTransactions.length > 0
          ? await actual.listTransactionsByImportedIds(
              actualAccountId,
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
                actualAccountId,
                actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
                transactionDate: transaction.date,
                amount: transaction.amount,
                payeeName: transaction.payee_name,
                importedPayee: transaction.imported_payee,
                primarySourceCategory: getPrimarySourceCategory(plaidResult.transactions[index]!),
                sourceCategoryNamesJson: JSON.stringify(plaidResult.transactions[index]?.categoryNames || []),
                appliedCategoryId: transaction.resolved_category_id ?? null,
                lastSeenAt: now()
              },
              create: {
                accountLinkId: link.id,
                importedId: transaction.imported_id,
                providerImportedId: transaction.imported_id,
                actualAccountId,
                actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
                transactionDate: transaction.date,
                amount: transaction.amount,
                payeeName: transaction.payee_name,
                importedPayee: transaction.imported_payee,
                primarySourceCategory: getPrimarySourceCategory(plaidResult.transactions[index]!),
                sourceCategoryNamesJson: JSON.stringify(plaidResult.transactions[index]?.categoryNames || []),
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

      await database.accountLink.update({
        where: {
          id: link.id
        },
        data: {
          status: migrating ? "ACTIVE" : link.status,
          lastSyncedAt: now(),
          migrationCompletedAt: migrating ? now() : link.migrationCompletedAt,
          configJson: serializeLinkConfig({
            plaidCursor: plaidResult.nextCursor || undefined,
            categoryMappings: linkConfig.categoryMappings || [],
            seenCategoryNames: [
              ...(linkConfig.seenCategoryNames || []),
              ...plaidResult.transactions.flatMap(transaction => transaction.categoryNames || [])
            ]
          })
        }
      });

      await database.syncRun.update({
        where: {
          id: syncRun.id
        },
        data: {
          status: "SUCCESS",
          finishedAt: now(),
          summary: migrating
            ? `Migration sync imported ${migrationResult?.added.length ?? 0} transactions, updated ${migrationResult?.updated.length ?? 0}, removed 0.`
            : `Imported ${reconcileResult?.added ?? 0} transactions, updated ${reconcileResult?.updated ?? 0}, removed ${reconcileResult?.removed ?? 0}.`
        }
      });
    } catch (error) {
      await database.syncRun.update({
        where: {
          id: syncRun.id
        },
        data: {
          status: "FAILED",
          finishedAt: now(),
          error: error instanceof Error ? error.message : "Unknown sync failure"
        }
      });
      throw error;
    }
    },

    async previewAccountSyncReview(actualAccountId: string): Promise<MigrationPreviewDto> {
      const link = await database.accountLink.findFirstOrThrow({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: {
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

      if (link.provider !== "PLAID") {
        throw new Error("Sync review is only supported for Plaid links right now");
      }

      const actualCategories = (await actual.listCategories()).map(category => ({
        id: category.id,
        name: category.name
      }));
      const linkConfig = parseLinkConfig(link.configJson);
      const plaidResult = await plaid.syncAccountLink(link.id);
      const siblingLinks = link.connectionId
        ? await database.accountLink.findMany({
            where: {
              status: {
                in: [...CURRENT_LINK_STATUSES]
              },
              connectionId: link.connectionId,
              provider: "PLAID",
              connectionAccountId: {
                not: null
              }
            },
            include: {
              connectionAccount: true
            }
          })
        : [];

      const reconcileTransactions: ReconcileTransactionInput[] = plaidResult.transactions.map(transaction => {
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

      const previewResult = await actual.previewImportTransactions(
        actualAccountId,
        reconcileTransactions.map(toImportTransactionInput)
      );
      if (previewResult.errors.length > 0) {
        throw new Error(previewResult.errors[0]?.message || "Actual migration preview failed");
      }
      const previewByImportedId = mapPreviewItemByImportedId(previewResult.updatedPreview);

      return {
        actualAccountId,
        actualAccountName: link.actualAccountName,
        linkId: link.id,
        status: link.status,
        items: plaidResult.transactions.map(transaction => {
          const preview = previewByImportedId.get(transaction.importedId);
          const action = preview?.ignored ? "ignore" : preview?.existing ? "update" : "add";

          return {
            importedId: transaction.importedId,
            date: transaction.date,
            amount: transaction.amount,
            payeeName: transaction.payeeName,
            importedPayee: transaction.importedPayee ?? null,
            cleared: transaction.cleared,
            categoryNames: transaction.categoryNames || [],
            action,
            existing:
              preview?.existing
                ? {
                    id: preview.existing.id,
                    date: preview.existing.date,
                    amount: preview.existing.amount ?? 0,
                    importedId: preview.existing.imported_id ?? null,
                    importedPayee: preview.existing.imported_payee ?? null,
                    notes: preview.existing.notes ?? null,
                    cleared: preview.existing.cleared ?? null
                  }
                : null
          };
        })
      };
    },

    async commitAccountSyncReview(actualAccountId: string, payload: CommitMigrationPayload) {
      const link = await database.accountLink.findFirstOrThrow({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: {
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

      if (link.provider !== "PLAID") {
        throw new Error("Sync review commit is only supported for Plaid links right now");
      }

      const syncRun = await database.syncRun.create({
        data: {
          accountLinkId: link.id,
          connectionId: link.connectionId,
          status: "RUNNING"
        }
      });

      try {
        const allowedImportedIds = new Set(payload.importedIds);
        const actualCategories = (await actual.listCategories()).map(category => ({
          id: category.id,
          name: category.name
        }));
        const linkConfig = parseLinkConfig(link.configJson);
        const plaidResult = await plaid.syncAccountLink(link.id);
        const siblingLinks = link.connectionId
          ? await database.accountLink.findMany({
              where: {
                status: {
                  in: [...CURRENT_LINK_STATUSES]
                },
                connectionId: link.connectionId,
                provider: "PLAID",
                connectionAccountId: {
                  not: null
                }
              },
              include: {
                connectionAccount: true
              }
            })
          : [];

        const selectedTransactions = plaidResult.transactions.filter(transaction =>
          allowedImportedIds.has(transaction.importedId)
        );
        const reconcileTransactions: ReconcileTransactionInput[] = selectedTransactions.map(transaction => {
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

        const migrating = link.status === "MIGRATING";
        const removedImportedIds = plaidResult.removedImportedIds.filter(
          importedId => !reconcileTransactions.some(transaction => transaction.imported_id === importedId)
        );
        const migrationResult = migrating
          ? await actual.importTransactions(actualAccountId, reconcileTransactions.map(toImportTransactionInput))
          : null;
        if (migrationResult?.errors.length) {
          throw new Error(migrationResult.errors[0]?.message || "Actual sync review import failed");
        }
        const reconcileResult = !migrating
          ? await actual.reconcileTransactions(actualAccountId, reconcileTransactions, removedImportedIds)
          : null;

        const refreshedTransactions =
          reconcileTransactions.length > 0
            ? await actual.listTransactionsByImportedIds(
                actualAccountId,
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
                  actualAccountId,
                  actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
                  transactionDate: transaction.date,
                  amount: transaction.amount,
                  payeeName: transaction.payee_name,
                  importedPayee: transaction.imported_payee,
                  primarySourceCategory: getPrimarySourceCategory(selectedTransactions[index]!),
                  sourceCategoryNamesJson: JSON.stringify(selectedTransactions[index]?.categoryNames || []),
                  appliedCategoryId: transaction.resolved_category_id ?? null,
                  lastSeenAt: now()
                },
                create: {
                  accountLinkId: link.id,
                  importedId: transaction.imported_id,
                  providerImportedId: transaction.imported_id,
                  actualAccountId,
                  actualTransactionId: actualTransactionIdByImportedId.get(transaction.imported_id) ?? null,
                  transactionDate: transaction.date,
                  amount: transaction.amount,
                  payeeName: transaction.payee_name,
                  importedPayee: transaction.imported_payee,
                  primarySourceCategory: getPrimarySourceCategory(selectedTransactions[index]!),
                  sourceCategoryNamesJson: JSON.stringify(selectedTransactions[index]?.categoryNames || []),
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

        await database.accountLink.update({
          where: {
            id: link.id
          },
          data: {
            status: migrating ? "ACTIVE" : link.status,
            lastSyncedAt: now(),
            migrationCompletedAt: migrating ? now() : link.migrationCompletedAt,
            configJson: serializeLinkConfig({
              plaidCursor: plaidResult.nextCursor || undefined,
              categoryMappings: linkConfig.categoryMappings || [],
              seenCategoryNames: [
                ...(linkConfig.seenCategoryNames || []),
                ...selectedTransactions.flatMap(transaction => transaction.categoryNames || [])
              ]
            })
          }
        });

        await database.syncRun.update({
          where: {
            id: syncRun.id
          },
          data: {
            status: "SUCCESS",
            finishedAt: now(),
            summary: migrating
              ? `Migration sync imported ${migrationResult?.added.length ?? 0} transactions, updated ${migrationResult?.updated.length ?? 0}, removed 0.`
              : `Reviewed sync imported ${reconcileResult?.added ?? 0} transactions, updated ${reconcileResult?.updated ?? 0}, removed ${reconcileResult?.removed ?? 0}.`
          }
        });
      } catch (error) {
        await database.syncRun.update({
          where: {
            id: syncRun.id
          },
          data: {
            status: "FAILED",
            finishedAt: now(),
            error: error instanceof Error ? error.message : "Unknown migration sync failure"
          }
        });
        throw error;
      }
    },

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
