import type { Provider, SyncHealthDto } from "@actual-sync/shared";
import { Link } from "react-router-dom";
import { ConnectionReauthButton } from "./ConnectionReauthButton";
import { SyncHealthBadge } from "./SyncHealthBadge";
import {
  getConnectionHealthSummary,
  getProviderConnectionsLabel,
  getProviderConnectionsPath,
  getSyncHealthActionLabel,
  getSyncHealthSummary,
  supportsInlineReauth
} from "../lib/provider-ui";

export function SyncHealthPanel({
  eyebrow,
  health,
  provider,
  scope,
  connectionId,
  onReauthenticated
}: {
  eyebrow: string;
  health: SyncHealthDto;
  provider: Provider | null | undefined;
  scope: "account" | "connection";
  connectionId?: string | null;
  onReauthenticated?: () => Promise<void>;
}) {
  const path = getProviderConnectionsPath(provider);
  const label = getProviderConnectionsLabel(provider);
  const summary = scope === "account" ? getSyncHealthSummary(health) : getConnectionHealthSummary(health);

  return (
    <section className="sync-health-panel error-panel">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <SyncHealthBadge health={health} />
        <p className="error-text">
          {summary} {health.message || ""}
        </p>
      </div>
      <div className="sync-health-actions">
        {connectionId && provider && supportsInlineReauth(health, provider) ? (
          <ConnectionReauthButton
            connectionId={connectionId}
            provider={provider}
            label={getSyncHealthActionLabel(health)}
            {...(onReauthenticated ? { onCompleted: onReauthenticated } : {})}
          />
        ) : null}
        <Link className="ghost-button inline-link-button" to={path}>
          Open {label}
        </Link>
      </div>
    </section>
  );
}
