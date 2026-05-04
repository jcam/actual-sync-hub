import { useMemo, useState } from "react";
import type { ActualAccountDto, CategoryMappingDto } from "@actual-sync/shared";

function normalizeSourceCategory(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function upsertCategoryMapping(mappings: CategoryMappingDto[], nextMapping: CategoryMappingDto) {
  const sourceCategory = normalizeSourceCategory(nextMapping.sourceCategory);
  if (!sourceCategory || !nextMapping.actualCategoryId) {
    return mappings;
  }

  const nextMappings = mappings.filter(mapping => mapping.sourceCategory !== sourceCategory);
  nextMappings.push({
    sourceCategory,
    actualCategoryId: nextMapping.actualCategoryId
  });
  nextMappings.sort((left, right) => left.sourceCategory.localeCompare(right.sourceCategory));
  return nextMappings;
}

export function CategoryMappingEditor({
  account,
  onSave
}: {
  account: ActualAccountDto;
  onSave: (categoryMappings: CategoryMappingDto[]) => Promise<void>;
}) {
  const [categoryMappings, setCategoryMappings] = useState(account.link.categoryMappings);
  const [customSourceCategory, setCustomSourceCategory] = useState("");
  const [customActualCategoryId, setCustomActualCategoryId] = useState("");
  const [showAllUnmapped, setShowAllUnmapped] = useState(false);
  const [showAllMapped, setShowAllMapped] = useState(false);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  const sourceCategories = useMemo(
    () =>
      Array.from(
        new Set([
          ...account.link.seenCategoryNames,
          ...categoryMappings.map(mapping => mapping.sourceCategory)
        ])
      ).sort((left, right) => left.localeCompare(right)),
    [account.link.seenCategoryNames, categoryMappings]
  );
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredSourceCategories = useMemo(
    () =>
      normalizedFilter
        ? sourceCategories.filter(sourceCategory => sourceCategory.toLowerCase().includes(normalizedFilter))
        : sourceCategories,
    [normalizedFilter, sourceCategories]
  );
  const selectedMappingBySource = useMemo(
    () => new Map(categoryMappings.map(mapping => [mapping.sourceCategory, mapping.actualCategoryId])),
    [categoryMappings]
  );
  const mappedSourceCategories = filteredSourceCategories.filter(sourceCategory => selectedMappingBySource.has(sourceCategory));
  const unmappedSourceCategories = filteredSourceCategories.filter(sourceCategory => !selectedMappingBySource.has(sourceCategory));
  const visibleMappedSourceCategories = showAllMapped ? mappedSourceCategories : mappedSourceCategories.slice(0, 8);
  const visibleUnmappedSourceCategories = showAllUnmapped ? unmappedSourceCategories : unmappedSourceCategories.slice(0, 12);

  return (
    <section className="panel category-editor-page">
      <div className="category-editor-header">
        <div>
          <p className="eyebrow">Category mapping</p>
          <h2>{account.name}</h2>
          <p className="muted">
            Keep the account card simple. Configure provider-category overrides here when automatic matching is not good enough.
          </p>
        </div>
        <div className="category-editor-stats">
          <span className="pill">{categoryMappings.length} explicit</span>
          <span className="pill muted-pill">{account.link.seenCategoryNames.length} seen recently</span>
        </div>
      </div>

      <div className="category-editor-toolbar">
        <label>
          <span>Filter provider categories</span>
          <input
            aria-label="Filter provider categories"
            placeholder="Search seen or mapped categories"
            value={filter}
            onChange={event => setFilter(event.target.value)}
          />
        </label>
      </div>

      <div className="category-mapping-group">
        <p className="eyebrow">Manual override</p>
        <div className="category-mapping-add">
          <label>
            <span>New provider category</span>
            <input
              aria-label="New provider category"
              placeholder="Example: Coffee Shops"
              value={customSourceCategory}
              onChange={event => setCustomSourceCategory(event.target.value)}
            />
          </label>
          <label>
            <span>Map to Actual category</span>
            <select
              aria-label="Map new provider category to Actual category"
              value={customActualCategoryId}
              onChange={event => setCustomActualCategoryId(event.target.value)}
              disabled={account.actualCategories.length === 0}
            >
              <option value="">Choose category</option>
              {account.actualCategories.map(category => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            type="button"
            disabled={!normalizeSourceCategory(customSourceCategory) || !customActualCategoryId}
            onClick={() => {
              const sourceCategory = normalizeSourceCategory(customSourceCategory);
              if (!sourceCategory || !customActualCategoryId) {
                return;
              }
              setCategoryMappings(current =>
                upsertCategoryMapping(current, {
                  sourceCategory,
                  actualCategoryId: customActualCategoryId
                })
              );
              setCustomSourceCategory("");
              setCustomActualCategoryId("");
            }}
          >
            Add mapping
          </button>
        </div>
      </div>

      {mappedSourceCategories.length ? (
        <div className="category-mapping-group">
          <div className="category-mapping-group-header">
            <div>
              <p className="eyebrow">Explicit mappings</p>
              <p className="muted">These categories already have an override for this account.</p>
            </div>
            {mappedSourceCategories.length > visibleMappedSourceCategories.length ? (
              <button className="ghost-button compact-button" type="button" onClick={() => setShowAllMapped(current => !current)}>
                {showAllMapped ? "Show fewer" : `Show all ${mappedSourceCategories.length}`}
              </button>
            ) : null}
          </div>
          <div className="category-mapping-list">
            {visibleMappedSourceCategories.map(sourceCategory => (
              <div key={sourceCategory} className="category-mapping-row page-row">
                <div className="category-mapping-source">
                  <strong>{sourceCategory}</strong>
                  <span className="muted">
                    {account.link.seenCategoryNames.includes(sourceCategory)
                      ? "Seen from provider transactions"
                      : "Manual-only mapping"}
                  </span>
                </div>
                <label className="category-mapping-target">
                  <span className="sr-only">Actual category for {sourceCategory}</span>
                  <select
                    aria-label={`Actual category for ${sourceCategory}`}
                    value={selectedMappingBySource.get(sourceCategory) ?? ""}
                    onChange={event =>
                      setCategoryMappings(current =>
                        event.target.value
                          ? upsertCategoryMapping(current, {
                              sourceCategory,
                              actualCategoryId: event.target.value
                            })
                          : current.filter(mapping => mapping.sourceCategory !== sourceCategory)
                      )
                    }
                  >
                    <option value="">No explicit mapping</option>
                    {account.actualCategories.map(category => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="category-mapping-group">
        <div className="category-mapping-group-header">
          <div>
            <p className="eyebrow">Recent provider categories</p>
            <p className="muted">Only create explicit mappings for the categories that need manual correction.</p>
          </div>
          {unmappedSourceCategories.length > visibleUnmappedSourceCategories.length ? (
            <button className="ghost-button compact-button" type="button" onClick={() => setShowAllUnmapped(current => !current)}>
              {showAllUnmapped ? "Show fewer" : `Show all ${unmappedSourceCategories.length}`}
            </button>
          ) : null}
        </div>
        {unmappedSourceCategories.length ? (
          <div className="category-mapping-list">
            {visibleUnmappedSourceCategories.map(sourceCategory => (
              <div key={sourceCategory} className="category-mapping-row page-row">
                <div className="category-mapping-source">
                  <strong>{sourceCategory}</strong>
                  <span className="muted">Seen from provider transactions</span>
                </div>
                <label className="category-mapping-target">
                  <span className="sr-only">Actual category for {sourceCategory}</span>
                  <select
                    aria-label={`Actual category for ${sourceCategory}`}
                    value=""
                    onChange={event => {
                      if (!event.target.value) {
                        return;
                      }
                      setCategoryMappings(current =>
                        upsertCategoryMapping(current, {
                          sourceCategory,
                          actualCategoryId: event.target.value
                        })
                      );
                    }}
                  >
                    <option value="">Use automatic matching</option>
                    {account.actualCategories.map(category => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">No unmatched provider categories in the current filtered view.</p>
        )}
      </div>

      <div className="button-row">
        <button
          className="primary-button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(categoryMappings);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving..." : "Save category mappings"}
        </button>
      </div>
    </section>
  );
}
