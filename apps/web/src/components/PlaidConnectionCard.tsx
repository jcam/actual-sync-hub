import type { ConnectionDto } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { SyncHealthPanel } from "./SyncHealthPanel";
import { SyncHealthBadge } from "./SyncHealthBadge";
import { useState } from "react";

export function PlaidConnectionCard({
  connection,
  onRefresh,
  sandboxToolsEnabled
}: {
  connection: ConnectionDto;
  onRefresh: () => Promise<void>;
  sandboxToolsEnabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <article className="connection-card">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Plaid item</p>
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
          onClick={async () => {
            setError(null);
            try {
              await api.refreshConnection(connection.id);
              await onRefresh();
            } catch (refreshError) {
              setError(
                getDisplayErrorMessage(refreshError, "Failed to refresh this Plaid connection.", {
                  serverUnavailableMessage: "Could not reach the API server to refresh this Plaid connection."
                })
              );
            }
          }}
        >
          Refresh accounts
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
      {sandboxToolsEnabled ? (
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={async () => {
              setError(null);
              try {
                await api.seedPlaidSandboxTransactions(connection.id, 3);
              } catch (seedError) {
                setError(
                  getDisplayErrorMessage(seedError, "Failed to seed Plaid sandbox transactions.", {
                    serverUnavailableMessage: "Could not reach the API server to seed Plaid sandbox transactions."
                  })
                );
              }
            }}
          >
            Seed 3 sandbox transactions
          </button>
        </div>
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
