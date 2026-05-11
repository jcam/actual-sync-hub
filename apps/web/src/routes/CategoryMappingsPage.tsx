import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ActualAccountDto, ActualCategoryDto } from "@actual-sync/shared";
import { api } from "../api";
import { CategoryMappingEditor } from "../components/CategoryMappingEditor";
import { getDisplayErrorMessage } from "../lib/errors";

export function CategoryMappingsPage() {
  const { actualAccountId } = useParams<{ actualAccountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<ActualAccountDto | null>(null);
  const [actualCategories, setActualCategories] = useState<ActualCategoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api
      .listAccounts()
      .then(({ accounts, actualCategories: sharedCategories }) => {
        if (cancelled) {
          return;
        }
        setActualCategories(sharedCategories);
        setAccount(accounts.find((candidate: ActualAccountDto) => candidate.id === actualAccountId) || null);
        setError(null);
      })
      .catch(loadError => {
        if (cancelled) {
          return;
        }
        setAccount(null);
        setActualCategories([]);
        setError(
          getDisplayErrorMessage(loadError, "Failed to load category mappings.", {
            serverUnavailableMessage: "Could not reach the API server while loading category mappings."
          })
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [actualAccountId]);

  if (loading) {
    return <div className="panel">Loading category mappings…</div>;
  }

  if (!account) {
    return (
      <section className="panel">
        <p className="eyebrow">Category mapping</p>
        <h2>{error ? "Could not load mappings" : "Account not found"}</h2>
        <p className={error ? "error-text" : "muted"}>
          {error || "The selected Actual account could not be loaded for mapping."}
        </p>
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
        <p className="eyebrow">Mapping workspace</p>
        <h2>{account.name}</h2>
        <p className="muted">
          This editor is account-specific. Use it when automatic provider-to-Actual category matching needs manual correction for one Actual account.
        </p>
        <div className="button-row">
          <Link className="ghost-button inline-link-button" to="/accounts">
            Back to accounts
          </Link>
        </div>
      </section>

      <CategoryMappingEditor
        account={account}
        actualCategories={actualCategories}
        onSave={async categoryMappings => {
          await api.updateAccountLink(account.id, {
            actualAccountName: account.link.actualAccountName,
            assetType: account.link.assetType,
            provider: account.link.provider ?? null,
            connectionId: account.link.connectionId ?? null,
            connectionAccountId: account.link.connectionAccountId ?? null,
            syncFrequency: account.link.syncFrequency,
            syncHour: account.link.syncHour ?? null,
            syncDayOfWeek: account.link.syncDayOfWeek ?? null,
            isEnabled: account.link.isEnabled,
            categoryMappings
          });
          void navigate("/accounts");
        }}
      />
    </div>
  );
}
