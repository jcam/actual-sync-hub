import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIAccountEntity, APICategoryEntity } from "@actual-app/api/models";
import { env } from "../env.js";

const READ_CACHE_TTL_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const MAX_WORKER_ATTEMPTS = 2;

export interface ActualConfig {
  dataDir: string;
  serverURL: string;
  password: string;
  budgetSyncId: string;
  budgetEncryptionPassword?: string;
  apiVersionMatchMode?: "off" | "auto" | "strict";
}

type ActualModule = typeof import("@actual-app/api");
type ActualImportTransaction = Parameters<ActualModule["importTransactions"]>[1][number];
type ActualTransaction = Awaited<ReturnType<ActualModule["getTransactions"]>>[number];

export type ActualAccountRecord = Pick<APIAccountEntity, "id" | "name" | "offbudget" | "closed"> & {
  balance: number;
};

export type ActualCategoryRecord = Pick<APICategoryEntity, "id" | "name">;

export type ActualTransactionRecord = Pick<
  ActualTransaction,
  "id" | "date" | "imported_id" | "category" | "imported_payee" | "notes" | "cleared"
> & {
  amount: number;
  payee_name?: string | null;
};

export interface ImportTransactionInput {
  date: ActualImportTransaction["date"];
  amount: number;
  payee_name: NonNullable<ActualImportTransaction["payee_name"]>;
  imported_payee?: ActualImportTransaction["imported_payee"];
  notes?: ActualImportTransaction["notes"];
  imported_id: NonNullable<ActualImportTransaction["imported_id"]>;
  cleared?: ActualImportTransaction["cleared"];
  payee?: ActualImportTransaction["payee"];
  category?: ActualImportTransaction["category"];
  transfer_actual_account_id?: string;
}

export interface PreviewImportMatchRecord {
  transaction: {
    imported_id?: string | null;
    date: string;
    amount?: number;
    imported_payee?: string | null;
    notes?: string | null;
    cleared?: boolean | null;
  };
  existing?: {
    id: string;
    date: string;
    amount?: number;
    imported_id?: string | null;
    imported_payee?: string | null;
    notes?: string | null;
    cleared?: boolean | null;
  } | false;
  ignored?: boolean;
  tombstone?: boolean;
}

export interface ReconcileTransactionInput {
  date: ActualImportTransaction["date"];
  amount: number;
  payee_name: string;
  imported_payee?: ActualImportTransaction["imported_payee"];
  notes?: ActualImportTransaction["notes"];
  imported_id: string;
  cleared?: ActualImportTransaction["cleared"];
  category_names?: string[];
  resolved_category_id?: string;
  transfer_actual_account_id?: string;
}

type WorkerReadyMessage = {
  type: "ready";
};

type WorkerCommandPayload =
  | {
      operation: "listAccounts";
    }
  | {
      operation: "listCategories";
    }
  | {
      operation: "listTransactionsByImportedIds";
      accountId: string;
      importedIds: string[];
    }
  | {
      operation: "importTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
    }
  | {
      operation: "previewImportTransactions";
      accountId: string;
      transactions: ImportTransactionInput[];
    }
  | {
      operation: "reconcileTransactions";
      accountId: string;
      transactions: ReconcileTransactionInput[];
      removedImportedIds: string[];
    };

type WorkerCommand = WorkerCommandPayload & {
  id: string;
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

type WorkerHandle = {
  child: ChildProcess;
  call<T>(command: WorkerCommandPayload): Promise<T>;
  stop(): void;
};

let actualAccessQueue = Promise.resolve();

async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  const previous = actualAccessQueue;
  let release!: () => void;
  actualAccessQueue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await work();
  } finally {
    release();
  }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryActualError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("Could not get remote files") || error.message.includes("/account/login") || error.message.includes("429");
}

