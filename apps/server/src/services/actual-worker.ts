import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import type * as ActualApi from "@actual-app/api";
import type {
  ActualBankSyncStatus,
  ActualBankSyncSource,
} from "@actual-sync/shared";
import type { APIAccountEntity, APICategoryEntity, APICategoryGroupEntity, APIPayeeEntity } from "@actual-app/api/models";
import { parseJsonObject } from "../lib/json.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { resolveActualCategoryId } from "./category-matching.js";
import { DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS } from "./provider-sync-helpers.js";

type ActualModule = typeof ActualApi;
type ActualImportTransaction = Parameters<ActualModule["importTransactions"]>[1][number];
type ActualModuleWithExternalSync = ActualModule & {
  linkExternalSyncAccount?: (accountId: string, metadata: ActualExternalSyncMetadataInput) => Promise<unknown>;
  getExternalSyncAccount?: (
    accountId: string
  ) => Promise<{
    id: string;
    linked: boolean;
    syncSource: "external" | null;
    providerAccountId: string | null;
    institutionName: string | null;
    institutionExternalId: string | null;
    mask: string | null;
    officialName: string | null;
    balanceCurrent: number | null;
    balanceAvailable: number | null;
    balanceLimit: number | null;
    lastSync: string | null;
    bankSyncStatus?: ActualBankSyncStatus | null;
    prefs: {
      importPending: boolean;
      importNotes: boolean;
      reimportDeleted: boolean;
      importTransactions: boolean;
      updateDates: boolean;
    };
  }>;
  unlinkExternalSyncAccount?: (accountId: string) => Promise<unknown>;
};

type ActualModuleWithAccountApi = ActualModule & {
  updateAccount?: (accountId: string, fields: Record<string, unknown>) => Promise<unknown>;
  unlinkAccount?: (accountId: string) => Promise<unknown>;
  getSyncedPreferences?: () => Promise<Record<string, string | undefined>>;
};
type ActualRuntimeHandle = {
  on?: (name: string, listener: (payload: unknown) => void) => void;
};

type ActualConfig = {
  dataDir: string;
  serverURL: string;
  password: string;
  budgetSyncId: string;
  budgetEncryptionPassword?: string;
  apiLocalEntry?: string;
  apiVersionMatchMode?: "off" | "auto" | "strict";
  syncEventDebug?: boolean;
}

type ImportTransactionInput = {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee?: string;
  notes?: string;
  imported_id: string;
  cleared?: boolean;
  payee?: string;
  category?: string;
  transfer_actual_account_id?: string;
}

type ActualExternalSyncMetadataInput = {
  syncSource: "external";
  providerAccountId: string;
  institutionName: string;
  institutionExternalId?: string | null;
  mask?: string | null;
  officialName?: string | null;
  balanceCurrent?: number | null;
  balanceAvailable?: number | null;
  balanceLimit?: number | null;
  lastSync?: string | null;
  bankSyncStatus?: ActualBankSyncStatus | null;
}

type ActualCapabilities = {
  externalSyncWritebackEnabled: boolean;
  externalSyncMode: "none" | "dedicated-api" | "account-api";
  externalSyncStatusEnabled: boolean;
}

type ReconcileTransactionInput = {
  date: string;
  amount: number;
  payee_name: string;
  imported_payee?: string;
  notes?: string;
  imported_id: string;
  cleared?: boolean;
  category_names?: string[];
  resolved_category_id?: string;
  transfer_actual_account_id?: string;
}

type ActualImportBehaviorOptions = {
  reimportDeleted?: boolean;
  updateDates?: boolean;
}

type PreviewExistingTransaction = {
  id: string;
  date?: string | null;
  imported_id?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  cleared?: boolean | null;
  payee?: string | null;
  payee_name?: string | null;
};

type PreviewImportResult = {
  added: string[];
  updated: string[];
  errors: Array<{ message: string }>;
  updatedPreview: Array<{
    transaction: {
      imported_id?: string | null;
    };
    existing?: PreviewExistingTransaction | false;
    ignored?: boolean;
    tombstone?: boolean;
  }>;
};

const MIN_SYNC_INTERVAL_MS = 3_000;
const require = createRequire(import.meta.url);

