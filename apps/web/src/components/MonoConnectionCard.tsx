import { useState } from "react";
import type { ConnectionDto } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { SyncHealthBadge } from "./SyncHealthBadge";
import { SyncHealthPanel } from "./SyncHealthPanel";

export function MonoConnectionCard({
  connection,
  onRefresh
}: {
  connection: ConnectionDto;
  onRefresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  return (
    <article className="connection-card">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Mono account</p>
          <h3>{connection.label}</h3>
          <p className="muted">{connection.institutionName || "Institution name unavailable"}</p>
        </div>
        <div className="status-row">
          <span className="tag">{connection.status}</span>
          {connection.health ? <SyncHealthBadge health={connection.health} compact /> : null}
        </div>
      </div>
      <div className="button-row">
        <button
          className="ghost-button"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            setError(null);
            try {
              await api.refreshConnection(connection.id);
              await onRefresh();
            } catch (refreshError) {
              setError(
                getDisplayErrorMessage(refreshError, "Failed to refresh this Mono connection.", {
                  serverUnavailableMessage: "Could not reach the API server to refresh this Mono connection."
                })
              );
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? "Refreshing..." : "Refresh account"}
        </button>
        <button
          className="ghost-button"
          disabled={disconnecting}
          onClick={async () => {
            setDisconnecting(true);
            setError(null);
            try {
              await api.disconnectConnection(connection.id);
              await onRefresh();
            } catch (disconnectError) {
              setError(
                getDisplayErrorMessage(disconnectError, "Failed to disconnect this Mono connection.", {
                  serverUnavailableMessage: "Could not reach the API server to disconnect this Mono connection."
                })
              );
            } finally {
              setDisconnecting(false);
            }
          }}
        >
          {disconnecting ? "Disconnecting..." : "Disconnect"}
        </button>
      </div>
      {connection.health ? (
        <SyncHealthPanel
          eyebrow="Connection status"
          health={connection.health}
          provider={connection.provider}
          scope="connection"
          connectionId={connection.id}
          onReauthenticated={onRefresh}
        />
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className="account-option-list">
        {connection.accounts.map(account => (
          <div key={account.id} className="account-option">
            <div>
              <strong>{account.name}</strong>
              <p className="muted">
                {account.type}
                {account.subtype ? ` / ${account.subtype}` : ""}
                {account.mask ? ` / ••${account.mask}` : ""}
              </p>
            </div>
            <div className="balance-stack">
              <div className="balance-label">Current</div>
              <div className="balance-value">{account.currentBalance?.toFixed(2) ?? "n/a"}</div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
