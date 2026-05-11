import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, ProviderSettingsByProviderDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { BelvoLinkPanel } from "../components/BelvoLinkPanel";
import { ConnectionReauthButton } from "../components/ConnectionReauthButton";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { SyncHealthBadge } from "../components/SyncHealthBadge";
import { getDisplayErrorMessage } from "../lib/errors";

const defaultBelvoSettings: ProviderSettingsByProviderDto<"BELVO"> = {
  environment: "sandbox",
  sandbox: {
    secretId: "",
    secretPassword: "",
    webhookAuthorization: ""
  },
  production: {
    secretId: "",
    secretPassword: "",
    webhookAuthorization: ""
  },
  transactionsInitialDays: 90,
  transactionsOverlapDays: 7,
  automaticSyncConcurrency: 2
};

export function BelvoConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [workingConnectionId, setWorkingConnectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [nextConnections, nextRuntime] = await Promise.all([api.listConnections(), api.getRuntimeInfo()]);
      setConnections(nextConnections);
      setRuntime(nextRuntime);
      setError(null);
    } catch (loadError) {
      setConnections([]);
      setRuntime(null);
      setError(
        getDisplayErrorMessage(loadError, "Failed to load Belvo connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Belvo connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const belvoConnections = useMemo(
    () => connections.filter(connection => connection.provider === "BELVO"),
    [connections]
  );
  const belvoRuntime = runtime?.providers.find(provider => provider.provider === "BELVO") ?? {
    provider: "BELVO" as const,
    label: "Belvo",
    enabled: false,
    ready: false,
    environment: "sandbox",
    issues: ["Enter a Belvo secret ID and secret password to enable Belvo Connect."],
    notes: ["Launch Belvo Connect from this page, then refresh or reconnect links in-app as needed."]
  };

  return (
    <div className="page-stack">
      <ProviderReadinessPanel provider={belvoRuntime} />
      <ProviderSettingsPanel
        provider="BELVO"
        label="Belvo"
        settings={runtime?.settings.BELVO ?? defaultBelvoSettings}
        onSaved={load}
      />
      <BelvoLinkPanel enabled={Boolean(runtime?.belvo?.enabled)} onConnected={load} />

      <section className="panel">
        <p className="eyebrow">Belvo provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Belvo {runtime.belvo?.environment ?? "sandbox"}
          </p>
        ) : null}
        {loading ? <p>Loading Belvo connections…</p> : null}
        {!loading && error ? <p className="error-text">{error}</p> : null}
        {!loading && belvoConnections.length === 0 ? (
          <p className="muted">No Belvo connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {belvoConnections.map(connection => (
            <article key={connection.id} className="list-card">
              <div className="connection-head">
                <div>
                  <h3>{connection.label}</h3>
                  <p className="muted">
                    {connection.institutionName ?? "Belvo link"}
                    {connection.lastRefreshedAt ? ` · refreshed ${new Date(connection.lastRefreshedAt).toLocaleString()}` : ""}
                  </p>
                </div>
                <div className="status-row">
                  {connection.health ? <SyncHealthBadge health={connection.health} compact /> : null}
                  <span className="tag">{connection.status}</span>
                </div>
              </div>
              <div className="list-card-meta">
                {connection.accounts.map(account => (
                  <span key={account.id}>
                    {account.name}
                    {account.mask ? ` ••${account.mask}` : ""}
                  </span>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="ghost-button"
                  disabled={workingConnectionId === connection.id}
                  onClick={async () => {
                    setWorkingConnectionId(connection.id);
                    setError(null);
                    try {
                      await api.refreshConnection(connection.id);
                      await load();
                    } catch (refreshError) {
                      setError(
                        getDisplayErrorMessage(refreshError, "Failed to refresh the Belvo link.", {
                          serverUnavailableMessage: "Could not reach the API server while refreshing the Belvo link."
                        })
                      );
                    } finally {
                      setWorkingConnectionId(null);
                    }
                  }}
                >
                  {workingConnectionId === connection.id ? "Refreshing..." : "Refresh"}
                </button>
                <ConnectionReauthButton connectionId={connection.id} provider="BELVO" onCompleted={load} />
                <button
                  className="ghost-button"
                  disabled={workingConnectionId === connection.id}
                  onClick={async () => {
                    setWorkingConnectionId(connection.id);
                    setError(null);
                    try {
                      await api.disconnectConnection(connection.id);
                      await load();
                    } catch (disconnectError) {
                      setError(
                        getDisplayErrorMessage(disconnectError, "Failed to disconnect the Belvo link.", {
                          serverUnavailableMessage: "Could not reach the API server while disconnecting the Belvo link."
                        })
                      );
                    } finally {
                      setWorkingConnectionId(null);
                    }
                  }}
                >
                  Disconnect
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
