import fs from "node:fs/promises";

export async function seedActualSandboxBudget({
  serverURL,
  password,
  dataDir,
  budgetName = "Actual Sync Hub Sandbox"
}: {
  serverURL: string;
  password: string;
  dataDir: string;
  budgetName?: string;
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
    await actual.runImport(budgetName, async () => {
      const checkingId = await actual.createAccount(
        {
          name: "Sandbox Checking"
        },
        2_450_00
      );
      const savingsId = await actual.createAccount(
        {
          name: "Sandbox Savings"
        },
        8_200_00
      );
      const reserveId = await actual.createAccount(
        {
          name: "Travel Reserve"
        },
        650_00
      );

      await actual.addTransactions(checkingId, [
        {
          date: "2026-05-01",
          amount: -12_34,
          payee_name: "Seed Coffee",
          imported_payee: "SEED COFFEE",
          imported_id: "seed-checking-1",
          cleared: true
        },
        {
          date: "2026-05-02",
          amount: -54_89,
          payee_name: "Seed Groceries",
          imported_payee: "SEED GROCERIES",
          imported_id: "seed-checking-2",
          cleared: true
        }
      ]);

      await actual.addTransactions(savingsId, [
        {
          date: "2026-05-01",
          amount: 150_00,
          payee_name: "Interest",
          imported_payee: "INTEREST",
          imported_id: "seed-savings-1",
          cleared: true
        }
      ]);

      await actual.addTransactions(reserveId, [
        {
          date: "2026-05-03",
          amount: -87_45,
          payee_name: "Airline Hold",
          imported_payee: "AIRLINE HOLD",
          imported_id: "seed-reserve-1",
          cleared: true
        }
      ]);
    });

    const budgets = await actual.getBudgets();
    const localBudget = budgets.find(budget => budget.name === budgetName);
    if (!localBudget?.id) {
      throw new Error(`Expected ${budgetName} to exist locally`);
    }

    if (!localBudget.cloudFileId) {
      await actual.internal!.send("upload-budget", undefined);
    }

    const syncedBudgets = await actual.getBudgets();
    const remoteBudget = syncedBudgets.find(budget => budget.name === budgetName && budget.groupId);
    if (!remoteBudget?.groupId) {
      throw new Error("Expected a synced Actual budget to be created");
    }

    await actual.downloadBudget(remoteBudget.groupId);
    const accounts = await actual.getAccounts();

    return {
      syncId: remoteBudget.groupId,
      accounts: accounts.map(account => ({
        id: account.id,
        name: account.name
      }))
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
