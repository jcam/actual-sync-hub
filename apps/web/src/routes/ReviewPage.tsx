import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { MigrationPreviewDto } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";

function formatCurrency(amount: number) {
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD"
  });
}

export function ReviewPage() {
  const { actualAccountId } = useParams<{ actualAccountId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<MigrationPreviewDto | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reviewMode = location.pathname.endsWith("/migration") ? "migration" : "sync-review";
  const pageLabel = reviewMode === "migration" ? "Migration review" : "Sync review";

  const load = useCallback(async () => {
    if (!actualAccountId) {
      setPreview(null);
      setLoading(false);
      return;
    }

    setError(null);
    setSaveError(null);
    try {
      const nextPreview =
        reviewMode === "migration"
          ? await api.previewMigration(actualAccountId)
          : await api.previewSyncReview(actualAccountId);
      setPreview(nextPreview);
      setSelectedIds(
        new Set(nextPreview.items.filter(item => item.action !== "ignore").map(item => item.importedId))
      );
    } catch (loadError) {
      setPreview(null);
      setError(
        getDisplayErrorMessage(loadError, `Failed to load ${pageLabel.toLowerCase()}.`, {
          serverUnavailableMessage: `Could not reach the API server to load ${pageLabel.toLowerCase()}.`
        })
      );
    }
  }, [actualAccountId, pageLabel, reviewMode]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const groupedCounts = useMemo(() => {
    if (!preview) {
      return {
        add: 0,
        update: 0,
        ignore: 0
      };
    }

    return preview.items.reduce(
      (counts, item) => {
        counts[item.action] += 1;
        return counts;
      },
      { add: 0, update: 0, ignore: 0 } as Record<"add" | "update" | "ignore", number>
    );
  }, [preview]);

  if (loading) {
    return <div className="panel">Loading {pageLabel.toLowerCase()}…</div>;
  }

  if (error) {
    return (
      <section className="panel">
        <p className="eyebrow">{pageLabel}</p>
        <h2>Could not load preview</h2>
        <p className="error-text">{error}</p>
        <div className="button-row">
          <button className="ghost-button" onClick={() => void load()}>
            Retry
          </button>
          <Link className="ghost-button inline-link-button" to="/accounts">
            Back to accounts
          </Link>
        </div>
      </section>
    );
  }

  if (!preview) {
    return (
      <section className="panel">
        <p className="eyebrow">{pageLabel}</p>
        <h2>Review not available</h2>
        <p className="muted">The selected account could not be loaded for review.</p>
        <div className="button-row">
          <Link className="ghost-button inline-link-button" to="/accounts">
            Back to accounts
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <p className="eyebrow">{pageLabel}</p>
        <h2>{preview.actualAccountName}</h2>
        <p className="muted">
          {preview.status === "MIGRATING"
            ? "This uses Actual's built-in reconciliation preview engine. Review what would be added versus merged into existing Actual transactions before promoting the new provider link."
            : "This uses Actual's built-in reconciliation preview engine. Review what would be added versus merged into existing Actual transactions before committing a manual sync."}
        </p>
        <div className="migration-stat-row">
          <span className="pill">{groupedCounts.add} add</span>
          <span className="pill">{groupedCounts.update} update existing</span>
          <span className="pill muted-pill">{groupedCounts.ignore} ignored</span>
        </div>
        <p className="muted">
          Deselected rows will be skipped when this review is committed, and the provider sync state will advance past
          them.
        </p>
        {saveError ? <p className="error-text">{saveError}</p> : null}
        <div className="button-row">
          <button className="ghost-button" onClick={() => void load()}>
            Refresh preview
          </button>
          <button
            className="primary-button"
            disabled={saving}
            onClick={async () => {
              if (!actualAccountId) {
                return;
              }

              setSaving(true);
              try {
                const payload = {
                  snapshotId: preview.snapshotId,
                  importedIds: [...selectedIds]
                };
                if (reviewMode === "migration") {
                  await api.commitMigration(actualAccountId, payload);
                } else {
                  await api.commitSyncReview(actualAccountId, payload);
                }
                void navigate("/accounts");
              } catch (commitError) {
                setSaveError(
                  getDisplayErrorMessage(commitError, `Failed to commit ${pageLabel.toLowerCase()}.`, {
                    serverUnavailableMessage: `Could not reach the API server to commit ${pageLabel.toLowerCase()}.`
                  })
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Committing..." : `Commit ${selectedIds.size} selected`}
          </button>
          <Link className="ghost-button inline-link-button" to="/accounts">
            Back to accounts
          </Link>
        </div>
      </section>

      <section className="panel migration-table-panel">
        {preview.items.length === 0 ? (
          <p className="muted">No provider transactions are waiting in this review window.</p>
        ) : (
          <div className="migration-table-scroll">
            <table className="migration-table">
              <thead>
                <tr>
                  <th>Include</th>
                  <th>Date</th>
                  <th>Payee</th>
                  <th>Amount</th>
                  <th>Provider category</th>
                  <th>Actual action</th>
                  <th>Existing Actual match</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map(item => {
                  const disabled = item.action === "ignore";
                  return (
                    <tr key={item.importedId}>
                      <td>
                        <input
                          aria-label={`Include ${item.payeeName}`}
                          type="checkbox"
                          checked={selectedIds.has(item.importedId)}
                          disabled={disabled}
                          onChange={event => {
                            setSelectedIds(current => {
                              const next = new Set(current);
                              if (event.target.checked) {
                                next.add(item.importedId);
                              } else {
                                next.delete(item.importedId);
                              }
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td>{item.date}</td>
                      <td>
                        <strong>{item.payeeName}</strong>
                        {item.importedPayee ? <div className="muted">{item.importedPayee}</div> : null}
                      </td>
                      <td>{formatCurrency(item.amount)}</td>
                      <td>{item.categoryNames.join(" / ") || "Uncategorized"}</td>
                      <td>
                        <span className={`pill ${item.action === "ignore" ? "muted-pill" : ""}`}>
                          {item.action === "add"
                            ? "Will add"
                            : item.action === "update"
                              ? "Will update"
                              : "Ignored"}
                        </span>
                      </td>
                      <td>
                        {item.existing ? (
                          <div className="migration-existing">
                            <strong>{item.existing.date}</strong>
                            <span>{formatCurrency(item.existing.amount)}</span>
                            {item.existing.importedPayee ? <span className="muted">{item.existing.importedPayee}</span> : null}
                          </div>
                        ) : (
                          <span className="muted">No existing match</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
