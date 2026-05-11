import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, ProviderSettingsByProviderDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { ConnectionReauthButton } from "../components/ConnectionReauthButton";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { SyncHealthBadge } from "../components/SyncHealthBadge";
import { getDisplayErrorMessage } from "../lib/errors";

const defaultBelvoSettings: ProviderSettingsByProviderDto<"BELVO"> = {
  environment: "sandbox",
  sandbox: {
    secretId: "",
    secretPassword: ""
  },
  production: {
    secretId: "",
    secretPassword: ""
  },
  transactionsInitialDays: 90,
  transactionsOverlapDays: 7,
  automaticSyncConcurrency: 2
};

export function BelvoConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [linkId, setLinkId] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [workingConnectionId, setWorkingConnectionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
    issues: ["Enter a Belvo secret ID and secret password to enable Belvo link imports."],
    notes: ["Import an existing Belvo link ID after it has already been created through Belvo."]
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

      <section className="panel">
        <p className="eyebrow">Import Belvo link</p>
        <div className="status-copy">
          <p className="muted">
            Paste an existing Belvo <code>link.id</code> to import its accounts into Actual Sync Hub. This page uses
            the server-side Belvo SDK for account refreshes and transaction syncs.
          </p>
        </div>
        <div className="grid account-settings-grid">
          <label>
            <span>Belvo link ID</span>
            <input
              type="text"
              value={linkId}
              onChange={event => setLinkId(event.target.value)}
              placeholder="c81a1dea-6dd6-4999-8b9f-541ee8197058"
            />
          </label>
          <label>
            <span>Label (optional)</span>
            <input
              type="text"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="Primary Belvo banking link"
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={submitting || !linkId.trim() || !runtime?.belvo?.enabled}
            onClick={async () => {
              setSubmitting(true);
              setMessage(null);
              setError(null);

              try {
                await api.connectBelvoLink(linkId.trim(), label.trim() || undefined);
                setLinkId("");
                setLabel("");
                setMessage("Belvo link imported.");
                await load();
              } catch (submitError) {
                setError(
                  getDisplayErrorMessage(submitError, "Failed to import the Belvo link.", {
                    serverUnavailableMessage: "Could not reach the API server while importing the Belvo link."
                  })
                );
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Importing..." : "Import Belvo link"}
          </button>
          <button className="ghost-button" disabled={submitting} onClick={() => void load()}>
            Refresh page data
          </button>
        </div>
        {message ? <p className="success-text">{message}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Belvo provider accounts</p>
        {loading ? <p>Loading Belvo connections…</p> : null}
        {!loading && belvoConnections.length === 0 ? (
          <p className="muted">No Belvo links have been imported yet.</p>
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
                    setMessage(null);
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
                    setMessage(null);
                    setError(null);
                    try {
                      await api.disconnectConnection(connection.id);
                      setMessage("Belvo link disconnected.");
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
