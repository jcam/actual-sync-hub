export interface ActualCategoryOption {
  id: string;
  name: string;
}

const PLAID_CATEGORY_ALIASES: Record<string, string[]> = {
  "bank fees": ["Bank Fees", "Fees"],
  "bank fees atm fees": ["ATM Fees", "Bank Fees", "Fees"],
  "bank fees interest charge": ["Interest", "Bank Fees", "Fees"],
  "entertainment": ["Entertainment"],
  "food and drink": ["Food", "Eating Out", "Dining", "Restaurants", "Groceries"],
  "food and drink coffee": ["Eating Out", "Coffee", "Dining", "Food"],
  "food and drink groceries": ["Groceries", "Food"],
  "food and drink restaurants": ["Eating Out", "Restaurants", "Dining", "Food"],
  "general merchandise": ["Shopping"],
  "general merchandise clothing and accessories": ["Clothing", "Shopping"],
  "general merchandise superstores": ["Shopping"],
  "general services": ["Services"],
  "medical": ["Medical", "Healthcare"],
  "payment": [],
  "rent and utilities": ["Rent", "Utilities", "Bills"],
  "rent and utilities gas and electric": ["Utilities", "Electricity", "Bills"],
  "rent and utilities internet and cable": ["Internet", "Cable", "Utilities", "Bills"],
  "rent and utilities rent": ["Rent", "Mortgage", "Housing"],
  "transportation": ["Transportation", "Auto"],
  "transportation gas": ["Gas", "Fuel", "Transportation", "Auto"],
  "transportation parking": ["Parking", "Transportation"],
  "travel": ["Travel", "Vacation"],
  "travel flights": ["Airfare", "Travel", "Vacation"],
  "travel lodging": ["Hotels", "Lodging", "Travel", "Vacation"]
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function toTitleCase(parts: string[]) {
  return parts
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export function normalizeCategoryName(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function buildPlaidCategoryNames({
  primary,
  detailed
}: {
  primary?: string | null;
  detailed?: string | null;
}) {
  const candidates: string[] = [];
  const add = (value?: string | null) => {
    if (value) {
      candidates.push(value);
    }
  };

  const primaryParts = primary?.split("_").filter(Boolean) || [];
  const detailedParts = detailed?.split("_").filter(Boolean) || [];

  if (detailedParts.length > 0) {
    add(toTitleCase(detailedParts));

    const leafParts =
      primaryParts.length > 0 &&
      primaryParts.every((part, index) => detailedParts[index] === part)
        ? detailedParts.slice(primaryParts.length)
        : [detailedParts[detailedParts.length - 1] as string];

    if (leafParts.length > 0) {
      add(toTitleCase(leafParts));
    }
  }

  if (primaryParts.length > 0) {
    add(toTitleCase(primaryParts));
  }

  return unique(candidates);
}

export function resolveActualCategoryId({
  categoryNames,
  actualCategories
}: {
  categoryNames?: string[];
  actualCategories: ActualCategoryOption[];
}) {
  if (!categoryNames?.length) {
    return undefined;
  }

  const categoryIdsByName = new Map<string, string[]>();
  for (const category of actualCategories) {
    const normalized = normalizeCategoryName(category.name);
    const existing = categoryIdsByName.get(normalized) || [];
    existing.push(category.id);
    categoryIdsByName.set(normalized, existing);
  }

  const normalizedCandidates = unique(
    categoryNames
      .flatMap(categoryName => {
        const normalized = normalizeCategoryName(categoryName);
        return [normalized, ...(PLAID_CATEGORY_ALIASES[normalized] || []).map(normalizeCategoryName)];
      })
      .filter(Boolean)
      .filter(value => !value.startsWith("transfer"))
  );

  for (const candidate of normalizedCandidates) {
    const ids = categoryIdsByName.get(candidate);
    if (ids?.length === 1) {
      return ids[0];
    }
  }

  for (const candidate of normalizedCandidates) {
    const partialMatches = actualCategories.filter(category => {
      const normalizedActual = normalizeCategoryName(category.name);
      return normalizedActual.length >= 4 && (candidate.includes(normalizedActual) || normalizedActual.includes(candidate));
    });

    if (partialMatches.length === 1) {
      return partialMatches[0]?.id;
    }
  }

  return undefined;
}
