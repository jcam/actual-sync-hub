import type {
  AccountLinkStatus,
  ActualCategoryDto,
  CommitMigrationPayload,
  MigrationPreviewDto,
  Provider
} from "@actual-sync/shared";
import type { prisma } from "../db.js";
import type { ActualService, ReconcileTransactionInput } from "./actual-service.js";
import { pruneImportedTransactionLedger } from "./imported-transaction-ledger.js";
import type { LinkConfigData } from "./link-config.js";
import { parseLinkConfig, serializeLinkConfig } from "./link-config.js";
import {
  getPrimarySourceCategory,
  mapPreviewItemByImportedId,
  toImportTransactionInput
} from "./provider-sync-helpers.js";
import type { ProviderAdapter, ProviderSyncTransaction } from "./provider-adapter.js";
import { clearSyncHealth, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;
type ReviewDatabase = Pick<DatabaseClient, "accountLink" | "syncRun" | "importedTransaction">;
type ReviewActualService = Pick<
  ActualService,
  "listCategories" | "previewImportTransactions" | "importTransactions" | "reconcileTransactions" | "listTransactionsByDateRange"
>;

type ReviewableLink = {
  id: string;
  status: AccountLinkStatus;
  actualAccountId: string;
  actualAccountName: string;
  provider: Provider | null;
  connectionId: string | null;
  configJson?: string | null;
  migrationCompletedAt: Date | null;
};

function toActualLastSyncValue(timestamp: Date): string {
  return timestamp.getTime().toString();
}

export function createSyncReviewService<TSiblingLinks>({
  database,
  actual,
  currentLinkStatuses,
  getProviderAdapter,
  buildSiblingLinks,
  buildReconcileTransactions,
  syncActualExternalWriteback,
  now
}: {
  database: ReviewDatabase;
  actual: ReviewActualService;
  currentLinkStatuses: readonly AccountLinkStatus[];
  getProviderAdapter: (provider: Provider | null | undefined) => ProviderAdapter | null;
  buildSiblingLinks: (link: Pick<ReviewableLink, "connectionId" | "provider">) => Promise<TSiblingLinks>;
  buildReconcileTransactions: (args: {
    actualAccountId: string;
    actualCategories: ActualCategoryDto[];
    linkConfig: LinkConfigData;
    siblingLinks: TSiblingLinks;
    transactions: ProviderSyncTransaction[];
  }) => ReconcileTransactionInput[];
  syncActualExternalWriteback?: (args: { actualAccountId: string; lastSync?: string | null }) => Promise<void>;
  now: () => Date;
}) {
  function getDateRangeBounds(dates: string[]) {
    if (dates.length === 0) {
      return null;
    }

    const sorted = [...dates].sort((left, right) => left.localeCompare(right));
    return {
      startDate: sorted[0]!,
      endDate: sorted[sorted.length - 1]!
    };
  }

  async function loadCurrentReviewableLink(actualAccountId: string): Promise<ReviewableLink> {
    return database.accountLink.findFirstOrThrow({
      where: {
        actualAccountId,
        status: {
          in: [...currentLinkStatuses]
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
  }

  async function persistReviewFailure(link: Pick<ReviewableLink, "id" | "configJson">, error: unknown, syncRunId?: string) {
    const existingConfig = parseLinkConfig(link.configJson);

    if (syncRunId) {
      await database.syncRun.update({
        where: {
          id: syncRunId
        },
        data: {
          status: "FAILED",
          finishedAt: now(),
          error: error instanceof Error ? error.message : "Unknown migration sync failure"
        }
      });
    }

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
          categoryMappings: existingConfig.categoryMappings || [],
          seenCategoryNames: existingConfig.seenCategoryNames || []
        })
      }
    });
  }

  async function listActualCategories() {
    return (await actual.listCategories()).map(category => ({
      id: category.id,
      name: category.name
    }));
  }

  return {
    previewAccountSyncReview: async (actualAccountId: string): Promise<MigrationPreviewDto> => {
      const link = await loadCurrentReviewableLink(actualAccountId);
      const adapter = getProviderAdapter(link.provider);
      if (!adapter) {
        throw new Error("Sync review is not supported for this link");
      }

      try {
        const actualCategories = await listActualCategories();
        const linkConfig = parseLinkConfig(link.configJson);
        const syncResult = await adapter.syncAccountLink(link.id);
        const siblingLinks = await buildSiblingLinks(link);
        const reconcileTransactions = buildReconcileTransactions({
          actualAccountId,
          actualCategories,
          linkConfig,
          siblingLinks,
          transactions: syncResult.transactions
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
          items: syncResult.transactions.map(transaction => {
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
      } catch (error) {
        await persistReviewFailure(link, error);
        throw error;
      }
    },

    commitAccountSyncReview: async (actualAccountId: string, payload: CommitMigrationPayload) => {
      const link = await loadCurrentReviewableLink(actualAccountId);
      const adapter = getProviderAdapter(link.provider);
      if (!adapter) {
        throw new Error("Sync review commit is not supported for this link");
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
        const actualCategories = await listActualCategories();
        const linkConfig = parseLinkConfig(link.configJson);
        const syncResult = await adapter.syncAccountLink(link.id);
        const siblingLinks = await buildSiblingLinks(link);
        const selectedTransactions = syncResult.transactions.filter(transaction =>
          allowedImportedIds.has(transaction.importedId)
        );
        const reconcileTransactions = buildReconcileTransactions({
          actualAccountId,
          actualCategories,
          linkConfig,
          siblingLinks,
          transactions: selectedTransactions
        });

        const migrating = link.status === "MIGRATING";
        const removedImportedIds = syncResult.removedImportedIds.filter(
          importedId => !reconcileTransactions.some(transaction => transaction.imported_id === importedId)
        );
        const migrationResult = migrating
          ? await actual.importTransactions(actualAccountId, reconcileTransactions.map(toImportTransactionInput))
          : null;
        if (migrationResult?.errors.length) {
          throw new Error(migrationResult.errors[0]?.message || "Actual sync review import failed");
        }
        const removedActualTransactionIds = !migrating && removedImportedIds.length > 0
          ? (
              await database.importedTransaction.findMany({
                where: {
                  accountLinkId: link.id,
                  importedId: {
                    in: removedImportedIds
                  },
                  actualTransactionId: {
                    not: null
                  }
                },
                select: {
                  actualTransactionId: true
                }
              })
            )
              .map(transaction => transaction.actualTransactionId)
              .filter((transactionId): transactionId is string => Boolean(transactionId))
          : [];
        const reconcileResult = !migrating
          ? await actual.reconcileTransactions(
              actualAccountId,
              reconcileTransactions,
              removedImportedIds,
              removedActualTransactionIds
            )
          : null;
        const bounds = getDateRangeBounds(reconcileTransactions.map(transaction => transaction.date));
        const importedTransactionByImportedId =
          bounds && reconcileTransactions.length > 0
            ? new Map(
                (
                  await actual.listTransactionsByDateRange(actualAccountId, bounds.startDate, bounds.endDate)
                )
                  .filter(
                    transaction =>
                      transaction.imported_id &&
                      reconcileTransactions.some(candidate => candidate.imported_id === transaction.imported_id)
                  )
                  .map(transaction => [transaction.imported_id as string, transaction])
              )
            : new Map<string, Awaited<ReturnType<typeof actual.listTransactionsByDateRange>>[number]>();

        if (reconcileTransactions.length > 0) {
          await Promise.all(
            reconcileTransactions.map((transaction, index) =>
              database.importedTransaction.upsert({
                where: {
                  accountLinkId_importedId: {
                    accountLinkId: link.id,
                    importedId: transaction.imported_id
                }
                },
                update: {
                  transactionDate: transaction.date,
                  actualTransactionId: importedTransactionByImportedId.get(transaction.imported_id)?.id ?? null,
                  primarySourceCategory: getPrimarySourceCategory(selectedTransactions[index]!),
                  appliedCategoryId: transaction.resolved_category_id ?? null,
                  lastSeenAt: now()
                },
                create: {
                  accountLinkId: link.id,
                  importedId: transaction.imported_id,
                  transactionDate: transaction.date,
                  actualTransactionId: importedTransactionByImportedId.get(transaction.imported_id)?.id ?? null,
                  primarySourceCategory: getPrimarySourceCategory(selectedTransactions[index]!),
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
              categoryMappings: linkConfig.categoryMappings || [],
              seenCategoryNames: [
                ...(linkConfig.seenCategoryNames || []),
                ...selectedTransactions.flatMap(transaction => transaction.categoryNames || [])
              ]
            })
          }
        });

        const actualLastSync = toActualLastSyncValue(syncCompletedAt);
        if (syncActualExternalWriteback) {
          await syncActualExternalWriteback({
            actualAccountId: link.actualAccountId,
            lastSync: actualLastSync
          });
        }

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
        await persistReviewFailure(link, error, syncRun.id);
        throw error;
      }
    }
  };
}