type WorkerCommand =
  | {
      id: string;
      operation: "listAccounts";
    }
  | {
      id: string;
      operation: "listCategories";
    }
  | {
      id: string;
      operation: "listBankSyncLinks";
    }
  | {
      id: string;
      operation: "getCapabilities";
    }
  | {
      id: string;
      operation: "getAccountBalance";
      accountId: string;
      cutoff?: string;
    }
  | {
      id: string;
      operation: "getExternalSyncAccount";
      accountId: string;
    }
  | {
      id: string;
      operation: "linkExternalSyncAccount";
      accountId: string;
      metadata: ActualExternalSyncMetadataInput;
    }
  | {
      id: string;
      operation: "unlinkExternalSyncAccount";
      accountId: string;
    }
  | {
      id: string;
      operation: "updateExternalSyncAccountStatus";
      accountId: string;
      status: ActualBankSyncStatus;
      lastSync?: string | null;
    }
  | {
      id: string;
      operation: "listTransactionsByDateRange";
      accountId: string;
      startDate: string;
      endDate: string;
    }
  | {
      id: string;
      operation: "importTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
      options?: ActualImportBehaviorOptions;
    }
  | {
      id: string;
      operation: "previewImportTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
      options?: ActualImportBehaviorOptions;
    }
  | {
      id: string;
      operation: "reconcileTransactions";
      accountId: string;
      transactions: ReconcileTransactionInput[];
      removedImportedIds: string[];
      removedActualTransactionIds: string[];
      options?: ActualImportBehaviorOptions;
    };

type WorkerResponse =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: {
        message: string;
        stack?: string;
      };
    };

function integerToAmount(value: number | null | undefined) {
  if (typeof value !== "number") {
    return null;
  }

  return value / 100;
}

function amountToInteger(value: number) {
  return Math.round(value * 100);
}

function isActualCategory(entity: APICategoryEntity | APICategoryGroupEntity): entity is APICategoryEntity {
  return "group_id" in entity;
}

function isActualBankSyncSource(value: string | null | undefined): value is ActualBankSyncSource {
  return value === "simpleFin" || value === "goCardless" || value === "pluggyai" || value === "external";
}

function isActualBankSyncStatus(value: string | null | undefined): value is ActualBankSyncStatus {
  return (
    value === "ok" ||
    value === "pending" ||
    value === "sync-requested" ||
    value === "reauth-required" ||
    value === "attention-required"
  );
}

