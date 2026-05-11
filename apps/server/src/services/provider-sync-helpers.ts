import type { ActualCategoryDto, CategoryMappingDto } from "@actual-sync/shared";
import { stripUndefined } from "../lib/strip-undefined.js";
import type { ImportTransactionInput, PreviewImportMatchRecord, ReconcileTransactionInput } from "./actual-service.js";
import type { ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { resolveActualCategoryId } from "./category-matching.js";

export type ActualExternalSyncPrefs = {
  importPending: boolean;
  importNotes: boolean;
  reimportDeleted: boolean;
  importTransactions: boolean;
  updateDates: boolean;
}

export const DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS: ActualExternalSyncPrefs = {
  importPending: true,
  importNotes: true,
  reimportDeleted: true,
  importTransactions: true,
  updateDates: false
};

function normalizeMatchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeImportedDescription(description: string | null | undefined, payeeName: string) {
  const trimmed = description?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.localeCompare(payeeName, undefined, { sensitivity: "accent" }) === 0) {
    return null;
  }

  const payeePrefix = new RegExp(`^${escapeRegExp(payeeName)}(?:\\s*[-:*#/\\\\|]+\\s*|\\s+)`, "i");
  const stripped = trimmed.replace(payeePrefix, "").trim();
  return stripped.length > 0 ? stripped : null;
}

