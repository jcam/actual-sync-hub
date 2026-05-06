import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as ActualApi from "@actual-app/api";
import type {
  ActualBankSyncSource,
} from "@actual-sync/shared";
import type { APIAccountEntity, APICategoryEntity, APICategoryGroupEntity, APIPayeeEntity } from "@actual-app/api/models";
import { resolveActualCategoryId } from "./category-matching.js";

type ActualModule = typeof ActualApi;
type ActualImportTransaction = Parameters<ActualModule["importTransactions"]>[1][number];
type ActualTransaction = Awaited<ReturnType<ActualModule["getTransactions"]>>[number];
type ActualModuleWithExternalSync = ActualModule & {
  linkExternalSyncAccount?: (accountId: string, metadata: ActualExternalSyncMetadataInput) => Promise<unknown>;
  unlinkExternalSyncAccount?: (accountId: string) => Promise<unknown>;
};

type ActualConfig = {
  dataDir: string;
  serverURL: string;
  password: string;
  budgetSyncId: string;
  budgetEncryptionPassword?: string;
  apiLocalEntry?: string;
  apiVersionMatchMode?: "off" | "auto" | "strict";
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
      operation: "listTransactionsByImportedIds";
      accountId: string;
      importedIds: string[];
    }
  | {
      id: string;
      operation: "importTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
    }
  | {
      id: string;
      operation: "previewImportTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
    }
  | {
      id: string;
      operation: "reconcileTransactions";
      accountId: string;
      transactions: ReconcileTransactionInput[];
      removedImportedIds: string[];
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
    return 0;
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

function tryGetActualInternalApi(actual: ActualModule) {
  const internal = (actual as ActualModule & {
    internal?: {
      send?: (name: string, args?: unknown) => Promise<unknown>;
    };
  }).internal;

  if (!internal?.send) {
    return null;
  }

  return internal;
}

function getActualExternalSyncApi(actual: ActualModule) {
  const api = actual as ActualModuleWithExternalSync;

  if (!api.linkExternalSyncAccount || !api.unlinkExternalSyncAccount) {
    throw new Error("Installed Actual API runtime does not expose external-sync account link methods.");
  }

  return api;
}

function isMissingBanksTableError(error: unknown) {
  return error instanceof Error && error.message.includes('Table "banks" does not exist in the schema');
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
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
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

  await actual.init({
    dataDir: sessionDir,
    serverURL: config.serverURL,
    password: config.password
  });

  if (config.budgetEncryptionPassword) {
    await actual.downloadBudget(config.budgetSyncId, {
      password: config.budgetEncryptionPassword
    });
  } else {
    await actual.downloadBudget(config.budgetSyncId);
  }
  await actual.sync();

  return actual;
}

function toResponseError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

async function main() {
  const rawConfig = process.argv[2];
  if (!rawConfig) {
    throw new Error("Missing Actual worker config");
  }

  const config = JSON.parse(rawConfig) as ActualConfig;
  const actual = await initializeActual(config);
  let lastSyncedAt = Date.now();

  let queue = Promise.resolve();

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
              balance: integerToAmount(account.balance_current),
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
          const internal = tryGetActualInternalApi(actual);
          const publicAccounts = await actual.getAccounts();
          const publicAccountsById = new Map(publicAccounts.map(account => [account.id, account]));
          const accounts = internal
            ? ((await internal.send("accounts-get")) as unknown as Array<{
                id: string;
                name: string;
                official_name?: string | null;
                account_id?: string | null;
                account_sync_source?: string | null;
                last_sync?: string | null;
                closed?: boolean | 0 | 1;
                offbudget?: boolean | 0 | 1;
                tombstone?: boolean | 0 | 1;
                bank?: string | null;
                bankName?: string | null;
                bankId?: string | null;
                mask?: string | null;
                balance_current?: number | null;
                balance_available?: number | null;
                balance_limit?: number | null;
              }>)
            : (
                (await actual.aqlQuery(
                  actual
                    .q("accounts")
                    .select([
                      "id",
                      "name",
                      "official_name",
                      "account_id",
                      "account_sync_source",
                      "last_sync",
                      "closed",
                      "offbudget"
                    ])
                    .withDead() as unknown as Parameters<ActualModule["aqlQuery"]>[0]
                )) as {
                  data: Array<{
                    id: string;
                    name: string;
                    official_name?: string | null;
                    account_id?: string | null;
                    account_sync_source?: string | null;
                    last_sync?: string | null;
                    closed?: boolean | 0 | 1;
                    offbudget?: boolean | 0 | 1;
                    tombstone?: boolean;
                  }>;
                }
              ).data;
          const bankRows = (await (async () => {
            try {
              return (await actual.aqlQuery(
                actual.q("banks").select(["id", "bank_id", "name"]).withDead() as unknown as Parameters<
                  ActualModule["aqlQuery"]
                >[0]
              )) as {
                data: Array<{
                  id: string;
                  bank_id?: string | null;
                  name?: string | null;
                  tombstone?: boolean;
                }>;
              };
            } catch (error) {
              if (isMissingBanksTableError(error)) {
                return {
                  data: []
                };
              }

              throw error;
            }
          })()) as {
            data: Array<{
              id: string;
              bank_id?: string | null;
              name?: string | null;
              tombstone?: boolean;
            }>;
          };
          const bankById = new Map(
            bankRows.data.filter(bank => !bank.tombstone).map(bank => [bank.id, bank])
          );

          return {
            id: command.id,
            ok: true,
            result: accounts
              .filter(account => !account.tombstone)
              .filter(account => Boolean(account.account_id) && isActualBankSyncSource(account.account_sync_source))
              .map(account => {
                const bankId = "bank" in account ? account.bank ?? null : null;
                const bankName = "bankName" in account ? account.bankName ?? null : null;
                const balanceCurrent =
                  "balance_current" in account && typeof account.balance_current === "number"
                    ? account.balance_current
                    : publicAccountsById.get(account.id)?.balance_current ?? null;

                return {
                  actualAccountId: account.id,
                  actualAccountName: account.name,
                  actualOfficialName: account.official_name ?? null,
                  accountSyncSource: account.account_sync_source as ActualBankSyncSource,
                  externalAccountId: account.account_id as string,
                  actualBankId: bankId,
                  actualBankName: bankName ?? (bankId ? bankById.get(bankId)?.name ?? null : null),
                  actualBankExternalId: bankId ? bankById.get(bankId)?.bank_id ?? null : null,
                  mask: "mask" in account ? account.mask ?? null : null,
                  balanceCurrent: integerToAmount(balanceCurrent),
                  balanceAvailable:
                    "balance_available" in account && typeof account.balance_available === "number"
                      ? integerToAmount(account.balance_available)
                      : null,
                  balanceLimit:
                    "balance_limit" in account && typeof account.balance_limit === "number"
                      ? integerToAmount(account.balance_limit)
                      : null,
                  closed: Boolean(account.closed),
                  offbudget: Boolean(account.offbudget),
                  lastSyncedAt: account.last_sync ?? null
                };
              })
          };
        }

        case "linkExternalSyncAccount": {
          await syncIfNeeded();
          await getActualExternalSyncApi(actual).linkExternalSyncAccount!(command.accountId, {
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
            lastSync: command.metadata.lastSync ?? null
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
          await getActualExternalSyncApi(actual).unlinkExternalSyncAccount!(command.accountId);
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: undefined
          };
        }

        case "listTransactionsByImportedIds": {
          await syncIfNeeded();
          if (command.importedIds.length === 0) {
            return {
              id: command.id,
              ok: true,
              result: []
            };
          }

          const query = actual.q("transactions")
            .select(["id", "date", "amount", "category", "payee", "imported_payee", "notes", "cleared", "imported_id"])
            .filter({
              account: command.accountId,
              $or: command.importedIds.map(imported_id => ({ imported_id }))
            })
            .withDead();
          const matching = (await actual.aqlQuery(query as unknown as Parameters<ActualModule["aqlQuery"]>[0])) as {
            data: Array<
              Pick<
                ActualTransaction,
                "id" | "date" | "amount" | "imported_id" | "category" | "imported_payee" | "notes" | "cleared"
              >
            >;
          };

          return {
            id: command.id,
            ok: true,
            result: matching.data.map(transaction => ({
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
          const payees = await actual.getPayees();
          const transferPayeeByAccountId = new Map(
            payees
              .filter((payee: APIPayeeEntity) => Boolean(payee.transfer_acct))
              .map(payee => [
                payee.transfer_acct as string,
                {
                  id: payee.id
                }
              ])
          );
          const payload: ActualImportTransaction[] = command.transactions.map(transaction => ({
            account: command.accountId,
            date: transaction.date,
            amount: amountToInteger(transaction.amount),
            payee:
              transaction.transfer_actual_account_id
                ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)?.id
                : transaction.payee,
            payee_name: transaction.payee_name,
            imported_payee: transaction.imported_payee,
            notes: transaction.notes,
            imported_id: transaction.imported_id,
            cleared: transaction.cleared ?? true,
            category: transaction.category
          }));

          const result = await actual.importTransactions(command.accountId, payload, {
            defaultCleared: true
          });
          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result
          };
        }

        case "previewImportTransactions": {
          await syncIfNeeded();
          const payees = await actual.getPayees();
          const transferPayeeByAccountId = new Map(
            payees
              .filter((payee: APIPayeeEntity) => Boolean(payee.transfer_acct))
              .map(payee => [
                payee.transfer_acct as string,
                {
                  id: payee.id
                }
              ])
          );
          const payload: ActualImportTransaction[] = command.transactions.map(transaction => ({
            account: command.accountId,
            date: transaction.date,
            amount: amountToInteger(transaction.amount),
            payee:
              transaction.transfer_actual_account_id
                ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)?.id
                : transaction.payee,
            payee_name: transaction.payee_name,
            imported_payee: transaction.imported_payee,
            notes: transaction.notes,
            imported_id: transaction.imported_id,
            cleared: transaction.cleared ?? true,
            category: transaction.category
          }));

          const result = await actual.importTransactions(command.accountId, payload, {
            defaultCleared: true,
            dryRun: true
          });

          return {
            id: command.id,
            ok: true,
            result
          };
        }

        case "reconcileTransactions": {
          await syncIfNeeded();

          const importedIds = [
            ...new Set([
              ...command.transactions.map(transaction => transaction.imported_id),
              ...command.removedImportedIds
            ])
          ];
          const existingByImportedId = new Map<
            string,
            Pick<
              ActualTransaction,
              "id" | "imported_id" | "cleared" | "amount" | "payee" | "imported_payee" | "category" | "notes"
            >
          >();

          if (importedIds.length > 0) {
            const importedQuery = actual.q("transactions")
              .select(["id", "imported_id", "cleared", "amount", "payee", "imported_payee", "category", "notes"])
              .filter({
                account: command.accountId,
                $or: importedIds.map(imported_id => ({ imported_id }))
              })
              .withDead();
            const existing = (await actual.aqlQuery(
              importedQuery as unknown as Parameters<ActualModule["aqlQuery"]>[0]
            )) as {
              data: Array<
                Pick<
                  ActualTransaction,
                  "id" | "imported_id" | "cleared" | "amount" | "payee" | "imported_payee" | "category" | "notes"
                >
              >;
            };

            for (const transaction of existing.data) {
              const typedTransaction = transaction;
              if (typedTransaction.imported_id) {
                existingByImportedId.set(typedTransaction.imported_id, typedTransaction);
              }
            }
          }

          const categories = (await actual.getCategories()).filter(isActualCategory);

          const payees = await actual.getPayees();
          const transferPayeeByAccountId = new Map(
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
          const payeeById = new Map(payees.map(payee => [payee.id, payee]));

          let added = 0;
          let updated = 0;
          let removed = 0;
          let renamedPayees = 0;
          const toImport: ImportTransactionInput[] = [];

          for (const importedId of command.removedImportedIds) {
            const existing = existingByImportedId.get(importedId);
            if (!existing) {
              continue;
            }

            await actual.deleteTransaction(existing.id);
            existingByImportedId.delete(importedId);
            removed += 1;
          }

          for (const transaction of command.transactions) {
            const existing = existingByImportedId.get(transaction.imported_id);
            const resolvedCategoryId = transaction.resolved_category_id || resolveActualCategoryId({
              categoryNames: transaction.category_names,
              actualCategories: categories.map(category => ({
                id: category.id,
                name: category.name
              }))
            });
            const resolvedTransferPayee = transaction.transfer_actual_account_id
              ? transferPayeeByAccountId.get(transaction.transfer_actual_account_id)
              : undefined;

            if (!existing) {
              toImport.push({
                date: transaction.date,
                amount: transaction.amount,
                payee: resolvedTransferPayee?.id,
                payee_name: transaction.payee_name,
                imported_payee: transaction.imported_payee,
                notes: transaction.notes,
                imported_id: transaction.imported_id,
                cleared: transaction.cleared,
                category: resolvedCategoryId
              });
              added += 1;
              continue;
            }

            const patch: Partial<ActualTransaction> = {};
            const nextAmount = amountToInteger(transaction.amount);
            if (typeof existing.amount === "number" && existing.amount !== nextAmount) {
              patch.amount = nextAmount;
            }

            if (typeof transaction.cleared === "boolean" && existing.cleared !== transaction.cleared) {
              patch.cleared = transaction.cleared;
            }

            if (resolvedTransferPayee?.id && existing.payee !== resolvedTransferPayee.id) {
              patch.payee = resolvedTransferPayee.id;
            }

            if (!existing.category && resolvedCategoryId) {
              patch.category = resolvedCategoryId;
            }

            if (!existing.notes && transaction.notes) {
              patch.notes = transaction.notes;
            }

            if (Object.keys(patch).length > 0) {
              await actual.updateTransaction(existing.id, patch);
              updated += 1;
            }

            if (existing.payee && transaction.payee_name && transaction.imported_payee) {
              const existingPayee = payeeById.get(existing.payee);
              if (
                existingPayee &&
                existing.imported_payee === existingPayee.name &&
                transaction.payee_name !== existing.imported_payee
              ) {
                await actual.updatePayee(existingPayee.id, {
                  name: transaction.payee_name
                });
                renamedPayees += 1;
              }
            }
          }

          if (toImport.length > 0) {
            await actual.importTransactions(command.accountId, toImport.map(transaction => ({
              account: command.accountId,
              date: transaction.date,
              amount: amountToInteger(transaction.amount),
              payee: transaction.payee,
              payee_name: transaction.payee_name,
              imported_payee: transaction.imported_payee,
              notes: transaction.notes,
              imported_id: transaction.imported_id,
              cleared: transaction.cleared ?? true,
              category: transaction.category
            })), {
              defaultCleared: true
            });
          }

          await syncIfNeeded(true);

          return {
            id: command.id,
            ok: true,
            result: {
              added,
              updated,
              removed,
              renamedPayees
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
