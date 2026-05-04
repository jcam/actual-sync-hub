import { useEffect, useState } from "react";
import type { ActualAccountDto, RuntimeInfoDto, SyncRunDto } from "@actual-sync/shared";
import { api } from "../api";
import { AccountCard } from "../components/AccountCard";

export function AccountsPage() {
  const [accounts, setAccounts] = useState<ActualAccountDto[]>([]);
  const [runs, setRuns] = useState<SyncRunDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [nextAccounts, nextRuns, nextRuntime] = await Promise.all([
      api.listAccounts(),
      api.listSyncRuns(),
      api.getRuntimeInfo()
    ]);
    setAccounts(nextAccounts);
    setRuns(nextRuns);
    setRuntime(nextRuntime);
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="panel">Loading accounts…</div>;
  }

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <p className="eyebrow">Main view</p>
        <h2>Actual accounts stay central.</h2>
        <p className="muted">
          Each card reflects a live Actual account and the provider mapping that controls imports. This is the seam where non-bank providers can plug in later without changing the overall UX.
        </p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Actual server {runtime.actual.serverUrl}
            {runtime.liveSandboxMode ? " · docker fixture active" : ""}
          </p>
        ) : null}
        <div className="button-row">
          <button className="ghost-button" onClick={() => void load()}>
            Refresh Actual accounts
          </button>
        </div>
      </section>

      <section className="account-grid">
        {accounts.map(account => (
          <AccountCard key={account.id} account={account} onRefresh={load} />
        ))}
      </section>

      <section className="panel">
        <p className="eyebrow">Recent sync runs</p>
        <div className="sync-run-list">
          {runs.map(run => (
            <div key={run.id} className="sync-run">
              <strong>{run.status}</strong>
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>{run.summary || run.error || "No details"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
