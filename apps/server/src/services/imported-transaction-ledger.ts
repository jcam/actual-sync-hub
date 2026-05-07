import type { ActualCategoryDto, CategoryMappingDto } from "@actual-sync/shared";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { ActualService } from "./actual-service.js";
import type { LinkConfigData } from "./link-config.js";

const CATEGORY_LEARNING_WINDOW_DAYS = 45;
const CATEGORY_LEARNING_MIN_MATCHES = 2;
const IMPORTED_TRANSACTION_RETENTION_DAYS = 180;
const IMPORTED_TRANSACTION_MAX_ROWS_PER_LINK = 2_000;

type ImportedTransactionStore = Pick<PrismaClient, "importedTransaction">;
type ActualTransactionLookup = Pick<ActualService, "listTransactionsByDateRange">;

export async function learnCategoryMappingsFromHistory({
  database,
  actual,
  link,
  linkConfig,
  actualCategories,
  now
}: {
  database: ImportedTransactionStore;
  actual: ActualTransactionLookup;
  link: {
    id: string;
    actualAccountId: string;
  };
  linkConfig: LinkConfigData;
  actualCategories: ActualCategoryDto[];
  now: Date;
}) {
  const recentImportedTransactions = await database.importedTransaction.findMany({
    where: {
      accountLinkId: link.id,
      primarySourceCategory: {
        not: null
      },
      lastSeenAt: {
        gte: new Date(now.getTime() - CATEGORY_LEARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      }
    },
    orderBy: {
      lastSeenAt: "desc"
    },
    take: 250
  });

  if (recentImportedTransactions.length === 0) {
    return linkConfig;
  }

  const datedTransactions = recentImportedTransactions.filter(
    transaction => Boolean(transaction.transactionDate)
  );
  if (datedTransactions.length === 0) {
    return linkConfig;
  }

  const sortedDates = datedTransactions
    .map(transaction => transaction.transactionDate as string)
    .sort((left, right) => left.localeCompare(right));
  const currentTransactions = await actual.listTransactionsByDateRange(
    link.actualAccountId,
    sortedDates[0]!,
    sortedDates[sortedDates.length - 1]!
  );
  const importedIds = new Set(recentImportedTransactions.map(transaction => transaction.importedId));
  const currentCategoryByImportedId = new Map(
    currentTransactions
      .filter(transaction => transaction.imported_id && importedIds.has(transaction.imported_id))
      .map(transaction => [transaction.imported_id as string, transaction.category ?? null])
  );

  const ledgerUpdates = recentImportedTransactions
    .filter(transaction => currentCategoryByImportedId.has(transaction.importedId))
    .filter(transaction => transaction.observedCategoryId !== currentCategoryByImportedId.get(transaction.importedId))
    .map(transaction =>
      database.importedTransaction.update({
        where: {
          id: transaction.id
        },
        data: {
          observedCategoryId: currentCategoryByImportedId.get(transaction.importedId) ?? null
        }
      })
    );
  if (ledgerUpdates.length > 0) {
    await Promise.all(ledgerUpdates);
  }

  const existingMappings = new Map((linkConfig.categoryMappings || []).map(mapping => [mapping.sourceCategory, mapping.actualCategoryId]));
  const evidence = new Map<string, Map<string, number>>();

  for (const transaction of recentImportedTransactions) {
    const sourceCategory = transaction.primarySourceCategory;
    if (!sourceCategory || existingMappings.has(sourceCategory)) {
      continue;
    }

    const currentCategoryId = currentCategoryByImportedId.get(transaction.importedId);
    if (!currentCategoryId || currentCategoryId === transaction.appliedCategoryId) {
      continue;
    }

    const categoryCounts = evidence.get(sourceCategory) || new Map<string, number>();
    categoryCounts.set(currentCategoryId, (categoryCounts.get(currentCategoryId) || 0) + 1);
    evidence.set(sourceCategory, categoryCounts);
  }

  const knownCategoryIds = new Set(actualCategories.map(category => category.id));
  const learnedMappings: CategoryMappingDto[] = [];
  for (const [sourceCategory, categoryCounts] of evidence) {
    const ranked = [...categoryCounts.entries()].sort((left, right) => right[1] - left[1]);
    if (ranked.length !== 1) {
      continue;
    }

    const [actualCategoryId, count] = ranked[0];
    if (count < CATEGORY_LEARNING_MIN_MATCHES || !knownCategoryIds.has(actualCategoryId)) {
      continue;
    }

    learnedMappings.push({
      sourceCategory,
      actualCategoryId
    });
  }

  if (learnedMappings.length === 0) {
    return linkConfig;
  }

  return {
    ...linkConfig,
    categoryMappings: [...(linkConfig.categoryMappings || []), ...learnedMappings]
  } satisfies LinkConfigData;
}

export async function pruneImportedTransactionLedger({
  database,
  accountLinkId,
  now
}: {
  database: ImportedTransactionStore;
  accountLinkId: string;
  now: Date;
}) {
  const retentionCutoff = new Date(now.getTime() - IMPORTED_TRANSACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  await database.importedTransaction.deleteMany({
    where: {
      accountLinkId,
      lastSeenAt: {
        lt: retentionCutoff
      }
    }
  });

  const overflowRows = await database.importedTransaction.findMany({
    where: {
      accountLinkId
    },
    orderBy: [
      {
        lastSeenAt: "desc"
      },
      {
        createdAt: "desc"
      }
    ],
    skip: IMPORTED_TRANSACTION_MAX_ROWS_PER_LINK,
    select: {
      id: true
    }
  });

  if (overflowRows.length > 0) {
    await database.importedTransaction.deleteMany({
      where: {
        id: {
          in: overflowRows.map(row => row.id)
        }
      }
    });
  }
}
