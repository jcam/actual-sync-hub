import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { TellerConnectionCard } from "../components/TellerConnectionCard";
import { TellerLinkPanel } from "../components/TellerLinkPanel";
import { getDisplayErrorMessage } from "../lib/errors";

export function TellerConnectionsPage() {
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
        getDisplayErrorMessage(loadError, "Failed to load Teller connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Teller connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const tellerConnections = useMemo(
    () => connections.filter(connection => connection.provider === "TELLER"),
    [connections]
  );

  return (
    <div className="page-stack">
      <TellerLinkPanel
        enabled={Boolean(runtime?.teller.enabled)}
        mtlsConfigured={Boolean(runtime?.teller.mtlsConfigured)}
        onConnected={load}
        onRefreshAll={load}
      />

      <section className="panel">
        <p className="eyebrow">Environment</p>
        <div className="status-copy">
          <p className="muted">
            Use this page to manage Teller connections, inspect discovered accounts, and check the runtime needed for
            live Teller access.
          </p>
          {runtime ? (
            <p className="muted">
              Teller {runtime.teller.environment} ·{" "}
              {runtime.teller.enabled ? "application configured" : "application not configured"} ·{" "}
              {runtime.teller.mtlsConfigured ? "mTLS material present" : "mTLS material missing"}
            </p>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Teller provider accounts</p>
        {loading ? <p>Loading Teller connections…</p> : null}
        {!loading && error ? <p className="error-text">{error}</p> : null}
        {!loading && tellerConnections.length === 0 ? (
          <p className="muted">No Teller connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {tellerConnections.map(connection => (
            <TellerConnectionCard key={connection.id} connection={connection} onRefresh={load} />
          ))}
        </div>
      </section>
    </div>
  );
}