export function buildImportedTransactionNotes({
  payeeName,
  description,
  memo
}: {
  payeeName: string;
  description?: string | null;
  memo?: string | null;
}) {
  const descriptionNote = normalizeImportedDescription(description, payeeName);
  const memoNote = memo?.trim() || null;
  const seen = new Set<string>();

  const parts = [descriptionNote, memoNote].flatMap(part => {
    if (!part) {
      return [];
    }

    const key = part.toLowerCase();
    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [part];
  });

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function sanitizeProviderSyncResult(result: ProviderSyncResult): ProviderSyncResult {
  const sanitizedTransactions: ProviderSyncTransaction[] = [];
  const indexByImportedId = new Map<string, number>();

  for (const transaction of result.transactions) {
    const importedId = transaction.importedId.trim();
    const date = transaction.date.trim();
    const payeeName = transaction.payeeName.trim();

    if (!importedId || !date || !payeeName) {
      continue;
    }

    const sanitizedTransaction = stripUndefined({
      ...transaction,
      importedId,
      date,
      payeeName,
      importedPayee: transaction.importedPayee?.trim() || undefined,
      notes: transaction.notes?.trim() || undefined,
      categoryNames: transaction.categoryNames
        ? [...new Set(transaction.categoryNames.map(value => value.trim()).filter(Boolean))]
        : undefined,
      searchText: transaction.searchText
        ? [...new Set(transaction.searchText.map(value => value.trim()).filter(Boolean))]
        : undefined
    }) satisfies ProviderSyncTransaction;

    const existingIndex = indexByImportedId.get(importedId);
    if (existingIndex == null) {
      indexByImportedId.set(importedId, sanitizedTransactions.length);
      sanitizedTransactions.push(sanitizedTransaction);
    } else {
      sanitizedTransactions[existingIndex] = sanitizedTransaction;
    }
  }

  const keptImportedIds = new Set(sanitizedTransactions.map(transaction => transaction.importedId));
  const removedImportedIds = [
    ...new Set(result.removedImportedIds.map(importedId => importedId.trim()).filter(Boolean))
  ].filter(importedId => !keptImportedIds.has(importedId));

  return {
    ...result,
    imported: sanitizedTransactions.length,
    transactions: sanitizedTransactions,
    removedImportedIds
  };
}

export function normalizeActualExternalSyncPrefs(
  prefs: Partial<ActualExternalSyncPrefs> | null | undefined
): ActualExternalSyncPrefs {
  return {
    importPending: prefs?.importPending ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS.importPending,
    importNotes: prefs?.importNotes ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS.importNotes,
    reimportDeleted: prefs?.reimportDeleted ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS.reimportDeleted,
    importTransactions: prefs?.importTransactions ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS.importTransactions,
    updateDates: prefs?.updateDates ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS.updateDates
  };
}

export function applyActualExternalSyncPrefsToProviderSyncResult(
  result: ProviderSyncResult,
  prefs: Partial<ActualExternalSyncPrefs> | null | undefined
): ProviderSyncResult {
  const normalizedPrefs = normalizeActualExternalSyncPrefs(prefs);
  if (!normalizedPrefs.importTransactions) {
    return sanitizeProviderSyncResult({
      ...result,
      imported: 0,
      transactions: [],
      removedImportedIds: []
    });
  }

  const filteredTransactions = result.transactions
    .filter(transaction => normalizedPrefs.importPending || transaction.cleared)
    .map(transaction =>
      stripUndefined({
        ...transaction,
        notes: normalizedPrefs.importNotes ? transaction.notes : undefined
      })
    );

  return sanitizeProviderSyncResult({
    ...result,
    transactions: filteredTransactions
  });
}

export function getPrimarySourceCategory(transaction: ProviderSyncTransaction) {
  return transaction.categoryNames?.find(name => !name.toUpperCase().startsWith("TRANSFER")) || transaction.categoryNames?.[0];
}

export function resolveTransactionCategoryId({
  transaction,
  actualCategories,
  categoryMappings
}: {
  transaction: ProviderSyncTransaction;
  actualCategories: ActualCategoryDto[];
  categoryMappings: CategoryMappingDto[];
}) {
  const explicitMapping = categoryMappings.find(mapping => transaction.categoryNames?.includes(mapping.sourceCategory));
  if (explicitMapping?.actualCategoryId) {
    return explicitMapping.actualCategoryId;
  }

  return resolveActualCategoryId(
    stripUndefined({
      categoryNames: transaction.categoryNames,
      actualCategories
    })
  );
}

export function resolveTransferActualAccountId({
  transaction,
  siblings,
  currentActualAccountId
}: {
  transaction: ProviderSyncTransaction;
  siblings: Array<{
    actualAccountId: string;
    actualAccountName: string;
    connectionAccount?: {
      name: string;
      officialName: string | null;
      mask: string | null;
    } | null;
  }>;
  currentActualAccountId: string;
}) {
  const categoryNames = transaction.categoryNames || [];
  const isTransfer = categoryNames.some(name => name.toUpperCase().startsWith("TRANSFER"));
  if (!isTransfer) {
    return undefined;
  }

  const haystack = [transaction.payeeName, transaction.importedPayee, ...(transaction.searchText || [])]
    .filter((value): value is string => Boolean(value))
    .map(normalizeMatchText)
    .join(" ");

  if (!haystack) {
    return undefined;
  }

  for (const sibling of siblings) {
    if (sibling.actualAccountId === currentActualAccountId) {
      continue;
    }

    const candidates = [
      sibling.actualAccountName,
      sibling.connectionAccount?.name || undefined,
      sibling.connectionAccount?.officialName || undefined,
      sibling.connectionAccount?.mask ? ` ${sibling.connectionAccount.mask} ` : undefined
    ]
      .filter((value): value is string => Boolean(value))
      .map(value => normalizeMatchText(value));

    if (candidates.some(candidate => candidate && haystack.includes(candidate))) {
      return sibling.actualAccountId;
    }
  }

  return undefined;
}

export function toImportTransactionInput(transaction: ReconcileTransactionInput): ImportTransactionInput {
  return stripUndefined({
    date: transaction.date,
    amount: transaction.amount,
    payee_name: transaction.payee_name,
    imported_payee: transaction.imported_payee,
    notes: transaction.notes,
    imported_id: transaction.imported_id,
    cleared: transaction.cleared,
    category: transaction.resolved_category_id,
    transfer_actual_account_id: transaction.transfer_actual_account_id
  });
}

export function mapPreviewItemByImportedId(updatedPreview: PreviewImportMatchRecord[]) {
  return new Map(
    updatedPreview
      .filter(entry => entry.transaction.imported_id)
      .map(entry => [entry.transaction.imported_id as string, entry])
  );
}
