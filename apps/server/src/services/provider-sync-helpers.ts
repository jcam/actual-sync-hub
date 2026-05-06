import type { ActualCategoryDto, CategoryMappingDto } from "@actual-sync/shared";
import type { ImportTransactionInput, PreviewImportMatchRecord, ReconcileTransactionInput } from "./actual-service.js";
import type { ProviderSyncTransaction } from "./provider-adapter.js";
import { resolveActualCategoryId } from "./category-matching.js";

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

  return resolveActualCategoryId({
    categoryNames: transaction.categoryNames,
    actualCategories
  });
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
  return {
    date: transaction.date,
    amount: transaction.amount,
    payee_name: transaction.payee_name,
    imported_payee: transaction.imported_payee,
    notes: transaction.notes,
    imported_id: transaction.imported_id,
    cleared: transaction.cleared,
    category: transaction.resolved_category_id,
    transfer_actual_account_id: transaction.transfer_actual_account_id
  };
}

export function mapPreviewItemByImportedId(updatedPreview: PreviewImportMatchRecord[]) {
  return new Map(
    updatedPreview
      .filter(entry => entry.transaction.imported_id)
      .map(entry => [entry.transaction.imported_id as string, entry])
  );
}