function toError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export interface ActualService {
  shutdown?(): Promise<void>;
  listAccounts(): Promise<ActualAccountRecord[]>;
  listCategories(): Promise<ActualCategoryRecord[]>;
  listTransactionsByImportedIds(accountId: string, importedIds: string[]): Promise<ActualTransactionRecord[]>;
  importTransactions(accountId: string, transactions: ImportTransactionInput[]): Promise<{
    added: string[];
    updated: string[];
    errors: Array<{ message: string }>;
  }>;
  previewImportTransactions(accountId: string, transactions: ImportTransactionInput[]): Promise<{
    added: string[];
    updated: string[];
    errors: Array<{ message: string }>;
    updatedPreview: PreviewImportMatchRecord[];
  }>;
  reconcileTransactions(accountId: string, transactions: ReconcileTransactionInput[], removedImportedIds?: string[]): Promise<{
    added: number;
    updated: number;
    removed: number;
    renamedPayees: number;
  }>;
}

export function createActualService({
  config = {
    dataDir: path.join(env.ACTUAL_DATA_DIR, "cache"),
    serverURL: env.ACTUAL_SERVER_URL,
    password: env.ACTUAL_SERVER_PASSWORD,
    budgetSyncId: env.ACTUAL_BUDGET_SYNC_ID,
    budgetEncryptionPassword: env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD,
    apiVersionMatchMode: env.actualApiVersionMatchMode
  } satisfies ActualConfig
}: {
  config?: ActualConfig;
} = {}): ActualService {
  let requestCounter = 0;
  let workerPromise: Promise<WorkerHandle> | null = null;
  let workerChild: ChildProcess | null = null;
  let accountsCache: { expiresAt: number; value: ActualAccountRecord[] } | null = null;
  let categoriesCache: { expiresAt: number; value: ActualCategoryRecord[] } | null = null;

  function clearReadCaches() {
    accountsCache = null;
    categoriesCache = null;
  }

  async function resolveWorkerCommand(): Promise<{ command: string; args: string[] }> {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const workerJsPath = path.join(moduleDir, "actual-worker.js");
    const workerTsPath = path.join(moduleDir, "actual-worker.ts");
    const configArg = JSON.stringify(config);

    const canRunBuiltWorker = await fs
      .access(workerJsPath)
      .then(() => true)
      .catch(() => false);

    if (canRunBuiltWorker) {
      return {
        command: process.execPath,
        args: [workerJsPath, configArg]
      };
    }

    return {
      command: process.platform === "win32" ? "tsx.cmd" : "tsx",
      args: [workerTsPath, configArg]
    };
  }

  async function startWorker(): Promise<WorkerHandle> {
    const { command, args } = await resolveWorkerCommand();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    workerChild = child;

    let stderrOutput = "";
    child.stderr?.on("data", chunk => {
      stderrOutput = `${stderrOutput}${chunk.toString()}`.slice(-16_000);
    });

    return await new Promise<WorkerHandle>((resolve, reject) => {
      let settled = false;
      const pending = new Map<
        string,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
        }
      >();

      const failPending = (error: Error) => {
        for (const entry of pending.values()) {
          entry.reject(error);
        }
        pending.clear();
      };

      const resetWorkerReference = () => {
        if (workerChild === child) {
          workerChild = null;
        }
        if (workerPromise) {
          workerPromise = null;
        }
      };

      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const message = stderrOutput.trim() || `Actual worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        const error = new Error(message);
        resetWorkerReference();
        if (!settled) {
          settled = true;
          reject(error);
        }
        failPending(error);
      };

      child.once("error", error => {
        resetWorkerReference();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      child.on("exit", handleExit);

      child.on("message", message => {
        if (!message || typeof message !== "object") {
          return;
        }

        if ((message as WorkerReadyMessage).type === "ready") {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            child,
            call<T>(commandPayload: WorkerCommandPayload) {
              return new Promise<T>((resolveCall, rejectCall) => {
                const id = `actual-${++requestCounter}`;
                pending.set(id, {
                  resolve: resolveCall as (value: unknown) => void,
                  reject: rejectCall
                });

                const command: WorkerCommand = {
                  id,
                  ...commandPayload
                };

                child.send(command);
              });
            },
            stop() {
              child.kill("SIGTERM");
            }
          });
          return;
        }

        const response = message as WorkerResponse;
        const pendingRequest = pending.get(response.id);
        if (!pendingRequest) {
          return;
        }

        pending.delete(response.id);
        if (response.ok) {
          pendingRequest.resolve(response.result);
          return;
        }

        const error = new Error(response.error.message);
        if (response.error.stack) {
          error.stack = response.error.stack;
        }
        pendingRequest.reject(error);
      });
    });
  }

  async function getWorker() {
    if (!workerPromise) {
      workerPromise = startWorker();
    }

    return workerPromise;
  }

  function stopWorker() {
    workerPromise = null;
    workerChild?.kill("SIGTERM");
    workerChild = null;
  }

  async function runWorker<T>(payload: WorkerCommandPayload): Promise<T> {
    return runExclusive(async () => {
      await fs.mkdir(config.dataDir, { recursive: true });

      for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS; attempt += 1) {
        try {
          const worker = await getWorker();
          return await worker.call<T>(payload);
        } catch (error) {
          stopWorker();
          if (attempt === MAX_WORKER_ATTEMPTS || !shouldRetryActualError(error)) {
            throw toError(error);
          }

          await delay(RETRY_DELAY_MS * attempt);
        }
      }

      throw new Error("Actual worker failed without returning an error");
    });
  }

  return {
    async shutdown() {
      clearReadCaches();
      stopWorker();
    },
    async listAccounts(): Promise<ActualAccountRecord[]> {
      if (accountsCache && accountsCache.expiresAt > Date.now()) {
        return accountsCache.value;
      }

      const result = await runWorker<ActualAccountRecord[]>({
        operation: "listAccounts"
      });
      accountsCache = {
        value: result,
        expiresAt: Date.now() + READ_CACHE_TTL_MS
      };
      return result;
    },

    async listCategories(): Promise<ActualCategoryRecord[]> {
      if (categoriesCache && categoriesCache.expiresAt > Date.now()) {
        return categoriesCache.value;
      }

      const result = await runWorker<ActualCategoryRecord[]>({
        operation: "listCategories"
      });
      categoriesCache = {
        value: result,
        expiresAt: Date.now() + READ_CACHE_TTL_MS
      };
      return result;
    },

    async listTransactionsByImportedIds(accountId: string, importedIds: string[]): Promise<ActualTransactionRecord[]> {
      if (importedIds.length === 0) {
        return [];
      }

      return runWorker<ActualTransactionRecord[]>({
        operation: "listTransactionsByImportedIds",
        accountId,
        importedIds
      });
    },

    async importTransactions(accountId: string, transactions: ImportTransactionInput[]) {
      const result = await runWorker<{
        added: string[];
        updated: string[];
        errors: Array<{ message: string }>;
      }>({
        operation: "importTransactions",
        accountId,
        transactions
      });
      clearReadCaches();
      return result;
    },

    async previewImportTransactions(accountId: string, transactions: ImportTransactionInput[]) {
      return runWorker<{
        added: string[];
        updated: string[];
        errors: Array<{ message: string }>;
        updatedPreview: PreviewImportMatchRecord[];
      }>({
        operation: "previewImportTransactions",
        accountId,
        transactions
      });
    },

    async reconcileTransactions(accountId: string, transactions: ReconcileTransactionInput[], removedImportedIds: string[] = []) {
      const result = await runWorker<{
        added: number;
        updated: number;
        removed: number;
        renamedPayees: number;
      }>({
        operation: "reconcileTransactions",
        accountId,
        transactions,
        removedImportedIds
      });
      clearReadCaches();
      return result;
    }
  };
}

export const actualService = createActualService();
