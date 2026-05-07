import { useEffect, useState } from "react";
import type { ActualAccountDto, RuntimeInfoDto, SyncRunDto } from "@actual-sync/shared";
import { api } from "../api";
import { AccountCard } from "../components/AccountCard";
import { getDisplayErrorMessage } from "../lib/errors";

export function AccountsPage() {
  const [accounts, setAccounts] = useState<ActualAccountDto[]>([]);
  const [runs, setRuns] = useState<SyncRunDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [nextAccounts, nextRuns, nextRuntime] = await Promise.all([
        api.listAccounts(),
        api.listSyncRuns(),
        api.getRuntimeInfo()
      ]);
      setAccounts(nextAccounts);
      setRuns(nextRuns);
      setRuntime(nextRuntime);
      setError(null);
    } catch (loadError) {
      setAccounts([]);
      setRuns([]);
      setRuntime(null);
      setError(
        getDisplayErrorMessage(loadError, "Failed to load Actual accounts.", {
          serverUnavailableMessage: "Could not reach the API server while loading Actual accounts."
        })
      );
    }
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
        <p className="eyebrow">Accounts</p>
        <h2>Map provider accounts onto your Actual budget.</h2>
        <p className="muted">
          Each card shows one Actual account, its active provider link, and the sync settings that control imports.
        </p>
        {runtime ? (
          <>
            <p className="muted">
              {runtime.instanceLabel} · Actual server {runtime.actual.serverUrl}
              {runtime.liveSandboxMode ? " · docker fixture active" : ""}
            </p>
            <p className="muted">
              Native external sync writeback: {runtime.actual.externalSyncWritebackEnabled ? "enabled" : "disabled"}
            </p>
          </>
        ) : null}
        <div className="button-row">
          <button className="ghost-button" onClick={() => void load()}>
            Refresh Actual accounts
          </button>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
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
