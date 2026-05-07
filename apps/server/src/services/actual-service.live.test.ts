import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as ActualApi from "@actual-app/api";
import { afterEach, describe, expect, it } from "vitest";
import { createActualService } from "./actual-service.js";
import { startActualTestContainer } from "../test/actual-container.js";

const liveEnabled = process.env.ACTUAL_TEST_RUN_LIVE === "1";
type ActualApiModule = typeof ActualApi;

async function seedBudget({
  serverURL,
  password,
  dataDir
}: {
  serverURL: string;
  password: string;
  dataDir: string;
}) {
  const actual = await import("@actual-app/api");
  await fs.mkdir(dataDir, { recursive: true });
  const previousActualDataDir = process.env.ACTUAL_DATA_DIR;
  process.env.ACTUAL_DATA_DIR = dataDir;

  await actual.init({
    dataDir,
    serverURL,
    password
  });

  try {
    await actual.runImport("Integration Test Budget", async () => {
      const accountId = await actual.createAccount(
        {
          name: "Checking"
        },
        250_00
      );

      await actual.addTransactions(accountId, [
        {
          date: "2026-05-01",
          amount: -12_34,
          payee_name: "Seed Coffee",
          imported_payee: "SEED COFFEE",
          imported_id: "seed-1",
          cleared: true
        }
      ]);
    });

    const budgets = await actual.getBudgets();
    const localBudget = budgets.find(budget => budget.name === "Integration Test Budget");
    if (!localBudget?.id) {
      throw new Error("Expected the imported Actual budget to exist locally");
    }

    if (!localBudget.cloudFileId) {
      await actual.internal!.send("upload-budget", undefined);
    }

    const syncedBudgets = await actual.getBudgets();
    const remoteBudget = syncedBudgets.find(budget => budget.name === "Integration Test Budget" && budget.groupId);
    if (!remoteBudget?.groupId) {
      throw new Error("Expected a synced Actual budget to be created");
    }

    await actual.downloadBudget(remoteBudget.groupId);
    const accounts = await actual.getAccounts();
    const account = accounts.find(entry => entry.name === "Checking");
    if (!account) {
      throw new Error("Expected seeded Checking account");
    }

    return {
      syncId: remoteBudget.groupId,
      accountId: account.id
    };
  } finally {
    await actual.shutdown();
    if (previousActualDataDir === undefined) {
      delete process.env.ACTUAL_DATA_DIR;
    } else {
      process.env.ACTUAL_DATA_DIR = previousActualDataDir;
    }
  }
}

async function withBudgetSession<T>({
  serverURL,
  password,
  dataDir,
  syncId,
  fn
}: {
  serverURL: string;
  password: string;
  dataDir: string;
  syncId: string;
  fn: (actual: ActualApiModule) => Promise<T>;
}) {
  const actual = await import("@actual-app/api");
  await fs.mkdir(dataDir, { recursive: true });
  const previousActualDataDir = process.env.ACTUAL_DATA_DIR;
  process.env.ACTUAL_DATA_DIR = dataDir;

  await actual.init({
    dataDir,
    serverURL,
    password
  });

  try {
    await actual.downloadBudget(syncId);
    return await fn(actual);
  } finally {
    await actual.shutdown();
    if (previousActualDataDir === undefined) {
      delete process.env.ACTUAL_DATA_DIR;
    } else {
      process.env.ACTUAL_DATA_DIR = previousActualDataDir;
    }
  }
}

