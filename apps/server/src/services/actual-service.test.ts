import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActualService } from "./actual-service.js";

async function writeFakeActualApiModule({
  rootDir,
  accounts
}: {
  rootDir: string;
  accounts: unknown[];
}) {
  const modulePath = path.join(rootDir, "fake-actual-api.mjs");
  const source = `
const accounts = ${JSON.stringify(accounts, null, 2)};

export async function init() {}
export async function downloadBudget() {}
export async function sync() {}
export async function shutdown() {}
export async function getAccounts() {
  return accounts;
}
export async function getCategories() {
  return [];
}
export async function getTransactions() {
  return [];
}
export async function importTransactions() {
  return {
    added: [],
    updated: [],
    errors: []
  };
}
export async function updateTransaction() {}
export async function deleteTransaction() {}
`;

  await fs.writeFile(modulePath, source, "utf8");
  return modulePath;
}

describe.sequential("actual service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("falls back to getAccounts for external sync reads when getExternalSyncAccount is unavailable", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-fallback-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          offbudget: false,
          closed: false,
          balance: 25000,
          account_id: "ext-1",
          bankName: "First Platypus Bank",
          bankId: "platypus-bank",
          mask: "1234",
          official_name: "Household Checking",
          balance_current: 50000,
          balance_available: 45000,
          balance_limit: null,
          account_sync_source: "external",
          last_sync: "1715000000000"
        },
        {
          id: "actual-2",
          name: "Savings",
          offbudget: false,
          closed: false,
          balance: 10000,
          account_id: null,
          account_sync_source: null
        }
      ]
    });

    const service = createActualService({
      config: {
        dataDir: path.join(rootDir, "service"),
        serverURL: "http://actual.invalid",
        password: "password",
        budgetSyncId: "budget-1",
        apiLocalEntry: modulePath,
        apiVersionMatchMode: "off"
      }
    });
    cleanups.push(() => service.shutdown?.() ?? Promise.resolve());

    await expect(service.getCapabilities?.()).resolves.toEqual({
      externalSyncWritebackEnabled: false
    });

    await expect(service.listBankSyncLinks()).resolves.toEqual([
      {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        actualOfficialName: "Household Checking",
        accountSyncSource: "external",
        externalAccountId: "ext-1",
        actualBankId: null,
        actualBankName: "First Platypus Bank",
        actualBankExternalId: "platypus-bank",
        mask: "1234",
        balanceCurrent: 500,
        balanceAvailable: 450,
        balanceLimit: null,
        closed: false,
        offbudget: false,
        lastSyncedAt: "1715000000000"
      }
    ]);

    await expect(service.getExternalSyncAccount?.("actual-1")).resolves.toEqual({
      id: "actual-1",
      linked: true,
      syncSource: "external",
      providerAccountId: "ext-1",
      institutionName: "First Platypus Bank",
      institutionExternalId: "platypus-bank",
      mask: "1234",
      officialName: "Household Checking",
      balanceCurrent: 50000,
      balanceAvailable: 45000,
      balanceLimit: null,
      lastSync: "1715000000000",
      prefs: {
        importPending: true,
        importNotes: true,
        reimportDeleted: true,
        importTransactions: true,
        updateDates: false
      }
    });
  });
});
