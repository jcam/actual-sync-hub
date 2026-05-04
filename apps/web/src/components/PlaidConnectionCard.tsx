import type { ConnectionDto } from "@actual-sync/shared";
import { api } from "../api";

export function PlaidConnectionCard({
  connection,
  onRefresh,
  sandboxToolsEnabled
}: {
  connection: ConnectionDto;
  onRefresh: () => Promise<void>;
  sandboxToolsEnabled: boolean;
}) {
  return (
    <article className="connection-card">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Plaid item</p>
          <h3>{connection.label}</h3>
          <p className="muted">{connection.institutionName || "Institution name unavailable"}</p>
        </div>
        <button
          className="ghost-button"
          onClick={async () => {
            await api.refreshConnection(connection.id);
            await onRefresh();
          }}
        >
          Refresh accounts
        </button>
      </div>
      {sandboxToolsEnabled ? (
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={async () => {
              await api.seedPlaidSandboxTransactions(connection.id, 3);
            }}
          >
            Seed 3 sandbox transactions
          </button>
        </div>
      ) : null}
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
              <span>Current</span>
              <strong>{account.currentBalance?.toFixed(2) ?? "n/a"}</strong>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
