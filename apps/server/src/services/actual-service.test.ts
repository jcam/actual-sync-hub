import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActualService } from "./actual-service.js";

async function writeFakeActualApiModule({
  rootDir,
  accounts,
  syncedPrefs = {},
  supportsAccountApi = false,
  emitAccountsSyncEventOnInit = false
}: {
  rootDir: string;
  accounts: unknown[];
  syncedPrefs?: Record<string, string>;
  supportsAccountApi?: boolean;
  emitAccountsSyncEventOnInit?: boolean;
}) {
  const modulePath = path.join(rootDir, "fake-actual-api.mjs");
const source = `
const accounts = ${JSON.stringify(accounts, null, 2)};
const syncedPrefs = ${JSON.stringify(syncedPrefs, null, 2)};

export async function downloadBudget() {}
export async function sync() {}
export async function shutdown() {}
let onSync;
${emitAccountsSyncEventOnInit
  ? `
export async function init() {
  return {
    on(name, listener) {
      if (name === "sync") {
        onSync = listener;
        setTimeout(() => {
          onSync?.({ type: "success", tables: ["accounts"] });
        }, 20);
      }
    }
  };
}
`
  : `export async function init() {}`}
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
${supportsAccountApi
  ? `
export async function getSyncedPreferences() {
  return syncedPrefs;
}
export async function updateAccount(id, fields) {
  const account = accounts.find(entry => entry.id === id);
  if (!account) {
    throw new Error(\`Account not found: \${id}\`);
  }
  Object.assign(account, fields);
}
export async function unlinkAccount(id) {
  const account = accounts.find(entry => entry.id === id);
  if (!account) {
    throw new Error(\`Account not found: \${id}\`);
  }
  Object.assign(account, {
    account_id: null,
    bank_id: null,
    bank_name: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null
  });
}
`
  : ""}
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
      externalSyncWritebackEnabled: false,
      externalSyncMode: "none",
      externalSyncStatusEnabled: false
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
        bankSyncStatus: null,
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
      bankSyncStatus: null,
      prefs: {
        importPending: true,
        importNotes: true,
        reimportDeleted: true,
        importTransactions: true,
        updateDates: false
      }
    });
  });

  it("uses the alternate account API surface for external sync writeback and status updates", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-account-api-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      supportsAccountApi: true,
      syncedPrefs: {
        "sync-import-pending-actual-1": "false",
        "sync-import-notes-actual-1": "false",
        "sync-reimport-deleted-actual-1": "true",
        "sync-import-transactions-actual-1": "true",
        "sync-update-dates-actual-1": "true"
      },
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          offbudget: false,
          closed: false,
          balance: 25000,
          account_id: "ext-1",
          bank_id: "platypus-bank",
          bank_name: "First Platypus Bank",
          mask: "1234",
          official_name: "Household Checking",
          balance_current: 50000,
          balance_available: 45000,
          balance_limit: null,
          account_sync_source: "external",
          last_sync: "1715000000000",
          bank_sync_status: "sync-requested"
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
      externalSyncWritebackEnabled: true,
      externalSyncMode: "account-api",
      externalSyncStatusEnabled: true
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
        lastSyncedAt: "1715000000000",
        bankSyncStatus: "sync-requested"
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
      bankSyncStatus: "sync-requested",
      prefs: {
        importPending: false,
        importNotes: false,
        reimportDeleted: true,
        importTransactions: true,
        updateDates: true
      }
    });

    await service.updateExternalSyncAccountStatus?.("actual-1", "pending");
    await expect(service.getExternalSyncAccount?.("actual-1")).resolves.toMatchObject({
      bankSyncStatus: "pending"
    });

    await service.updateExternalSyncAccountStatus?.("actual-1", "ok", "1715500000000");
    await expect(service.getExternalSyncAccount?.("actual-1")).resolves.toMatchObject({
      bankSyncStatus: "ok",
      lastSync: "1715500000000"
    });

    await service.linkExternalSyncAccount("actual-1", {
      syncSource: "external",
      providerAccountId: "ext-2",
      institutionName: "Renamed Credit Union",
      institutionExternalId: null,
      mask: "9876",
      officialName: "Updated Checking",
      balanceCurrent: 22200,
      balanceAvailable: 21000,
      balanceLimit: 50000,
      lastSync: "1716000000000"
    });
    await expect(service.getExternalSyncAccount?.("actual-1")).resolves.toMatchObject({
      providerAccountId: "ext-2",
      institutionName: "Renamed Credit Union",
      institutionExternalId: "external:renamed-credit-union",
      mask: "9876",
      officialName: "Updated Checking",
      balanceCurrent: 22200,
      balanceAvailable: 21000,
      balanceLimit: 50000,
      lastSync: "1716000000000"
    });

    await service.unlinkExternalSyncAccount("actual-1");
    await expect(service.getExternalSyncAccount?.("actual-1")).resolves.toMatchObject({
      linked: false,
      syncSource: null,
      providerAccountId: null,
      institutionName: null,
      institutionExternalId: null,
      bankSyncStatus: null
    });
  });

  it("forwards Actual sync account events from the runtime handle", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-sync-event-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      emitAccountsSyncEventOnInit: true,
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          offbudget: false,
          closed: false,
          balance: 25000
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

    const eventPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Actual sync event"));
      }, 5_000);

      const stop = service.onActualSyncAccountsChanged?.(() => {
        clearTimeout(timeout);
        stop?.();
        resolve();
      });
    });

    await service.listAccounts();
    await expect(eventPromise).resolves.toBeUndefined();
  });
});
