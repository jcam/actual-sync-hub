import fs from "node:fs/promises";
import type * as ActualApi from "@actual-app/api";

async function seedSandboxCategories(actual: typeof ActualApi) {
  const existingGroups = await actual.getCategoryGroups();
  const groupIdByName = new Map(existingGroups.map(group => [group.name, group.id]));

  const getOrCreateGroup = async (name: string, isIncome = false) => {
    const existingId = groupIdByName.get(name);
    if (existingId) {
      return existingId;
    }

    const createdId = await actual.createCategoryGroup({
      name,
      is_income: isIncome,
      hidden: false
    } as never);
    groupIdByName.set(name, createdId);
    return createdId;
  };

  const categories = await actual.getCategories();
  const existingCategoryKeys = new Set(
    categories
      .map(category => {
        const groupId = "group_id" in category ? category.group_id : null;
        return groupId ? `${groupId}:${category.name}` : null;
      })
      .filter((key): key is string => Boolean(key))
  );

  const createCategory = async (groupId: string, name: string, isIncome = false) => {
    const key = `${groupId}:${name}`;
    if (existingCategoryKeys.has(key)) {
      return;
    }

    await actual.createCategory({
      name,
      group_id: groupId,
      is_income: isIncome,
      hidden: false
    } as never);
    existingCategoryKeys.add(key);
  };

  const foodGroup = await getOrCreateGroup("Food");
  await createCategory(foodGroup, "Groceries");
  await createCategory(foodGroup, "Eating Out");
  await createCategory(foodGroup, "Coffee");

  const lifestyleGroup = await getOrCreateGroup("Lifestyle");
  await createCategory(lifestyleGroup, "Entertainment");
  await createCategory(lifestyleGroup, "Shopping");
  await createCategory(lifestyleGroup, "Fitness");
  await createCategory(lifestyleGroup, "Services");
  await createCategory(lifestyleGroup, "Software");

  const transportGroup = await getOrCreateGroup("Transportation");
  await createCategory(transportGroup, "Transportation");
  await createCategory(transportGroup, "Gas");
  await createCategory(transportGroup, "Parking");
  await createCategory(transportGroup, "Travel");

  const homeGroup = await getOrCreateGroup("Home");
  await createCategory(homeGroup, "Utilities");

  const workGroup = await getOrCreateGroup("Work");
  await createCategory(workGroup, "Taxes");

  const incomeGroup = await getOrCreateGroup("Income", true);
  await createCategory(incomeGroup, "Paycheck", true);
  await createCategory(incomeGroup, "Interest", true);
}

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
      await seedSandboxCategories(actual);

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
