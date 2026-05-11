import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActualService } from "./actual-service.js";

type FakeActualCall = {
  name: string;
  payload?: Record<string, unknown>;
};

async function readFakeCalls(rootDir: string): Promise<FakeActualCall[]> {
  const callsPath = path.join(rootDir, "fake-actual-calls.json");

  try {
    const raw = await fs.readFile(callsPath, "utf8");
    return JSON.parse(raw) as FakeActualCall[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeFakeActualApiModule({
  rootDir,
  accounts,
  syncedPrefs = {},
  supportsAccountApi = false,
  emitAccountsSyncEventOnInit = false,
  categories = [],
  payees = [],
  transactions = [],
  failOnceWithOutOfSyncOnListAccounts = false
}: {
  rootDir: string;
  accounts: unknown[];
  syncedPrefs?: Record<string, string>;
  supportsAccountApi?: boolean;
  emitAccountsSyncEventOnInit?: boolean;
  categories?: unknown[];
  payees?: unknown[];
  transactions?: unknown[];
  failOnceWithOutOfSyncOnListAccounts?: boolean;
}) {
  const modulePath = path.join(rootDir, "fake-actual-api.mjs");
  const source = `
import fs from "node:fs/promises";
import path from "node:path";

const rootDir = ${JSON.stringify(rootDir)};
const callsPath = path.join(rootDir, "fake-actual-calls.json");
const failOnceFlagPath = path.join(rootDir, "out-of-sync-once.flag");
const state = {
  accounts: ${JSON.stringify(accounts, null, 2)},
  categories: ${JSON.stringify(categories, null, 2)},
  payees: ${JSON.stringify(payees, null, 2)},
  syncedPrefs: ${JSON.stringify(syncedPrefs, null, 2)},
  transactions: ${JSON.stringify(transactions, null, 2)}
};
let nextTransactionId = state.transactions.length + 1;
let onSync;

async function appendCall(name, payload = {}) {
  let calls = [];
  try {
    calls = JSON.parse(await fs.readFile(callsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  calls.push({ name, payload });
  await fs.writeFile(callsPath, JSON.stringify(calls, null, 2), "utf8");
}

function buildPreviewExisting(transaction) {
  if (!transaction) {
    return false;
  }

  return {
    id: transaction.id,
    date: transaction.date,
    imported_id: transaction.imported_id ?? null,
    imported_payee: transaction.imported_payee ?? null,
    notes: transaction.notes ?? null,
    cleared: transaction.cleared ?? null,
    payee: transaction.payee ?? null,
    payee_name: transaction.payee_name ?? null
  };
}

export async function downloadBudget() {
  await appendCall("downloadBudget");
}

export async function sync() {
  await appendCall("sync");
}

export async function shutdown() {
  await appendCall("shutdown");
}

export async function init() {
  await appendCall("init");
  ${
    emitAccountsSyncEventOnInit
      ? `return {
  on(name, listener) {
    if (name === "sync") {
      onSync = listener;
      setTimeout(() => {
        onSync?.({ type: "success", tables: ["accounts"] });
      }, 20);
    }
  }
};`
      : "return {};"
  }
}

export async function getAccounts() {
  await appendCall("getAccounts");
  ${
    failOnceWithOutOfSyncOnListAccounts
      ? `const sessionDir = process.env.ACTUAL_DATA_DIR || rootDir;
  const sessionMarkerPath = path.join(sessionDir, "stale-session-marker");

  try {
    await fs.access(failOnceFlagPath);
    try {
      await fs.access(sessionMarkerPath);
      throw new Error("stale session survived reset");
    } catch (error) {
      if (error instanceof Error && error.message === "stale session survived reset") {
        throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }

    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(failOnceFlagPath, "1", "utf8");
    await fs.writeFile(sessionMarkerPath, "stale", "utf8");
    throw new Error("Actual data is out-of-sync");
  }`
      : ""
  }

  return state.accounts;
}

export async function getCategories() {
  await appendCall("getCategories");
  return state.categories;
}

export async function getPayees() {
  await appendCall("getPayees");
  return state.payees;
}

export async function getTransactions(accountId, startDate, endDate) {
  await appendCall("getTransactions", { accountId, startDate, endDate });
  return state.transactions.filter(transaction => {
    return (
      transaction.account === accountId &&
      transaction.date >= startDate &&
      transaction.date <= endDate
    );
  });
}

export async function importTransactions(accountId, payload, options = {}) {
  await appendCall("importTransactions", { accountId, payload, options });

  const updatedPreview = payload.map(transaction => {
    const existing = state.transactions.find(entry => {
      return entry.account === accountId && entry.imported_id === transaction.imported_id;
    });

    return {
      transaction: {
        imported_id: transaction.imported_id ?? null,
        date: transaction.date,
        amount: transaction.amount,
        imported_payee: transaction.imported_payee ?? null,
        notes: transaction.notes ?? null,
        cleared: transaction.cleared ?? null
      },
      existing: buildPreviewExisting(existing)
    };
  });

  if (options.dryRun) {
    return {
      added: updatedPreview.flatMap(entry => (entry.existing ? [] : [entry.transaction.imported_id])),
      updated: updatedPreview.flatMap(entry => (entry.existing?.id ? [entry.existing.id] : [])),
      errors: [],
      updatedPreview
    };
  }

  const added = [];
  const updated = [];

  for (const transaction of payload) {
    const existing = state.transactions.find(entry => {
      return entry.account === accountId && entry.imported_id === transaction.imported_id;
    });

    if (existing) {
      existing.amount = transaction.amount;
      existing.payee = transaction.payee ?? existing.payee ?? null;
      existing.payee_name = transaction.payee_name ?? existing.payee_name ?? null;
      existing.imported_payee = transaction.imported_payee ?? null;
      existing.notes = transaction.notes ?? null;
      existing.cleared = transaction.cleared ?? true;
      existing.category = transaction.category ?? null;
      updated.push(existing.id);
      continue;
    }

    const id = "txn-added-" + nextTransactionId++;
    state.transactions.push({
      id,
      account: accountId,
      date: transaction.date,
      amount: transaction.amount,
      payee: transaction.payee ?? null,
      payee_name: transaction.payee_name ?? null,
      imported_payee: transaction.imported_payee ?? null,
      notes: transaction.notes ?? null,
      imported_id: transaction.imported_id ?? null,
      cleared: transaction.cleared ?? true,
      category: transaction.category ?? null
    });
    added.push(id);
  }

  return {
    added,
    updated,
    errors: []
  };
}

export async function updateTransaction(id, fields) {
  await appendCall("updateTransaction", { id, fields });
  const transaction = state.transactions.find(entry => entry.id === id);
  if (!transaction) {
    throw new Error(\`Transaction not found: \${id}\`);
  }

  Object.assign(transaction, fields);
}

export async function deleteTransaction(id) {
  await appendCall("deleteTransaction", { id });
  const index = state.transactions.findIndex(entry => entry.id === id);
  if (index >= 0) {
    state.transactions.splice(index, 1);
  }
}

export async function updatePayee(id, fields) {
  await appendCall("updatePayee", { id, fields });
  const payee = state.payees.find(entry => entry.id === id);
  if (!payee) {
    throw new Error(\`Payee not found: \${id}\`);
  }

  Object.assign(payee, fields);
}

${supportsAccountApi
  ? `
export async function getSyncedPreferences() {
  await appendCall("getSyncedPreferences");
  return state.syncedPrefs;
}

export async function updateAccount(id, fields) {
  await appendCall("updateAccount", { id, fields });
  const account = state.accounts.find(entry => entry.id === id);
  if (!account) {
    throw new Error(\`Account not found: \${id}\`);
  }

  Object.assign(account, fields);
}

export async function unlinkAccount(id) {
  await appendCall("unlinkAccount", { id });
  const account = state.accounts.find(entry => entry.id === id);
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

function createTestService(rootDir: string, modulePath: string) {
  return createActualService({
    config: {
      dataDir: path.join(rootDir, "service"),
      serverURL: "http://actual.invalid",
      password: "password",
      budgetSyncId: "budget-1",
      apiLocalEntry: modulePath,
      apiVersionMatchMode: "off"
    }
  });
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

    const service = createTestService(rootDir, modulePath);
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

    const service = createTestService(rootDir, modulePath);
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
          balance_current: 25000,
          offbudget: false,
          closed: false,
          balance: 25000
        }
      ]
    });

    const service = createTestService(rootDir, modulePath);
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

  it("returns preview import matches without mutating worker transaction state", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-preview-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          offbudget: false,
          closed: false,
          balance: 25000
        }
      ],
      transactions: [
        {
          id: "txn-existing",
          account: "actual-1",
          date: "2026-05-01",
          amount: -2000,
          imported_id: "match-1",
          imported_payee: "COFFEE SHOP",
          notes: "old note",
          cleared: false,
          category: null
        }
      ]
    });

    const service = createTestService(rootDir, modulePath);
    cleanups.push(() => service.shutdown?.() ?? Promise.resolve());

    await expect(
      service.previewImportTransactions(
        "actual-1",
        [
          {
            date: "2026-05-03",
            amount: -20,
            payee_name: "Coffee Shop",
            imported_payee: "COFFEE SHOP",
            imported_id: "match-1",
            notes: "updated note",
            cleared: true
          }
        ],
        {
          updateDates: true
        }
      )
    ).resolves.toEqual({
      added: [],
      updated: ["txn-existing"],
      errors: [],
      updatedPreview: [
        {
          transaction: {
            imported_id: "match-1",
            date: "2026-05-03",
            amount: -2000,
            imported_payee: "COFFEE SHOP",
            notes: "updated note",
            cleared: true
          },
          existing: {
            id: "txn-existing",
            date: "2026-05-01",
            imported_id: "match-1",
            imported_payee: "COFFEE SHOP",
            notes: "old note",
            cleared: false,
            payee: null,
            payee_name: null
          }
        }
      ]
    });

    await expect(service.listTransactionsByDateRange("actual-1", "2026-05-01", "2026-05-03")).resolves.toEqual([
      {
        id: "txn-existing",
        date: "2026-05-01",
        amount: -20,
        imported_id: "match-1",
        category: null,
        payee_name: null,
        imported_payee: "COFFEE SHOP",
        notes: "old note",
        cleared: false
      }
    ]);

    const importCalls = (await readFakeCalls(rootDir)).filter(call => call.name === "importTransactions");
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0]?.payload?.options).toMatchObject({
      dryRun: true
    });
  });

  it("reconciles worker imports, removals, payee renames, and date updates", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-reconcile-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          offbudget: false,
          closed: false,
          balance: 25000
        }
      ],
      payees: [
        {
          id: "payee-1",
          name: "OLD PAYEE",
          transfer_acct: null
        }
      ],
      transactions: [
        {
          id: "txn-existing",
          account: "actual-1",
          date: "2026-05-01",
          amount: -2000,
          payee: "payee-1",
          payee_name: "OLD PAYEE",
          imported_id: "match-1",
          imported_payee: "OLD PAYEE",
          notes: "old note",
          cleared: false,
          category: null
        },
        {
          id: "txn-delete",
          account: "actual-1",
          date: "2026-05-02",
          amount: -500,
          payee: null,
          payee_name: null,
          imported_id: "delete-1",
          imported_payee: "DELETE ME",
          notes: null,
          cleared: true,
          category: null
        }
      ]
    });

    const service = createTestService(rootDir, modulePath);
    cleanups.push(() => service.shutdown?.() ?? Promise.resolve());

    await expect(
      service.reconcileTransactions(
        "actual-1",
        [
          {
            date: "2026-05-03",
            amount: -20,
            payee_name: "New Merchant",
            imported_payee: "OLD PAYEE",
            imported_id: "match-1",
            notes: "updated note",
            cleared: true,
            resolved_category_id: "cat-food"
          }
        ],
        [],
        ["txn-delete"],
        {
          reimportDeleted: true,
          updateDates: true
        }
      )
    ).resolves.toEqual({
      added: 0,
      updated: 1,
      removed: 1,
      renamedPayees: 1,
      addedIds: [],
      updatedIds: ["txn-existing"]
    });

    await expect(service.listTransactionsByDateRange("actual-1", "2026-05-01", "2026-05-05")).resolves.toEqual([
      {
        id: "txn-existing",
        date: "2026-05-03",
        amount: -20,
        imported_id: "match-1",
        category: "cat-food",
        payee_name: null,
        imported_payee: "OLD PAYEE",
        notes: "updated note",
        cleared: true
      }
    ]);

    const calls = await readFakeCalls(rootDir);
    expect(calls.filter(call => call.name === "deleteTransaction")).toHaveLength(1);
    expect(calls.filter(call => call.name === "importTransactions")).toHaveLength(2);
    expect(calls.find(call => call.name === "updatePayee")?.payload).toEqual({
      id: "payee-1",
      fields: {
        name: "New Merchant"
      }
    });
    expect(calls.find(call => call.name === "updateTransaction")?.payload).toEqual({
      id: "txn-existing",
      fields: {
        date: "2026-05-03"
      }
    });
  });

  it("restarts the worker after an out-of-sync failure and clears the stale session", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "actual-service-retry-"));
    cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));

    const modulePath = await writeFakeActualApiModule({
      rootDir,
      failOnceWithOutOfSyncOnListAccounts: true,
      accounts: [
        {
          id: "actual-1",
          name: "Checking",
          balance_current: 25000,
          offbudget: false,
          closed: false,
          balance: 25000
        }
      ]
    });

    const service = createTestService(rootDir, modulePath);
    cleanups.push(() => service.shutdown?.() ?? Promise.resolve());

    await expect(service.listAccounts()).resolves.toEqual([
      {
        id: "actual-1",
        name: "Checking",
        balance: 250,
        offbudget: false,
        closed: false
      }
    ]);

    const calls = await readFakeCalls(rootDir);
    expect(calls.filter(call => call.name === "init")).toHaveLength(2);
    expect(calls.filter(call => call.name === "getAccounts")).toHaveLength(2);

    await expect(
      fs.access(path.join(rootDir, "service", "session", "stale-session-marker"))
    ).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
