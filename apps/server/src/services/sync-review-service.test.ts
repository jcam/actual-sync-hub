import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createSyncReviewService } from "./sync-review-service.js";
import { serializeLinkConfig } from "./link-config.js";

describe.sequential("sync review service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("does not advance provider sync state during preview", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    await prisma.accountLink.create({
      data: {
        id: "link-1",
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: serializeLinkConfig({
          providerSyncState: {
            windowStartDate: "2026-03-22",
            windowEndDate: "2026-04-25"
          },
          health: null,
          categoryMappings: [],
          seenCategoryNames: []
        })
      }
    });

    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        previewImportTransactions: vi.fn().mockResolvedValue({
          errors: [],
          updatedPreview: [
            {
              transaction: {
                imported_id: "sf-1",
                date: "2026-05-05",
                amount: -12.34,
                imported_payee: "MERCHANT",
                notes: null,
                cleared: true
              },
              existing: false,
              ignored: false
            }
          ]
        }),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        listTransactionsByDateRange: vi.fn()
      },
      currentLinkStatuses: ["ACTIVE", "MIGRATING"],
      getProviderAdapter: () =>
        ({
          provider: "SIMPLEFIN",
          syncAccountLink: vi.fn().mockResolvedValue({
            imported: 1,
            transactions: [
              {
                importedId: "sf-1",
                date: "2026-05-05",
                amount: -12.34,
                payeeName: "Merchant",
                importedPayee: "MERCHANT",
                cleared: true,
                categoryNames: [],
                searchText: ["Merchant"]
              }
            ],
            removedImportedIds: [],
            configPatch: {
              providerSyncState: {
                windowStartDate: "2026-04-26",
                windowEndDate: "2026-05-06"
              }
            }
          })
        }) as never,
      buildSiblingLinks: vi.fn().mockResolvedValue([]),
      buildReconcileTransactions: vi.fn().mockReturnValue([
        {
          date: "2026-05-05",
          amount: -12.34,
          payee_name: "Merchant",
          imported_payee: "MERCHANT",
          imported_id: "sf-1",
          cleared: true,
          category_names: [],
          resolved_category_id: undefined,
          transfer_actual_account_id: undefined
        }
      ]),
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");
    const link = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: "link-1"
      }
    });

    expect(preview.items).toHaveLength(1);
    expect(link.configJson).toBe(
      serializeLinkConfig({
        providerSyncState: {
          windowStartDate: "2026-03-22",
          windowEndDate: "2026-04-25"
        },
        health: null,
        categoryMappings: [],
        seenCategoryNames: []
      })
    );
  });

  it("completes native external sync writeback after reviewed sync commit", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    await prisma.accountLink.create({
      data: {
        id: "link-1",
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: serializeLinkConfig({
          health: null,
          categoryMappings: [],
          seenCategoryNames: []
        })
      }
    });

    const syncActualExternalWriteback = vi.fn().mockResolvedValue(undefined);
    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        previewImportTransactions: vi.fn(),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 1,
          updated: 0,
          removed: 0,
          addedIds: ["tx-1"],
          updatedIds: []
        }),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([
          {
            id: "tx-1",
            imported_id: "sf-1"
          }
        ])
      },
      currentLinkStatuses: ["ACTIVE", "MIGRATING"],
      getProviderAdapter: () =>
        ({
          provider: "SIMPLEFIN",
          syncAccountLink: vi.fn().mockResolvedValue({
            imported: 1,
            transactions: [
              {
                importedId: "sf-1",
                date: "2026-05-05",
                amount: -12.34,
                payeeName: "Merchant",
                importedPayee: "MERCHANT",
                cleared: true,
                categoryNames: [],
                searchText: ["Merchant"]
              }
            ],
            removedImportedIds: [],
            configPatch: {}
          })
        }) as never,
      buildSiblingLinks: vi.fn().mockResolvedValue([]),
      buildReconcileTransactions: vi.fn().mockReturnValue([
        {
          date: "2026-05-05",
          amount: -12.34,
          payee_name: "Merchant",
          imported_payee: "MERCHANT",
          imported_id: "sf-1",
          cleared: true,
          category_names: [],
          resolved_category_id: undefined,
          transfer_actual_account_id: undefined
        }
      ]),
      syncActualExternalWriteback,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    await syncReviewService.commitAccountSyncReview("actual-1", {
      importedIds: ["sf-1"]
    });

    expect(syncActualExternalWriteback).toHaveBeenCalledWith({
      actualAccountId: "actual-1",
      lastSync: "1778068800000"
    });
  });
});
