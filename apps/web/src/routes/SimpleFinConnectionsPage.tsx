import { useEffect, useMemo, useState } from "react";
import type { ActualBankSyncLinkDto, ConnectionDto } from "@actual-sync/shared";
import { api } from "../api";
import { SyncHealthPanel } from "../components/SyncHealthPanel";
import { SyncHealthBadge } from "../components/SyncHealthBadge";
import { getDisplayErrorMessage } from "../lib/errors";

function formatImportSummary(summary: {
  imported: number;
  updated: number;
  skipped: number;
  unmatched: number;
}) {
  return `Imported ${summary.imported}, refreshed ${summary.updated}, skipped ${summary.skipped}, unmatched ${summary.unmatched}.`;
}

function formatSimpleFinPageError(error: unknown, fallback: string) {
  const message = getDisplayErrorMessage(error, fallback, {
    serverUnavailableMessage: "Could not reach the API server while loading SimpleFIN state."
  });
  const normalized = message.toLowerCase();

  if (normalized.includes("could not get remote files")) {
    return "Failed to reach the connected Actual budget while loading SimpleFIN state.";
  }

  return message || fallback;
}

export function SimpleFinConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [bankSyncLinks, setBankSyncLinks] = useState<ActualBankSyncLinkDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupToken, setSetupToken] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reusingCached, setReusingCached] = useState(false);
  const [refreshingConnectionId, setRefreshingConnectionId] = useState<string | null>(null);
  const [importingConnectionId, setImportingConnectionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [bankSyncLinksError, setBankSyncLinksError] = useState<string | null>(null);

  const load = async () => {
    const [connectionsResult, bankSyncLinksResult] = await Promise.allSettled([
      api.listConnections(),
      api.listActualBankSyncLinks()
    ]);

    if (connectionsResult.status === "fulfilled") {
      setConnections(connectionsResult.value);
      setConnectionsError(null);
    } else {
      setConnections([]);
      setConnectionsError(
        formatSimpleFinPageError(
          connectionsResult.reason,
          "Failed to load app-managed SimpleFIN connections."
        )
      );
    }

    if (bankSyncLinksResult.status === "fulfilled") {
      setBankSyncLinks(bankSyncLinksResult.value);
      setBankSyncLinksError(null);
    } else {
      setBankSyncLinks([]);
      setBankSyncLinksError(
        formatSimpleFinPageError(
          bankSyncLinksResult.reason,
          "Failed to inspect existing SimpleFIN-linked accounts from Actual."
        )
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const simplefinConnections = useMemo(
    () => connections.filter(connection => connection.provider === "SIMPLEFIN"),
    [connections]
  );
  const simplefinBudgetLinks = useMemo(
    () => bankSyncLinks.filter(link => link.accountSyncSource === "simpleFin"),
    [bankSyncLinks]
  );

  return (
    <div className="page-stack">
      <section className="panel">
        <p className="eyebrow">Connect SimpleFIN</p>
        <div className="status-copy">
          <p className="muted">
            Enter a one-time SimpleFIN setup token to create a managed SimpleFIN connection. After the connection is
            loaded, you can import matching native Actual <code>simpleFin</code> account links into this app.
          </p>
        </div>
        <div className="grid account-settings-grid">
          <label className="wide-field">
            <span>Setup token</span>
            <textarea
              rows={3}
              value={setupToken}
              onChange={event => setSetupToken(event.target.value)}
              placeholder="Paste the one-time SimpleFIN setup token"
            />
          </label>
          <label>
            <span>Label</span>
            <input
              type="text"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="Optional connection label"
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={submitting || setupToken.trim().length === 0}
            onClick={async () => {
              setSubmitting(true);
              setError(null);
              setMessage(null);
              try {
                await api.connectSimpleFin(setupToken.trim(), label.trim() || undefined);
                setSetupToken("");
                setLabel("");
                setMessage("SimpleFIN connection saved.");
                await load();
              } catch (connectError) {
                setError(
                  formatSimpleFinPageError(
                    connectError,
                    "Failed to connect SimpleFIN. The setup token may be invalid or expired."
                  )
                );
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Connecting..." : "Connect SimpleFIN"}
          </button>
          <button
            className="ghost-button"
            disabled={reusingCached}
            onClick={async () => {
              setReusingCached(true);
              setError(null);
              setMessage(null);
              try {
                await api.reuseCachedSimpleFinConnection(label.trim() || undefined);
                setLabel("");
                setMessage("Reused cached SimpleFIN fixture.");
                await load();
              } catch (reuseError) {
                setError(
                  formatSimpleFinPageError(
                    reuseError,
                    "Failed to reuse the cached SimpleFIN fixture."
                  )
                );
              } finally {
                setReusingCached(false);
              }
            }}
          >
            {reusingCached ? "Reusing fixture..." : "Reuse cached SimpleFIN fixture"}
          </button>
        </div>
        <p className="muted">When provider fixture caching is enabled, you can reuse the most recent SimpleFIN credentials instead of pasting a new setup token.</p>
        {message ? <p className="success-text">{message}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Existing Actual SimpleFIN links</p>
        {loading ? <p>Loading SimpleFIN-linked Actual accounts…</p> : null}
        {!loading && bankSyncLinksError ? <p className="error-text">{bankSyncLinksError}</p> : null}
        {!loading && simplefinBudgetLinks.length === 0 ? (
          <p className="muted">No existing SimpleFIN-linked accounts were detected in the current Actual budget.</p>
        ) : null}
        <div className="stack-list">
          {simplefinBudgetLinks.map(link => (
            <article key={link.actualAccountId} className="list-card">
              <div className="list-card-header">
                <div>
                  <strong>{link.actualAccountName}</strong>
                  {link.actualOfficialName ? <p className="muted">{link.actualOfficialName}</p> : null}
                </div>
                {link.currentLinkProvider ? <span className="tag">Managed here via {link.currentLinkProvider}</span> : null}
              </div>
              <div className="list-card-meta">
                <span>External account: {link.externalAccountId}</span>
                <span>Native sync source: {link.accountSyncSource}</span>
                <span>{link.actualBankName ? `Actual bank: ${link.actualBankName}` : "Actual bank: not recorded"}</span>
                <span>{link.actualBankExternalId ? `Bank external id: ${link.actualBankExternalId}` : "Bank external id: not recorded"}</span>
                <span>{link.mask ? `Mask: ••${link.mask}` : "Mask: not recorded"}</span>
                <span>
                  {typeof link.balanceCurrent === "number" ? `Current balance ${link.balanceCurrent.toFixed(2)}` : "Current balance: not recorded"}
                </span>
                <span>{link.lastSyncedAt ? `Last synced ${link.lastSyncedAt}` : "Last synced: not recorded"}</span>
                <span>{link.currentLinkStatus ? `Current local link: ${link.currentLinkStatus}` : "Current local link: none"}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Managed SimpleFIN connections</p>
        {loading ? <p>Loading SimpleFIN connections…</p> : null}
        {!loading && connectionsError ? <p className="error-text">{connectionsError}</p> : null}
        {!loading && simplefinConnections.length === 0 ? (
          <p className="muted">No SimpleFIN connections have been added.</p>
        ) : null}
        <div className="stack-list">
          {simplefinConnections.map(connection => (
            <article key={connection.id} className="list-card">
              <div className="list-card-header">
                <strong>{connection.label}</strong>
                <div className="status-row">
                  <span className="tag">{connection.status}</span>
                  {connection.health ? <SyncHealthBadge health={connection.health} compact /> : null}
                </div>
              </div>
              {connection.health ? (
                <SyncHealthPanel
                  eyebrow="Connection status"
                  health={connection.health}
                  provider={connection.provider}
                  scope="connection"
                />
              ) : null}
              <div className="list-card-meta">
                <span>{connection.institutionName || "SimpleFIN"}</span>
                <span>{connection.accounts.length} provider account{connection.accounts.length === 1 ? "" : "s"}</span>
              </div>
              <div className="button-row">
                <button
                  className="ghost-button"
                  disabled={refreshingConnectionId === connection.id}
                  onClick={async () => {
                    setRefreshingConnectionId(connection.id);
                    setError(null);
                    setMessage(null);
                    try {
                      await api.refreshConnection(connection.id);
                      setMessage(`Refreshed ${connection.label}.`);
                      await load();
                    } catch (refreshError) {
                      setError(
                        formatSimpleFinPageError(
                          refreshError,
                          "Failed to refresh this SimpleFIN connection."
                        )
                      );
                    } finally {
                      setRefreshingConnectionId(null);
                    }
                  }}
                >
                  {refreshingConnectionId === connection.id ? "Refreshing..." : "Refresh accounts"}
                </button>
                <button
                  className="ghost-button"
                  onClick={async () => {
                    setError(null);
                    setMessage(null);
                    try {
                      await api.disconnectConnection(connection.id);
                      setMessage(`Disconnected ${connection.label}.`);
                      await load();
                    } catch (disconnectError) {
                      setError(formatSimpleFinPageError(disconnectError, "Failed to disconnect this SimpleFIN connection."));
                    }
                  }}
                >
                  Disconnect
                </button>
                <button
                  className="primary-button"
                  disabled={importingConnectionId === connection.id}
                  onClick={async () => {
                    setImportingConnectionId(connection.id);
                    setError(null);
                    setMessage(null);
                    try {
                      const summary = await api.importExistingSimpleFinLinks(connection.id);
                      setMessage(formatImportSummary(summary));
                      await load();
                    } catch (importError) {
                      setError(
                        formatSimpleFinPageError(
                          importError,
                          "Failed to import matching Actual SimpleFIN links."
                        )
                      );
                    } finally {
                      setImportingConnectionId(null);
                    }
                  }}
                >
                  {importingConnectionId === connection.id ? "Importing..." : "Import matching Actual links"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
