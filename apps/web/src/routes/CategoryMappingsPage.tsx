import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ActualAccountDto } from "@actual-sync/shared";
import { api } from "../api";
import { CategoryMappingEditor } from "../components/CategoryMappingEditor";

export function CategoryMappingsPage() {
  const { actualAccountId } = useParams<{ actualAccountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<ActualAccountDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void api
      .listAccounts()
      .then(accounts => {
        if (cancelled) {
          return;
        }
        setAccount(accounts.find(candidate => candidate.id === actualAccountId) || null);
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
        <h2>Account not found</h2>
        <p className="muted">The selected Actual account could not be loaded for mapping.</p>
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
          This editor is account-specific. Use it when automatic Plaid-to-Actual category matching needs manual correction for one Actual account.
        </p>
        <div className="button-row">
          <Link className="ghost-button inline-link-button" to="/accounts">
            Back to accounts
          </Link>
        </div>
      </section>

      <CategoryMappingEditor
        account={account}
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
          navigate("/accounts");
        }}
      />
    </div>
  );
}
