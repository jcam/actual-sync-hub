import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto } from "@actual-sync/shared";
import { api } from "../api";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { StripeConnectionCard } from "../components/StripeConnectionCard";
import { StripeLinkPanel } from "../components/StripeLinkPanel";
import { getDisplayErrorMessage } from "../lib/errors";

export function StripeConnectionsPage() {
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
        getDisplayErrorMessage(loadError, "Failed to load Stripe connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Stripe connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const stripeConnections = useMemo(
    () => connections.filter(connection => connection.provider === "STRIPE"),
    [connections]
  );
  const stripeRuntime = runtime?.providers.find(provider => provider.provider === "STRIPE") ?? null;

  return (
    <div className="page-stack">
      {stripeRuntime ? <ProviderReadinessPanel provider={stripeRuntime} /> : null}
      {runtime ? (
        <ProviderSettingsPanel
          provider="STRIPE"
          label="Stripe"
          settings={runtime.settings.STRIPE}
          onSaved={load}
        />
      ) : null}
      <StripeLinkPanel enabled={Boolean(runtime?.stripe.enabled)} onConnected={load} />

      <section className="panel">
        <p className="eyebrow">Stripe provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel} · Stripe {runtime.stripe.environment}
          </p>
        ) : null}
        {loading ? <p>Loading Stripe connections…</p> : null}
        {!loading && error ? <p className="error-text">{error}</p> : null}
        {!loading && stripeConnections.length === 0 ? (
          <p className="muted">No Stripe connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {stripeConnections.map(connection => (
            <StripeConnectionCard key={connection.id} connection={connection} onRefresh={load} />
          ))}
        </div>
      </section>
    </div>
  );
}
