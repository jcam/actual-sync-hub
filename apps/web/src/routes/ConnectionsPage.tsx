import { useEffect, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { PlaidConnectionCard } from "../components/PlaidConnectionCard";
import { PlaidLinkPanel } from "../components/PlaidLinkPanel";

export function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [nextConnections, nextRuntime] = await Promise.all([api.listConnections(), api.getRuntimeInfo()]);
    setConnections(nextConnections);
    setRuntime(nextRuntime);
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-stack">
      <PlaidLinkPanel
        sandboxToolsEnabled={Boolean(runtime?.plaid.sandboxToolsEnabled)}
        onConnected={async () => {
          await load();
        }}
        onRefreshAll={load}
      />

      <section className="panel">
        <p className="eyebrow">Available provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Plaid {runtime.plaid.environment}
            {runtime.liveSandboxMode ? " · live sandbox tools on" : ""}
          </p>
        ) : null}
        {loading ? <p>Loading connections…</p> : null}
        <div className="connection-grid">
          {connections.map(connection => (
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
