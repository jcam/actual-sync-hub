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

  it("respects Actual external sync importPending and importNotes prefs during review preview", async () => {
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

    const buildReconcileTransactions = vi.fn().mockImplementation(({ transactions }) =>
      transactions.map((transaction: {
        importedId: string;
        date: string;
        amount: number;
        payeeName: string;
        importedPayee?: string;
        notes?: string;
        cleared: boolean;
      }) => ({
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payeeName,
        imported_payee: transaction.importedPayee,
        notes: transaction.notes,
        imported_id: transaction.importedId,
        cleared: transaction.cleared,
        category_names: [],
        resolved_category_id: undefined,
        transfer_actual_account_id: undefined
      }))
    );

    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        getExternalSyncAccount: vi.fn().mockResolvedValue({
          id: "actual-1",
          linked: true,
          syncSource: "external",
          providerAccountId: "ext-1",
          institutionName: "First Platypus Bank",
          institutionExternalId: "platypus-bank",
          mask: "1234",
          officialName: "Checking",
          balanceCurrent: 50000,
          balanceAvailable: 45000,
          balanceLimit: null,
          lastSync: null,
          prefs: {
            importPending: false,
            importNotes: false,
            reimportDeleted: true,
            importTransactions: true,
            updateDates: false
          }
        }),
        previewImportTransactions: vi.fn().mockResolvedValue({
          errors: [],
          updatedPreview: [
            {
              transaction: {
                imported_id: "posted-1",
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
            imported: 2,
            transactions: [
              {
                importedId: "posted-1",
                date: "2026-05-05",
                amount: -12.34,
                payeeName: "Merchant",
                importedPayee: "MERCHANT",
                notes: "POSTED NOTE",
                cleared: true,
                categoryNames: [],
                searchText: ["Merchant"]
              },
              {
                importedId: "pending-1",
                date: "2026-05-06",
                amount: -25,
                payeeName: "Pending Merchant",
                importedPayee: "PENDING MERCHANT",
                notes: "PENDING NOTE",
                cleared: false,
                categoryNames: [],
                searchText: ["Pending Merchant"]
              }
            ],
            removedImportedIds: [],
            configPatch: {}
          })
        }) as never,
      buildSiblingLinks: vi.fn().mockResolvedValue([]),
      buildReconcileTransactions,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");

    expect(buildReconcileTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        transactions: [
          expect.objectContaining({
            importedId: "posted-1",
            cleared: true
          })
        ]
      })
    );
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]?.importedId).toBe("posted-1");
  });

  it("respects Actual external sync importTransactions during review preview", async () => {
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

    const buildReconcileTransactions = vi.fn().mockReturnValue([]);
    const previewImportTransactions = vi.fn().mockResolvedValue({
      errors: [],
      updatedPreview: []
    });

    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        getExternalSyncAccount: vi.fn().mockResolvedValue({
          id: "actual-1",
          linked: true,
          syncSource: "external",
          providerAccountId: "ext-1",
          institutionName: "First Platypus Bank",
          institutionExternalId: "platypus-bank",
          mask: "1234",
          officialName: "Checking",
          balanceCurrent: 50000,
          balanceAvailable: 45000,
          balanceLimit: null,
          lastSync: null,
          prefs: {
            importPending: true,
            importNotes: true,
            reimportDeleted: true,
            importTransactions: false,
            updateDates: false
          }
        }),
        previewImportTransactions,
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
                importedId: "posted-1",
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
      buildReconcileTransactions,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");

    expect(buildReconcileTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        transactions: []
      })
    );
    expect(previewImportTransactions).not.toHaveBeenCalled();
    expect(preview.items).toHaveLength(0);
  });

  it("forces snapshot delta review when Actual external sync importTransactions is false and a balance snapshot is available", async () => {
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

    const buildReconcileTransactions = vi.fn().mockImplementation(({ transactions }: { transactions: Array<{
      date: string;
      amount: number;
      payeeName: string;
      importedPayee?: string | null;
      importedId: string;
      cleared?: boolean;
      categoryNames?: string[];
    }> }) =>
      transactions.map(transaction => ({
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payeeName,
        imported_payee: transaction.importedPayee,
        imported_id: transaction.importedId,
        cleared: transaction.cleared,
        category_names: transaction.categoryNames ?? [],
        resolved_category_id: undefined,
        transfer_actual_account_id: undefined
      }))
    );
    const previewImportTransactions = vi.fn().mockResolvedValue({
      errors: [],
      updatedPreview: [
        {
          transaction: {
            imported_id: "snapshot:acct-1:2026-05-05"
          },
          existing: false,
          ignored: false
        }
      ]
    });

    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        getAccountBalance: vi.fn().mockResolvedValue(400),
        getExternalSyncAccount: vi.fn().mockResolvedValue({
          id: "actual-1",
          linked: true,
          syncSource: "external",
          providerAccountId: "ext-1",
          institutionName: "First Platypus Bank",
          institutionExternalId: "platypus-bank",
          mask: "1234",
          officialName: "Checking",
          balanceCurrent: 35000,
          balanceAvailable: 35000,
          balanceLimit: null,
          lastSync: null,
          prefs: {
            importPending: true,
            importNotes: true,
            reimportDeleted: true,
            importTransactions: false,
            updateDates: false
          }
        }),
        previewImportTransactions,
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
                importedId: "posted-1",
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
            configPatch: {},
            balanceSnapshot: {
              asOfDate: "2026-05-05",
              currentValue: 350,
              stableId: "snapshot:acct-1",
              payeeName: "Balance Adjustment",
              notes: "Snapshot from provider"
            }
          })
        }) as never,
      buildSiblingLinks: vi.fn().mockResolvedValue([]),
      buildReconcileTransactions,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");

    expect(buildReconcileTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        transactions: [
          expect.objectContaining({
            importedId: "snapshot:acct-1:2026-05-05",
            amount: -50,
            payeeName: "Balance Adjustment"
          })
        ]
      })
    );
    expect(previewImportTransactions).toHaveBeenCalledWith(
      "actual-1",
      [
        expect.objectContaining({
          imported_id: "snapshot:acct-1:2026-05-05",
          amount: -50
        })
      ],
      {
        reimportDeleted: true,
        updateDates: false
      }
    );
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]).toMatchObject({
      importedId: "snapshot:acct-1:2026-05-05",
      amount: -50,
      payeeName: "Balance Adjustment",
      action: "add"
    });
  });

  it("includes transactions and snapshot delta in preview when writeMode is combined", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    await prisma.accountLink.create({
      data: {
        id: "link-1",
        actualAccountId: "actual-1",
        actualAccountName: "Brokerage",
        assetType: "INVESTMENT",
        writeMode: "TRANSACTIONS_AND_SNAPSHOT_DELTA",
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

    const buildReconcileTransactions = vi.fn().mockImplementation(({ transactions }: { transactions: Array<{
      date: string;
      amount: number;
      payeeName: string;
      importedPayee?: string | null;
      importedId: string;
      cleared?: boolean;
      categoryNames?: string[];
    }> }) =>
      transactions.map(transaction => ({
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payeeName,
        imported_payee: transaction.importedPayee,
        imported_id: transaction.importedId,
        cleared: transaction.cleared,
        category_names: transaction.categoryNames ?? [],
        resolved_category_id: undefined,
        transfer_actual_account_id: undefined
      }))
    );
    const previewImportTransactions = vi
      .fn()
      .mockResolvedValueOnce({
        errors: [],
        updatedPreview: [
          {
            transaction: {
              imported_id: "trade-1"
            },
            existing: false,
            ignored: false
          }
        ]
      })
      .mockResolvedValueOnce({
        errors: [],
        updatedPreview: [
          {
            transaction: {
              imported_id: "trade-1"
            },
            existing: false,
            ignored: false
          },
          {
            transaction: {
              imported_id: "snapshot:acct-1:2026-05-05"
            },
            existing: false,
            ignored: false
          }
        ]
      });

    const syncReviewService = createSyncReviewService({
      database: prisma,
      actual: {
        listCategories: vi.fn().mockResolvedValue([]),
        getAccountBalance: vi.fn().mockResolvedValue(400),
        getExternalSyncAccount: vi.fn().mockResolvedValue({
          id: "actual-1",
          linked: true,
          syncSource: "external",
          providerAccountId: "ext-1",
          institutionName: "First Platypus Bank",
          institutionExternalId: "platypus-bank",
          mask: "1234",
          officialName: "Brokerage",
          balanceCurrent: 50000,
          balanceAvailable: 50000,
          balanceLimit: null,
          lastSync: null,
          prefs: {
            importPending: true,
            importNotes: true,
            reimportDeleted: true,
            importTransactions: true,
            updateDates: false
          }
        }),
        previewImportTransactions,
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
                importedId: "trade-1",
                date: "2026-05-05",
                amount: -50,
                payeeName: "Buy VXUS",
                importedPayee: "BUY VXUS",
                cleared: true,
                categoryNames: [],
                searchText: ["Buy VXUS"]
              }
            ],
            removedImportedIds: [],
            configPatch: {},
            balanceSnapshot: {
              asOfDate: "2026-05-05",
              currentValue: 500,
              stableId: "snapshot:acct-1",
              payeeName: "Market Value Adjustment",
              notes: "Snapshot from provider"
            }
          })
        }) as never,
      buildSiblingLinks: vi.fn().mockResolvedValue([]),
      buildReconcileTransactions,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");

    expect(previewImportTransactions).toHaveBeenNthCalledWith(
      1,
      "actual-1",
      [
        expect.objectContaining({
          imported_id: "trade-1",
          amount: -50
        })
      ],
      {
        reimportDeleted: true,
        updateDates: false
      }
    );
    expect(previewImportTransactions).toHaveBeenNthCalledWith(
      2,
      "actual-1",
      [
        expect.objectContaining({
          imported_id: "trade-1",
          amount: -50
        }),
        expect.objectContaining({
          imported_id: "snapshot:acct-1:2026-05-05",
          amount: 150
        })
      ],
      {
        reimportDeleted: true,
        updateDates: false
      }
    );
    expect(preview.items).toHaveLength(2);
    expect(preview.items[0]).toMatchObject({
      importedId: "trade-1",
      amount: -50,
      payeeName: "Buy VXUS"
    });
    expect(preview.items[1]).toMatchObject({
      importedId: "snapshot:acct-1:2026-05-05",
      amount: 150,
      payeeName: "Market Value Adjustment"
    });
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
    const markActualExternalSyncPending = vi.fn().mockResolvedValue(undefined);
    const markActualExternalSyncSuccess = vi.fn().mockResolvedValue(undefined);
    const syncAccountLink = vi.fn().mockResolvedValue({
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
                imported_id: "sf-1"
              },
              existing: false,
              ignored: false
            }
          ]
        }),
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
          syncAccountLink
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
      markActualExternalSyncPending,
      markActualExternalSyncSuccess,
      now: () => new Date("2026-05-06T12:00:00.000Z")
    });

    const preview = await syncReviewService.previewAccountSyncReview("actual-1");
    await syncReviewService.commitAccountSyncReview("actual-1", {
      snapshotId: preview.snapshotId,
      importedIds: ["sf-1"]
    });

    expect(syncAccountLink).toHaveBeenCalledTimes(1);
    expect(markActualExternalSyncPending).toHaveBeenCalledWith("actual-1");
    expect(syncActualExternalWriteback).toHaveBeenCalledWith({
      actualAccountId: "actual-1",
      lastSync: "1778068800000"
    });
    expect(markActualExternalSyncSuccess).toHaveBeenCalledWith("actual-1", "1778068800000");
  });
});
