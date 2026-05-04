import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppService } from "./app-service.js";
import { createTestDatabase } from "../test/test-db.js";

describe.sequential("app service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("clears the saved Plaid cursor when the provider mapping changes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const firstAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const secondAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Savings",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: firstAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({ plaidCursor: "cursor-1" })
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn()
      } as never,
      plaidService: {
        syncAccountLink: vi.fn()
      } as never
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: secondAccount.id,
      syncFrequency: "DAILY",
      isEnabled: true,
      categoryMappings: []
    });

    const link = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });

    expect(JSON.parse(link.configJson || "{}")).toEqual({
      categoryMappings: [],
      seenCategoryNames: []
    });
  });

  it("creates a migrating replacement link when a synced provider link is switched", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const firstAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const secondAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Savings",
        type: "depository"
      }
    });

    const originalLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: firstAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        lastSyncedAt: new Date("2026-05-03T12:00:00.000Z"),
        configJson: JSON.stringify({ plaidCursor: "cursor-1" })
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: originalLink.id,
        importedId: "old-1",
        providerImportedId: "old-1",
        actualAccountId: "actual-1",
        transactionDate: "2026-05-01",
        amount: -10,
        payeeName: "Store",
        importedPayee: "STORE",
        primarySourceCategory: "Groceries",
        sourceCategoryNamesJson: JSON.stringify(["Groceries"]),
        appliedCategoryId: null,
        observedCategoryId: null
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn()
      } as never,
      plaidService: {
        syncAccountLink: vi.fn()
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z")
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: secondAccount.id,
      syncFrequency: "DAILY",
      isEnabled: true,
      categoryMappings: []
    });

    const links = await prisma.accountLink.findMany({
      where: {
        actualAccountId: "actual-1"
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      id: originalLink.id,
      status: "INACTIVE",
      isEnabled: false
    });
    expect(links[1]).toMatchObject({
      status: "MIGRATING",
      connectionAccountId: secondAccount.id,
      isEnabled: true
    });
    expect(links[0]?.replacedByLinkId).toBe(links[1]?.id);
  });

  it("records a successful sync run and updates the stored cursor", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });
    const syncedTransactions = [
      {
        date: "2026-05-03",
        amount: -12.34,
        payeeName: "Coffee Shop",
        importedPayee: "COFFEE SHOP",
        importedId: "plaid-1",
        cleared: true,
        categoryNames: ["Food And Drink"],
        searchText: ["Coffee Shop"]
      }
    ];
    const now = new Date("2026-05-04T12:00:00.000Z");

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-food", name: "Food" }
        ]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: syncedTransactions,
          removedImportedIds: [],
          nextCursor: "cursor-2"
        })
      } as never,
      now: () => now
    });

    await service.runAccountSync("actual-1");

    const link = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });
    const runs = await prisma.syncRun.findMany();
    const importedTransactions = await prisma.importedTransaction.findMany();

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [
      {
        amount: -12.34,
        category_names: ["Food And Drink"],
        cleared: true,
        date: "2026-05-03",
        imported_id: "plaid-1",
        imported_payee: "COFFEE SHOP",
        notes: undefined,
        payee_name: "Coffee Shop",
        resolved_category_id: "cat-food",
        transfer_actual_account_id: undefined
      }
    ], []);
    expect(link.lastSyncedAt?.toISOString()).toBe(now.toISOString());
    expect(link.configJson).toContain("cursor-2");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("SUCCESS");
    expect(runs[0]?.summary).toBe("Imported 1 transactions, updated 0, removed 0.");
    expect(importedTransactions).toHaveLength(1);
    expect(importedTransactions[0]).toMatchObject({
      importedId: "plaid-1",
      providerImportedId: "plaid-1",
      primarySourceCategory: "Food And Drink",
      appliedCategoryId: "cat-food",
      observedCategoryId: "cat-food"
    });
  });

  it("promotes a migrating link after the first sync using Actual import reconciliation", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Replacement Checking",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        status: "MIGRATING",
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        migrationStartedAt: new Date("2026-05-04T11:00:00.000Z")
      }
    });

    const importTransactions = vi.fn().mockResolvedValue({
      added: ["txn-new"],
      updated: ["txn-existing"],
      errors: []
    });
    const reconcileTransactions = vi.fn();
    const syncTime = new Date("2026-05-04T12:00:00.000Z");

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-food", name: "Food" }
        ]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([
          {
            id: "txn-existing",
            imported_id: "plaid-1",
            date: "2026-05-03",
            amount: -12.34,
            category: "cat-food"
          }
        ]),
        importTransactions,
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-03",
              amount: -12.34,
              payeeName: "Coffee Shop",
              importedPayee: "COFFEE SHOP",
              importedId: "plaid-1",
              cleared: true,
              categoryNames: ["Food And Drink"],
              searchText: ["Coffee Shop"]
            }
          ],
          removedImportedIds: ["plaid-1"],
          nextCursor: "cursor-migrated"
        })
      } as never,
      now: () => syncTime
    });

    await service.runAccountSync("actual-1");

    expect(importTransactions).toHaveBeenCalledWith("actual-1", [
      expect.objectContaining({
        imported_id: "plaid-1",
        category: "cat-food"
      })
    ]);
    expect(reconcileTransactions).not.toHaveBeenCalled();

    const currentLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: "ACTIVE"
      }
    });
    const syncRuns = await prisma.syncRun.findMany({
      orderBy: {
        startedAt: "desc"
      }
    });
    const ledgerRows = await prisma.importedTransaction.findMany();

    expect(currentLink.migrationCompletedAt?.toISOString()).toBe(syncTime.toISOString());
    expect(currentLink.lastSyncedAt?.toISOString()).toBe(syncTime.toISOString());
    expect(currentLink.configJson).toContain("cursor-migrated");
    expect(syncRuns[0]?.summary).toBe("Migration sync imported 1 transactions, updated 1, removed 0.");
    expect(ledgerRows[0]).toMatchObject({
      importedId: "plaid-1",
      providerImportedId: "plaid-1",
      actualTransactionId: "txn-existing"
    });
  });

  it("passes a transfer target hint when a Plaid transfer appears to match another mapped account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-checking",
        name: "Checking",
        officialName: "Main Checking",
        mask: "1111",
        type: "depository"
      }
    });

    const savings = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-savings",
        name: "Savings",
        officialName: "Rainy Day Savings",
        mask: "2222",
        type: "depository"
      }
    });

    await prisma.accountLink.createMany({
      data: [
        {
          actualAccountId: "actual-checking",
          actualAccountName: "Household Checking",
          assetType: "BANK",
          provider: "PLAID",
          connectionId: connection.id,
          connectionAccountId: checking.id,
          syncFrequency: "DAILY",
          isEnabled: true
        },
        {
          actualAccountId: "actual-savings",
          actualAccountName: "Emergency Savings",
          assetType: "BANK",
          provider: "PLAID",
          connectionId: connection.id,
          connectionAccountId: savings.id,
          syncFrequency: "DAILY",
          isEnabled: true
        }
      ]
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-03",
              amount: -50,
              payeeName: "Transfer to Rainy Day Savings",
              importedPayee: "Transfer to Rainy Day Savings",
              importedId: "plaid-transfer-1",
              cleared: true,
              categoryNames: ["Transfer Out"],
              searchText: ["Rainy Day Savings"]
            }
          ],
          removedImportedIds: [],
          nextCursor: "cursor-2"
        })
      } as never
    });

    await service.runAccountSync("actual-checking");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-checking", [
      expect.objectContaining({
        category_names: ["Transfer Out"],
        imported_id: "plaid-transfer-1",
        resolved_category_id: undefined,
        transfer_actual_account_id: "actual-savings"
      })
    ], []);
  });

  it("learns a category mapping from recent Actual recategorizations without storing full transactions", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({
          categoryMappings: [],
          seenCategoryNames: ["Groceries"]
        })
      }
    });

    await prisma.importedTransaction.createMany({
      data: [
        {
          accountLinkId: link.id,
          importedId: "old-1",
          providerImportedId: "old-1",
          actualAccountId: "actual-1",
          transactionDate: "2026-05-01",
          amount: -12.5,
          payeeName: "Store A",
          importedPayee: "STORE A",
          primarySourceCategory: "Groceries",
          sourceCategoryNamesJson: JSON.stringify(["Groceries", "Food And Drink"]),
          appliedCategoryId: null,
          observedCategoryId: null
        },
        {
          accountLinkId: link.id,
          importedId: "old-2",
          providerImportedId: "old-2",
          actualAccountId: "actual-1",
          transactionDate: "2026-05-02",
          amount: -20,
          payeeName: "Store B",
          importedPayee: "STORE B",
          primarySourceCategory: "Groceries",
          sourceCategoryNamesJson: JSON.stringify(["Groceries", "Food And Drink"]),
          appliedCategoryId: null,
          observedCategoryId: null
        }
      ]
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-groceries", name: "Groceries" }
        ]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([
          {
            id: "txn-1",
            imported_id: "old-1",
            date: "2026-05-01",
            amount: -12.5,
            category: "cat-groceries"
          },
          {
            id: "txn-2",
            imported_id: "old-2",
            date: "2026-05-02",
            amount: -20,
            category: "cat-groceries"
          }
        ]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-04",
              amount: -9.99,
              payeeName: "Corner Market",
              importedPayee: "CORNER MARKET",
              importedId: "new-1",
              cleared: true,
              categoryNames: ["Groceries", "Food And Drink"],
              searchText: ["Corner Market"]
            }
          ],
          removedImportedIds: [],
          nextCursor: "cursor-3"
        })
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z")
    });

    await service.runAccountSync("actual-1");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [
      expect.objectContaining({
        imported_id: "new-1",
        resolved_category_id: "cat-groceries"
      })
    ], []);

    const refreshedLink = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: link.id
      }
    });
    expect(JSON.parse(refreshedLink.configJson || "{}").categoryMappings).toEqual([
      {
        sourceCategory: "Groceries",
        actualCategoryId: "cat-groceries"
      }
    ]);
  });

  it("prunes stale imported-transaction ledger rows during sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: link.id,
        importedId: "old-stale",
        providerImportedId: "old-stale",
        actualAccountId: "actual-1",
        transactionDate: "2025-10-01",
        amount: -15,
        payeeName: "Old Merchant",
        importedPayee: "OLD MERCHANT",
        primarySourceCategory: "Groceries",
        sourceCategoryNamesJson: JSON.stringify(["Groceries"]),
        appliedCategoryId: "cat-groceries",
        observedCategoryId: "cat-groceries",
        lastSeenAt: new Date("2025-10-01T00:00:00.000Z")
      }
    });

    const currentTime = new Date("2026-05-04T12:00:00.000Z");
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-groceries", name: "Groceries" }
        ]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 1,
          updated: 0,
          removed: 0,
          renamedPayees: 0
        })
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-04",
              amount: -9.99,
              payeeName: "Corner Market",
              importedPayee: "CORNER MARKET",
              importedId: "new-1",
              cleared: true,
              categoryNames: ["Groceries"],
              searchText: ["Corner Market"]
            }
          ],
          removedImportedIds: [],
          nextCursor: "cursor-4"
        })
      } as never,
      now: () => currentTime
    });

    await service.runAccountSync("actual-1");

    const ledgerRows = await prisma.importedTransaction.findMany({
      orderBy: {
        importedId: "asc"
      }
    });

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.importedId).toBe("new-1");
  });

  it("removes deleted Plaid transactions by imported id and clears their ledger rows", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        itemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: link.id,
        importedId: "gone-1",
        providerImportedId: "gone-1",
        actualAccountId: "actual-1",
        transactionDate: "2026-05-01",
        amount: -15,
        payeeName: "Old Merchant",
        importedPayee: "OLD MERCHANT",
        primarySourceCategory: "Groceries",
        sourceCategoryNamesJson: JSON.stringify(["Groceries"]),
        appliedCategoryId: "cat-groceries",
        observedCategoryId: "cat-groceries"
      }
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 0,
      updated: 0,
      removed: 1,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByImportedIds: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 0,
          transactions: [],
          removedImportedIds: ["gone-1"],
          nextCursor: "cursor-5"
        })
      } as never
    });

    await service.runAccountSync("actual-1");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [], ["gone-1"]);
    expect(await prisma.importedTransaction.count()).toBe(0);
  });
});
