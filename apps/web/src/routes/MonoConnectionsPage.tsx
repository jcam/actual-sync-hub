import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { MonoConnectionCard } from "../components/MonoConnectionCard";
import { MonoLinkPanel } from "../components/MonoLinkPanel";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { getDisplayErrorMessage } from "../lib/errors";

export function MonoConnectionsPage() {
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
        getDisplayErrorMessage(loadError, "Failed to load Mono connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Mono connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const monoConnections = useMemo(
    () => connections.filter(connection => connection.provider === "MONO"),
    [connections]
  );
  const monoRuntime = runtime?.providers.find(provider => provider.provider === "MONO") ?? null;
  const publicKey =
    runtime?.settings.MONO.environment === "sandbox"
      ? runtime.settings.MONO.sandbox.publicKey
      : runtime?.settings.MONO.production.publicKey ?? "";

  return (
    <div className="page-stack">
      {monoRuntime ? <ProviderReadinessPanel provider={monoRuntime} /> : null}
      {runtime ? (
        <ProviderSettingsPanel
          provider="MONO"
          label="Mono"
          settings={runtime.settings.MONO}
          onSaved={load}
        />
      ) : null}
      <MonoLinkPanel
        enabled={Boolean(runtime?.mono.enabled)}
        publicKey={publicKey}
        onConnected={load}
      />

      <section className="panel">
        <p className="eyebrow">Mono provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Mono {runtime.mono.environment}
          </p>
        ) : null}
        {loading ? <p>Loading Mono connections…</p> : null}
        {!loading && error ? <p className="error-text">{error}</p> : null}
        {!loading && monoConnections.length === 0 ? (
          <p className="muted">No Mono connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {monoConnections.map(connection => (
            <MonoConnectionCard key={connection.id} connection={connection} onRefresh={load} />
          ))}
        </div>
      </section>
    </div>
  );
}
