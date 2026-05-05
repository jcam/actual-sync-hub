export interface ActualCategoryOption {
  id: string;
  name: string;
}

const CATEGORY_ALIASES: Record<string, string[]> = {
  accommodation: ["Hotels", "Lodging", "Travel", "Vacation"],
  advertising: ["Advertising", "Business"],
  "bank fees": ["Bank Fees", "Fees"],
  "bank fees atm fees": ["ATM Fees", "Bank Fees", "Fees"],
  "bank fees interest charge": ["Interest", "Bank Fees", "Fees"],
  bar: ["Bars", "Eating Out", "Entertainment"],
  charity: ["Charity", "Donations", "Giving"],
  clothing: ["Clothing", "Shopping"],
  dining: ["Eating Out", "Restaurants", "Dining", "Food"],
  education: ["Education", "School"],
  electronics: ["Electronics", "Shopping"],
  "entertainment": ["Entertainment"],
  food: ["Food", "Groceries", "Eating Out", "Dining"],
  "food and drink": ["Food", "Eating Out", "Dining", "Restaurants", "Groceries"],
  "food and drink coffee": ["Eating Out", "Coffee", "Dining", "Food"],
  "food and drink groceries": ["Groceries", "Food"],
  "food and drink restaurants": ["Eating Out", "Restaurants", "Dining", "Food"],
  fuel: ["Gas", "Fuel", "Transportation", "Auto"],
  general: [],
  "general merchandise": ["Shopping"],
  "general merchandise clothing and accessories": ["Clothing", "Shopping"],
  "general merchandise superstores": ["Shopping"],
  "general services": ["Services"],
  groceries: ["Groceries", "Food"],
  health: ["Medical", "Healthcare", "Health"],
  home: ["Home", "Housing"],
  income: ["Income", "Paycheck"],
  insurance: ["Insurance"],
  investment: ["Investments", "Investment"],
  loan: ["Loan", "Loans", "Debt"],
  "medical": ["Medical", "Healthcare"],
  office: ["Office", "Work"],
  "payment": [],
  phone: ["Phone", "Utilities", "Bills"],
  "rent and utilities": ["Rent", "Utilities", "Bills"],
  "rent and utilities gas and electric": ["Utilities", "Electricity", "Bills"],
  "rent and utilities internet and cable": ["Internet", "Cable", "Utilities", "Bills"],
  "rent and utilities rent": ["Rent", "Mortgage", "Housing"],
  service: ["Services"],
  shopping: ["Shopping"],
  software: ["Software"],
  sport: ["Sports", "Fitness"],
  tax: ["Taxes", "Tax"],
  transport: ["Transportation", "Auto"],
  "transportation": ["Transportation", "Auto"],
  "transportation gas": ["Gas", "Fuel", "Transportation", "Auto"],
  "transportation parking": ["Parking", "Transportation"],
  "travel": ["Travel", "Vacation"],
  "travel flights": ["Airfare", "Travel", "Vacation"],
  "travel lodging": ["Hotels", "Lodging", "Travel", "Vacation"],
  utilities: ["Utilities", "Bills"]
};

function unique(values: string[]) {
  return [...new Set(values)];
}

function toTitleCase(parts: string[]) {
  return parts
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function buildProviderCategoryNames(value?: string | null) {
  if (!value) {
    return [];
  }

  const parts = value.split(/[_\s-]+/g).filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  return unique([toTitleCase(parts)]);
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
        return [normalized, ...(CATEGORY_ALIASES[normalized] || []).map(normalizeCategoryName)];
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
