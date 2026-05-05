import type { ConnectionDto } from "@actual-sync/shared";
import { SyncHealthPanel } from "./SyncHealthPanel";
import { SyncHealthBadge } from "./SyncHealthBadge";

export function TellerConnectionCard({
  connection,
  onRefresh
}: {
  connection: ConnectionDto;
  onRefresh: () => Promise<void>;
}) {
  return (
    <article className="connection-card">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Teller enrollment</p>
          <h3>{connection.label}</h3>
          <p className="muted">{connection.institutionName || "Institution name unavailable"}</p>
        </div>
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
          connectionId={connection.id}
          onReauthenticated={onRefresh}
        />
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
              <div className="balance-label">Current</div>
              <div className="balance-value">{account.currentBalance?.toFixed(2) ?? "n/a"}</div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