describe.skipIf(!liveEnabled)("actual service live docker", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("lists accounts and imports transactions against a real Actual container", async () => {
    const password = process.env.ACTUAL_TEST_PASSWORD || "actual-test-password";
    const container = await startActualTestContainer();
    cleanups.push(() => container.stop());

    await container.setPassword(password);

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-live-cache-"));
    cleanups.push(() => fs.rm(cacheDir, { recursive: true, force: true }));

    const seed = await seedBudget({
      serverURL: container.serverURL,
      password,
      dataDir: path.join(cacheDir, "seed")
    });

    const service = createActualService({
      config: {
        serverURL: container.serverURL,
        password,
        budgetSyncId: seed.syncId,
        dataDir: path.join(cacheDir, "service")
      }
    });
    cleanups.push(() => service.shutdown?.() ?? Promise.resolve());

    const accounts = await service.listAccounts();
    const checking = accounts.find(account => account.name === "Checking");
    expect(checking).toBeTruthy();

    await service.importTransactions(seed.accountId, [
      {
        date: "2026-05-02",
        amount: -23.45,
        payee_name: "Live Test Groceries",
        imported_payee: "LIVE TEST GROCERIES",
        imported_id: "live-test-1",
        cleared: true
      }
    ]);

    const transactions = await service.listTransactionsByDateRange(seed.accountId, "2026-05-02", "2026-05-02");
    expect(transactions.some(transaction => transaction.imported_payee === "LIVE TEST GROCERIES")).toBe(true);
  }, 120_000);

  it("preserves split subtransactions when updateTransaction applies a partial patch", async () => {
    const password = process.env.ACTUAL_TEST_PASSWORD || "actual-test-password";
    const container = await startActualTestContainer();
    cleanups.push(() => container.stop());

    await container.setPassword(password);

    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-live-cache-"));
    cleanups.push(() => fs.rm(cacheDir, { recursive: true, force: true }));

    const seed = await seedBudget({
      serverURL: container.serverURL,
      password,
      dataDir: path.join(cacheDir, "seed")
    });

    await withBudgetSession({
      serverURL: container.serverURL,
      password,
      syncId: seed.syncId,
      dataDir: path.join(cacheDir, "pre-reconcile"),
      fn: async actual => {
        await actual.addTransactions(seed.accountId, [
          {
            date: "2026-05-03",
            amount: -20_00,
            payee_name: "Seed Split Purchase",
            imported_payee: "SEED SPLIT PURCHASE",
            imported_id: "split-parent-1",
            cleared: false,
            subtransactions: [
              {
                amount: -15_00,
                notes: "Groceries"
              },
              {
                amount: -5_00,
                notes: "Fees"
              }
            ]
          }
        ]);
        await actual.sync();
      }
    });

    await withBudgetSession({
      serverURL: container.serverURL,
      password,
      syncId: seed.syncId,
      dataDir: path.join(cacheDir, "update-split"),
      fn: async actual => {
        const categories = await actual.getCategories();
        const firstCategory = categories.find(category => "group_id" in category);
        if (!firstCategory) {
          throw new Error("Expected at least one Actual category for split update regression test");
        }

        const transactions = await actual.getTransactions(seed.accountId, "2026-05-01", "2026-05-10");
        const splitParent = transactions.find(transaction => transaction.imported_id === "split-parent-1");
        if (!splitParent) {
          throw new Error("Expected seeded split transaction");
        }

        await actual.updateTransaction(splitParent.id, {
          cleared: true,
          notes: "Reviewed through reconcile"
        });
        await actual.sync();
      }
    });

    const updatedTransaction = await withBudgetSession({
      serverURL: container.serverURL,
      password,
      syncId: seed.syncId,
      dataDir: path.join(cacheDir, "post-reconcile"),
      fn: async actual => {
        await actual.sync();
        const transactions = await actual.getTransactions(seed.accountId, "2026-05-01", "2026-05-10");
        return transactions.find(transaction => transaction.imported_id === "split-parent-1");
      }
    });

    expect(updatedTransaction).toBeTruthy();
    expect(updatedTransaction?.cleared).toBe(true);
    expect(updatedTransaction?.notes).toBe("Reviewed through reconcile");
    expect(updatedTransaction?.subtransactions).toHaveLength(2);
    expect(updatedTransaction?.subtransactions?.map(entry => entry.amount)).toEqual([-15_00, -5_00]);
  }, 120_000);
});