function parseBooleanPreference(value: string | undefined, fallback: boolean) {
  if (value == null) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

async function getActualExternalSyncPrefs(actual: ActualModule, accountId: string) {
  const api = actual as ActualModuleWithAccountApi;
  if (typeof api.getSyncedPreferences !== "function") {
    return DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS;
  }

  const prefs = await api.getSyncedPreferences();
  return {
    importPending: parseBooleanPreference(prefs[`sync-import-pending-${accountId}`], true),
    importNotes: parseBooleanPreference(prefs[`sync-import-notes-${accountId}`], true),
    reimportDeleted: parseBooleanPreference(prefs[`sync-reimport-deleted-${accountId}`], true),
    importTransactions: parseBooleanPreference(prefs[`sync-import-transactions-${accountId}`], true),
    updateDates: parseBooleanPreference(prefs[`sync-update-dates-${accountId}`], false)
  };
}

function getAlternateWritebackInstitutionId(metadata: ActualExternalSyncMetadataInput) {
  if (metadata.institutionExternalId?.trim()) {
    return metadata.institutionExternalId.trim();
  }

  const normalizedInstitutionName = metadata.institutionName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `external:${normalizedInstitutionName || metadata.providerAccountId}`;
}

function getExternalSyncInfoFromAccount(
  account: APIAccountEntity,
  prefs = DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS
) {
  const accountWithSync = account as APIAccountEntity & {
    account_id?: string | null;
    bankName?: string | null;
    bankId?: string | null;
    bank_name?: string | null;
    bank_id?: string | null;
    mask?: string | null;
    official_name?: string | null;
    balance_current?: number | null;
    balance_available?: number | null;
    balance_limit?: number | null;
    account_sync_source?: string | null;
    last_sync?: string | null;
    bank_sync_status?: string | null;
  };
  const syncSource = accountWithSync.account_sync_source === "external" ? "external" : null;
  const bankSyncStatus = isActualBankSyncStatus(accountWithSync.bank_sync_status)
    ? accountWithSync.bank_sync_status
    : null;

  return {
    id: account.id,
    linked: syncSource === "external" && Boolean(accountWithSync.account_id),
    syncSource,
    providerAccountId: accountWithSync.account_id ?? null,
    institutionName: accountWithSync.bankName ?? accountWithSync.bank_name ?? null,
    institutionExternalId: accountWithSync.bankId ?? accountWithSync.bank_id ?? null,
    mask: accountWithSync.mask ?? null,
    officialName: accountWithSync.official_name ?? null,
    balanceCurrent: accountWithSync.balance_current ?? null,
    balanceAvailable: accountWithSync.balance_available ?? null,
    balanceLimit: accountWithSync.balance_limit ?? null,
    lastSync: accountWithSync.last_sync ?? null,
    bankSyncStatus,
    prefs
  };
}

function collectDateUpdates({
  updatedPreview,
  transactions,
  updateDates
}: {
  updatedPreview: PreviewImportResult["updatedPreview"];
  transactions: Array<{
    date: string;
  }>;
  updateDates: boolean;
}) {
  if (!updateDates) {
    return [];
  }

  return updatedPreview.flatMap((preview, index) => {
    const existing = preview.existing;
    if (!existing || preview.ignored || preview.tombstone || !existing.id) {
      return [];
    }

    const transaction = transactions[index];
    if (!transaction?.date || existing.date === transaction.date) {
      return [];
    }

    return [
      {
        id: existing.id,
        date: transaction.date
      }
    ];
  });
}

function buildTransferPayeeByAccountId(
  payees: APIPayeeEntity[]
): Map<string, { id: string; name?: string | null }> {
  return new Map(
    payees
      .filter((payee: APIPayeeEntity) => Boolean(payee.transfer_acct))
      .map(payee => [
        payee.transfer_acct as string,
        {
          id: payee.id,
          name: payee.name
        }
      ])
  );
}

function toActualImportTransaction(
  accountId: string,
  transaction: ImportTransactionInput
): ActualImportTransaction {
  return stripUndefined({
    account: accountId,
    date: transaction.date,
    amount: amountToInteger(transaction.amount),
    payee: transaction.payee,
    payee_name: transaction.payee_name,
    imported_payee: transaction.imported_payee,
    notes: transaction.notes,
    imported_id: transaction.imported_id,
    cleared: transaction.cleared ?? true,
    category: transaction.category
  });
}

function buildActualImportPayload(accountId: string, transactions: ImportTransactionInput[]) {
  return transactions.map(transaction => toActualImportTransaction(accountId, transaction));
}

function getActualCapabilities(actual: ActualModule): ActualCapabilities {
  const api = actual as ActualModuleWithExternalSync;
  const accountApi = actual as ActualModuleWithAccountApi;
  const linkExternalSyncAccount = (api as Record<string, unknown>).linkExternalSyncAccount;
  const getExternalSyncAccount = (api as Record<string, unknown>).getExternalSyncAccount;
  const unlinkExternalSyncAccount = (api as Record<string, unknown>).unlinkExternalSyncAccount;
  const updateAccount = (accountApi as Record<string, unknown>).updateAccount;
  const unlinkAccount = (accountApi as Record<string, unknown>).unlinkAccount;
  const getSyncedPreferences = (accountApi as Record<string, unknown>).getSyncedPreferences;

  const dedicatedApiEnabled =
    typeof linkExternalSyncAccount === "function" &&
    typeof getExternalSyncAccount === "function" &&
    typeof unlinkExternalSyncAccount === "function";
  const accountApiEnabled =
    typeof updateAccount === "function" &&
    typeof unlinkAccount === "function" &&
    typeof getSyncedPreferences === "function";

  return {
    externalSyncWritebackEnabled: dedicatedApiEnabled || accountApiEnabled,
    externalSyncMode: dedicatedApiEnabled ? "dedicated-api" : accountApiEnabled ? "account-api" : "none",
    externalSyncStatusEnabled: accountApiEnabled
  };
}

function getActualExternalSyncWritebackApi(actual: ActualModule) {
  const api = actual as ActualModuleWithExternalSync;
  const accountApi = actual as ActualModuleWithAccountApi;

  if (api.linkExternalSyncAccount && api.unlinkExternalSyncAccount) {
    return {
      async linkExternalSyncAccount(accountId: string, metadata: ActualExternalSyncMetadataInput) {
        await api.linkExternalSyncAccount!(accountId, metadata);
      },
      async unlinkExternalSyncAccount(accountId: string) {
        await api.unlinkExternalSyncAccount!(accountId);
      },
      async updateExternalSyncAccountStatus(_accountId: string, _status: ActualBankSyncStatus, _lastSync?: string | null) {
        throw new Error("Installed Actual API runtime does not expose external sync status updates.");
      }
    };
  }

  if (accountApi.updateAccount && accountApi.unlinkAccount) {
    return {
      async linkExternalSyncAccount(accountId: string, metadata: ActualExternalSyncMetadataInput) {
        await accountApi.updateAccount!(accountId, {
          account_sync_source: "external",
          account_id: metadata.providerAccountId,
          bank_id: getAlternateWritebackInstitutionId(metadata),
          bank_name: metadata.institutionName,
          mask: metadata.mask ?? null,
          official_name: metadata.officialName ?? null,
          balance_current:
            typeof metadata.balanceCurrent === "number" ? metadata.balanceCurrent : null,
          balance_available:
            typeof metadata.balanceAvailable === "number" ? metadata.balanceAvailable : null,
          balance_limit:
            typeof metadata.balanceLimit === "number" ? metadata.balanceLimit : null,
          last_sync: metadata.lastSync ?? null,
          bank_sync_status: metadata.bankSyncStatus ?? null
        });
      },
      async unlinkExternalSyncAccount(accountId: string) {
        await accountApi.unlinkAccount!(accountId);
      },
      async updateExternalSyncAccountStatus(accountId: string, status: ActualBankSyncStatus, lastSync?: string | null) {
        await accountApi.updateAccount!(accountId, {
          bank_sync_status: status,
          ...(status === "ok" && lastSync !== undefined ? { last_sync: lastSync } : {})
        });
      }
    };
  }

  throw new Error("Installed Actual API runtime does not expose a supported external sync account API.");
}

async function fetchActualServerVersion(serverURL: string) {
  const response = await fetch(new URL("info", serverURL.endsWith("/") ? serverURL : `${serverURL}/`));
  if (!response.ok) {
    throw new Error(`Failed to fetch Actual server version: ${response.status}`);
  }

  const payload = (await response.json()) as { build?: { version?: string } };
  return payload.build?.version;
}

async function installActualApiVersion(targetDir: string, version: string) {
  await fs.mkdir(targetDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", [
      "install",
      "--no-save",
      "--prefix",
      targetDir,
      `@actual-app/api@${version}`
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr?.on("data", chunk => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
    });

    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `npm install exited with code ${code ?? "null"}`));
    });
  });
}

