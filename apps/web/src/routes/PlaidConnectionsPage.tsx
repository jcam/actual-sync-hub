import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { PlaidConnectionCard } from "../components/PlaidConnectionCard";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { getDisplayErrorMessage } from "../lib/errors";
import { PlaidLinkPanel } from "../components/PlaidLinkPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";

export function PlaidConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
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
        getDisplayErrorMessage(loadError, "Failed to load Plaid connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Plaid connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const plaidConnections = useMemo(
    () => connections.filter(connection => connection.provider === "PLAID"),
    [connections]
  );
  const plaidRuntime = runtime?.providers.find(provider => provider.provider === "PLAID") ?? null;

  return (
    <div className="page-stack">
      {plaidRuntime ? <ProviderReadinessPanel provider={plaidRuntime} /> : null}
      {runtime ? (
        <ProviderSettingsPanel
          provider="PLAID"
          label="Plaid"
          settings={runtime.settings.PLAID}
          onSaved={load}
        />
      ) : null}
      <PlaidLinkPanel
        sandboxToolsEnabled={Boolean(runtime?.plaid.sandboxToolsEnabled)}
        onConnected={load}
        onRefreshAll={load}
      />

      <section className="panel">
        <p className="eyebrow">Plaid provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Plaid {runtime.plaid.environment}
            {runtime.plaid.sandboxToolsEnabled ? " · sandbox tools enabled" : ""}
          </p>
        ) : null}
        {loading ? <p>Loading Plaid connections…</p> : null}
        {!loading && error ? <p className="error-text">{error}</p> : null}
        {!loading && plaidConnections.length === 0 ? (
          <p className="muted">No Plaid connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {plaidConnections.map(connection => (
            <PlaidConnectionCard
              key={connection.id}
              connection={connection}
              onRefresh={load}
              sandboxToolsEnabled={Boolean(runtime?.plaid.sandboxToolsEnabled)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