async function readActualPackageVersionFromEntry(entryPath: string) {
  let currentDir = path.dirname(entryPath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    try {
      const parsedPackageJson = parseJsonObject(await fs.readFile(packageJsonPath, "utf8"));
      const packageJson = (parsedPackageJson ?? {}) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === "@actual-app/api" && packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // continue walking upward
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error(`Could not resolve @actual-app/api package version from ${entryPath}`);
}

async function loadActualModule(config: ActualConfig): Promise<ActualModule> {
  if (config.apiLocalEntry) {
    return import(pathToFileURL(config.apiLocalEntry).href) as Promise<ActualModule>;
  }

  const bundledActual = await import("@actual-app/api");
  const bundledEntryPath = require.resolve("@actual-app/api");
  const bundledVersion = await readActualPackageVersionFromEntry(bundledEntryPath);
  const versionMatchMode = config.apiVersionMatchMode || "off";

  if (versionMatchMode === "off") {
    return bundledActual;
  }

  let serverVersion: string | undefined;
  try {
    serverVersion = await fetchActualServerVersion(config.serverURL);
  } catch (error) {
    if (versionMatchMode === "strict") {
      throw error;
    }
    return bundledActual;
  }

  if (!serverVersion || serverVersion === bundledVersion) {
    return bundledActual;
  }

  const installDir = path.join(config.dataDir, "api-version-cache", serverVersion);
  const installedEntryPath = path.join(installDir, "node_modules", "@actual-app", "api", "dist", "index.js");

  try {
    await fs.access(installedEntryPath);
  } catch {
    try {
      await installActualApiVersion(installDir, serverVersion);
    } catch (error) {
      if (versionMatchMode === "strict") {
        throw error;
      }
      return bundledActual;
    }
  }

  try {
    return await (import(pathToFileURL(installedEntryPath).href) as Promise<ActualModule>);
  } catch (error) {
    if (versionMatchMode === "strict") {
      throw error;
    }
    return bundledActual;
  }
}

async function initializeActual(config: ActualConfig) {
  const actual = await loadActualModule(config);
  await fs.mkdir(config.dataDir, { recursive: true });
  const sessionDir = path.join(config.dataDir, "session");
  await fs.mkdir(sessionDir, { recursive: true });
  process.env.ACTUAL_DATA_DIR = sessionDir;

  const runtime = (await actual.init({
    dataDir: sessionDir,
    serverURL: config.serverURL,
    password: config.password
  })) as ActualRuntimeHandle | undefined;

  if (config.budgetEncryptionPassword) {
    await actual.downloadBudget(config.budgetSyncId, {
      password: config.budgetEncryptionPassword
    });
  } else {
    await actual.downloadBudget(config.budgetSyncId);
  }
  await actual.sync();

  return {
    actual,
    runtime
  };
}

function toResponseError(error: unknown) {
  if (error instanceof Error) {
    return stripUndefined({
      message: error.message,
      stack: error.stack
    });
  }

  return {
    message: String(error)
  };
}

function logSyncEventDebug(enabled: boolean | undefined, message: string, payload?: unknown) {
  if (!enabled) {
    return;
  }

  if (payload === undefined) {
    console.info(`[actual-sync] ${message}`);
    return;
  }

  console.info(
    `[actual-sync] ${message}: ${inspect(payload, {
      depth: 6,
      breakLength: 160,
      compact: true
    })}`,
  );
}

function extractAccountIdsFromSyncEvent(payload: unknown) {
  const event = payload as {
    data?: unknown;
    prevData?: unknown;
  };
  const accountIds = new Set<string>();

  const collectFromTablesMap = (tablesMap: unknown) => {
    if (!(tablesMap instanceof Map)) {
      return;
    }

    const accountsTable = tablesMap.get("accounts");
    if (!(accountsTable instanceof Map)) {
      return;
    }

    for (const accountId of accountsTable.keys()) {
      if (typeof accountId === "string" && accountId.length > 0) {
        accountIds.add(accountId);
      }
    }
  };

  collectFromTablesMap(event.data);
  collectFromTablesMap(event.prevData);

  return [...accountIds];
}

async function main() {
  const rawConfig = process.argv[2];
  if (!rawConfig) {
    throw new Error("Missing Actual worker config");
  }

  const parsedConfig = parseJsonObject(rawConfig);
  if (!parsedConfig) {
    throw new Error("Invalid Actual worker config");
  }

  const config = parsedConfig as ActualConfig;
  const { actual, runtime } = await initializeActual(config);
  let lastSyncedAt = Date.now();

  let queue = Promise.resolve();

  logSyncEventDebug(config.syncEventDebug, "Actual runtime sync hook status", {
    runtimeHandlePresent: Boolean(runtime),
    runtimeOnPresent: typeof runtime?.on === "function"
  });

  runtime?.on?.("sync", payload => {
    const event = payload as {
      type?: string;
      tables?: string[];
    };

    logSyncEventDebug(config.syncEventDebug, "Actual runtime sync event received", payload);

    if (event.type !== "success" && event.type !== "applied") {
      logSyncEventDebug(config.syncEventDebug, "Ignoring sync event because type is not success/applied", {
        type: event.type
      });
      return;
    }

    if (!Array.isArray(event.tables) || !event.tables.includes("accounts")) {
      logSyncEventDebug(config.syncEventDebug, "Ignoring sync event because accounts table was not included", {
        tables: event.tables
      });
      return;
    }

    logSyncEventDebug(config.syncEventDebug, "Forwarding Actual sync event wakeup for accounts table");
    process.send?.({
      type: "actual-sync-accounts-changed",
      accountIds: extractAccountIdsFromSyncEvent(payload)
    });
  });

  async function shutdown() {
    await actual.sync().catch(() => undefined);
    await actual.shutdown().catch(() => undefined);
  }

  async function syncIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now - lastSyncedAt < MIN_SYNC_INTERVAL_MS) {
      return;
    }

    await actual.sync();
    lastSyncedAt = Date.now();
  }

  async function handleCommand(command: WorkerCommand): Promise<WorkerResponse> {
    try {
      switch (command.operation) {
        case "listAccounts": {
          await syncIfNeeded();
          const accounts = await actual.getAccounts();
          return {
            id: command.id,
            ok: true,
            result: accounts.map((account: APIAccountEntity) => ({
              id: account.id,
              name: account.name,
              balance: integerToAmount(account.balance_current) ?? 0,
              offbudget: account.offbudget,
              closed: account.closed
            }))
          };
        }

        case "listCategories": {
          await syncIfNeeded();
          const categories = await actual.getCategories();
          return {
            id: command.id,
            ok: true,
            result: categories
              .filter(isActualCategory)
              .filter(category => !category.hidden)
              .map(category => ({
                id: category.id,
                name: category.name
              }))
              .sort((left, right) => left.name.localeCompare(right.name))
          };
        }

        case "listBankSyncLinks": {
          await syncIfNeeded();
          const publicAccounts = await actual.getAccounts();
          const accountLinks = await (async () => {
            const externalSyncApi = (actual as ActualModuleWithExternalSync).getExternalSyncAccount;
            if (typeof externalSyncApi === "function") {
              return Promise.all(
                publicAccounts.map(async account => ({
                  account,
                  externalSync: await externalSyncApi(account.id)
                }))
              );
            }

            return Promise.all(
              publicAccounts.map(async account => ({
                account,
                externalSync: getExternalSyncInfoFromAccount(
                  account,
                  await getActualExternalSyncPrefs(actual, account.id)
                )
              }))
            );
          })();

          return {
            id: command.id,
            ok: true,
            result: accountLinks
              .filter(({ externalSync }) => externalSync.linked && isActualBankSyncSource(externalSync.syncSource))
              .map(({ account, externalSync }) => {
                return {
                  actualAccountId: account.id,
                  actualAccountName: account.name,
                  actualOfficialName: externalSync.officialName ?? null,
                  accountSyncSource: externalSync.syncSource as ActualBankSyncSource,
                  externalAccountId: externalSync.providerAccountId as string,
                  actualBankId: null,
                  actualBankName: externalSync.institutionName ?? null,
                  actualBankExternalId: externalSync.institutionExternalId ?? null,
                  mask: externalSync.mask ?? null,
                  balanceCurrent: integerToAmount(externalSync.balanceCurrent),
                  balanceAvailable: integerToAmount(externalSync.balanceAvailable),
                  balanceLimit: integerToAmount(externalSync.balanceLimit),
                  closed: Boolean(account.closed),
                  offbudget: Boolean(account.offbudget),
                  lastSyncedAt: externalSync.lastSync ?? null,
                  bankSyncStatus: externalSync.bankSyncStatus ?? null
                };
              })
          };
        }

        case "getCapabilities": {
          return {
            id: command.id,
            ok: true,
            result: getActualCapabilities(actual)
          };
        }

        case "getAccountBalance": {
          await syncIfNeeded();
          const cutoff = command.cutoff ? new Date(command.cutoff) : undefined;
          const balance = await actual.getAccountBalance(command.accountId, cutoff);
          return {
            id: command.id,
            ok: true,
            result: integerToAmount(balance) ?? 0
          };
        }

        case "getExternalSyncAccount": {
          await syncIfNeeded();
          const externalSyncApi = (actual as ActualModuleWithExternalSync).getExternalSyncAccount;
          const externalSync = typeof externalSyncApi === "function"
            ? await externalSyncApi(command.accountId)
            : await actual.getAccounts().then(accounts => {
                const found = accounts.find(entry => entry.id === command.accountId);
                if (!found) {
                  throw new Error(`Actual account not found: ${command.accountId}`);
                }
                return getActualExternalSyncPrefs(actual, command.accountId).then(prefs =>
                  getExternalSyncInfoFromAccount(found, prefs)
                );
              });
          return {
            id: command.id,
            ok: true,
            result: externalSync
          };
        }

        case "linkExternalSyncAccount": {
          await syncIfNeeded();
          await getActualExternalSyncWritebackApi(actual).linkExternalSyncAccount!(command.accountId, {
            syncSource: "external",
            providerAccountId: command.metadata.providerAccountId,
            institutionName: command.metadata.institutionName,
            institutionExternalId: command.metadata.institutionExternalId ?? null,
            mask: command.metadata.mask ?? null,
            officialName: command.metadata.officialName ?? null,
            balanceCurrent:
              typeof command.metadata.balanceCurrent === "number" ? command.metadata.balanceCurrent : null,
            balanceAvailable:
              typeof command.metadata.balanceAvailable === "number" ? command.metadata.balanceAvailable : null,
            balanceLimit:
              typeof command.metadata.balanceLimit === "number" ? command.metadata.balanceLimit : null,
            lastSync: command.metadata.lastSync ?? null,
            bankSyncStatus: command.metadata.bankSyncStatus ?? null
          });
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: undefined
          };
        }

        case "unlinkExternalSyncAccount": {
          await syncIfNeeded();
          await getActualExternalSyncWritebackApi(actual).unlinkExternalSyncAccount!(command.accountId);
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: undefined
          };
        }

        case "updateExternalSyncAccountStatus": {
          await syncIfNeeded();
          await getActualExternalSyncWritebackApi(actual).updateExternalSyncAccountStatus(
            command.accountId,
            command.status,
            command.lastSync
          );
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: undefined
          };
        }

        case "listTransactionsByDateRange": {
          await syncIfNeeded();
          const matching = await actual.getTransactions(command.accountId, command.startDate, command.endDate);

          return {
            id: command.id,
            ok: true,
            result: matching.map(transaction => ({
              id: transaction.id,
              date: transaction.date,
              amount: integerToAmount(transaction.amount),
              imported_id: transaction.imported_id ?? null,
              category: transaction.category ?? null,
              payee_name: null,
              imported_payee: transaction.imported_payee,
              notes: transaction.notes,
              cleared: transaction.cleared
            }))
          };
        }

        case "importTransactions": {
          const transferPayeeByAccountId = buildTransferPayeeByAccountId(await actual.getPayees());
          const payload = buildActualImportPayload(
            command.accountId,
            command.transactions.map(transaction => ({
              ...transaction,
              ...stripUndefined({
                payee:
                  transaction.transfer_actual_account_id
                    ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)?.id
                    : transaction.payee
              })
            }))
          );

          const result = await actual.importTransactions(command.accountId, payload, stripUndefined({
            defaultCleared: true,
            reimportDeleted: command.options?.reimportDeleted
          }));
          if (command.options?.updateDates && payload.length > 0 && result.updated.length > 0) {
            const previewResult = (await actual.importTransactions(command.accountId, payload, stripUndefined({
              defaultCleared: true,
              dryRun: true,
              reimportDeleted: command.options?.reimportDeleted
            }))) as PreviewImportResult;
            const dateUpdates = collectDateUpdates({
              updatedPreview: previewResult.updatedPreview,
              transactions: command.transactions,
              updateDates: true
            });

            for (const update of dateUpdates) {
              await actual.updateTransaction(update.id, {
                date: update.date
              });
            }
          }
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result
          };
        }

        case "previewImportTransactions": {
          await syncIfNeeded();
          const transferPayeeByAccountId = buildTransferPayeeByAccountId(await actual.getPayees());
          const payload = buildActualImportPayload(
            command.accountId,
            command.transactions.map(transaction => ({
              ...transaction,
              ...stripUndefined({
                payee:
                  transaction.transfer_actual_account_id
                    ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)?.id
                    : transaction.payee
              })
            }))
          );

          const result = await actual.importTransactions(command.accountId, payload, stripUndefined({
            defaultCleared: true,
            dryRun: true,
            reimportDeleted: command.options?.reimportDeleted
          }));

          return {
            id: command.id,
            ok: true,
            result
          };
        }

        case "reconcileTransactions": {
          await syncIfNeeded();

          const categories = (await actual.getCategories()).filter(isActualCategory);
          const actualCategories = categories.map(category => ({
            id: category.id,
            name: category.name
          }));
          const transferPayeeByAccountId = buildTransferPayeeByAccountId(await actual.getPayees());
          let removed = 0;
          let renamedPayees = 0;
          const resolvedTransactions = command.transactions.map(transaction => {
            const resolvedCategoryId = transaction.resolved_category_id || resolveActualCategoryId(
              stripUndefined({
                categoryNames: transaction.category_names,
                actualCategories
              })
            );
            const resolvedTransferPayee = transaction.transfer_actual_account_id
              ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)
              : undefined;

            return stripUndefined({
              date: transaction.date,
              amount: transaction.amount,
              payee: resolvedTransferPayee?.id,
              payee_name: transaction.payee_name,
              imported_payee: transaction.imported_payee,
              notes: transaction.notes,
              imported_id: transaction.imported_id,
              cleared: transaction.cleared,
              category: resolvedCategoryId
            }) satisfies ImportTransactionInput;
          });
          const importPayload = buildActualImportPayload(command.accountId, resolvedTransactions);

          for (const existingId of command.removedActualTransactionIds) {
            if (!existingId) {
              continue;
            }

            await actual.deleteTransaction(existingId);
            removed += 1;
          }

          let previewResult: PreviewImportResult = {
            added: [],
            updated: [],
            errors: [],
            updatedPreview: []
          };
          if (resolvedTransactions.length > 0) {
            previewResult = (await actual.importTransactions(command.accountId, importPayload, stripUndefined({
              defaultCleared: true,
              dryRun: true,
              reimportDeleted: command.options?.reimportDeleted
            }))) as PreviewImportResult;

            if (previewResult.errors.length > 0) {
              throw new Error(previewResult.errors[0]?.message || "Actual reconcile preview failed");
            }

            const importResult = await actual.importTransactions(command.accountId, importPayload, stripUndefined({
              defaultCleared: true,
              reimportDeleted: command.options?.reimportDeleted
            }));

            if (importResult.errors.length > 0) {
              throw new Error(importResult.errors[0]?.message || "Actual reconcile import failed");
            }

            const renamedPayeeUpdates = new Map<string, string>();
            previewResult.updatedPreview.forEach((preview, index) => {
              const existing = preview.existing || null;
              const transaction = command.transactions[index];
              if (!existing || !transaction || preview.ignored) {
                return;
              }

              if (
                existing.payee &&
                existing.payee_name &&
                transaction.payee_name &&
                transaction.imported_payee &&
                existing.imported_payee === existing.payee_name &&
                transaction.payee_name !== transaction.imported_payee &&
                !renamedPayeeUpdates.has(existing.payee)
              ) {
                renamedPayeeUpdates.set(existing.payee, transaction.payee_name);
              }
            });

            for (const [payeeId, payeeName] of renamedPayeeUpdates) {
              await actual.updatePayee(payeeId, {
                name: payeeName
              });
              renamedPayees += 1;
            }

            const dateUpdates = collectDateUpdates({
              updatedPreview: previewResult.updatedPreview,
              transactions: command.transactions,
              updateDates: command.options?.updateDates === true
            });

            for (const update of dateUpdates) {
              await actual.updateTransaction(update.id, {
                date: update.date
              });
            }

            await syncIfNeeded(true);

            return {
              id: command.id,
              ok: true,
              result: {
                added: importResult.added.length,
                updated: importResult.updated.length,
                removed,
                renamedPayees,
                addedIds: importResult.added,
                updatedIds: importResult.updated
              }
            };
          }

          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: {
              added: 0,
              updated: 0,
              removed,
              renamedPayees,
              addedIds: [],
              updatedIds: []
            }
          };
        }
      }
    } catch (error) {
      return {
        id: command.id,
        ok: false,
        error: toResponseError(error)
      };
    }
  }

  process.on("message", command => {
    if (!command || typeof command !== "object" || !("id" in command) || !("operation" in command)) {
      return;
    }

    queue = queue
      .then(async () => {
        const response = await handleCommand(command as WorkerCommand);
        process.send?.(response);
      })
      .catch(async error => {
        process.send?.({
          id: (command as WorkerCommand).id,
          ok: false,
          error: toResponseError(error)
        } satisfies WorkerResponse);
      });
  });

  process.on("disconnect", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });

  process.send?.({
    type: "ready"
  });
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
