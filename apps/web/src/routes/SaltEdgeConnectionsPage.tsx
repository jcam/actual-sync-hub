import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, RuntimeInfoDto, SaltEdgeConnectSessionDto } from "@actual-sync/shared";
import { api } from "../api";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { SaltEdgeConnectionCard } from "../components/SaltEdgeConnectionCard";
import { getDisplayErrorMessage } from "../lib/errors";

type SaltEdgeMessagePayload = {
  data?: {
    stage?: string;
    api_stage?: string;
    connection_id?: string;
    secret?: string;
    error_class?: string;
    error_message?: string;
  };
};

function formatSaltEdgeError(error: unknown, fallback: string) {
  return getDisplayErrorMessage(error, fallback, {
    serverUnavailableMessage: "Could not reach the API server while loading Salt Edge state."
  });
}

export function SaltEdgeConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [activeSession, setActiveSession] = useState<SaltEdgeConnectSessionDto | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
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
      setError(formatSaltEdgeError(loadError, "Failed to load Salt Edge connections."));
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    const listener = (event: MessageEvent) => {
      if (!event.origin.includes("saltedge.com")) {
        return;
      }

      let payload: SaltEdgeMessagePayload;
      if (typeof event.data === "string") {
        try {
          payload = JSON.parse(event.data) as SaltEdgeMessagePayload;
        } catch {
          return;
        }
      } else if (typeof event.data === "object" && event.data) {
        payload = event.data as SaltEdgeMessagePayload;
      } else {
        return;
      }

      const stage = payload.data?.stage;
      if (!stage) {
        return;
      }

      if (stage === "fetching") {
        setStatusMessage(
          payload.data?.api_stage ? `Salt Edge is ${payload.data.api_stage.replaceAll("_", " ")}.` : "Salt Edge is fetching data."
        );
        return;
      }

      if (stage === "error") {
        setActiveSession(null);
        setStatusMessage(null);
        setError(payload.data?.error_message || payload.data?.error_class || "Salt Edge connect failed.");
        return;
      }

      if (stage !== "success" || !payload.data?.connection_id) {
        return;
      }

      const completedConnectionId = payload.data.connection_id;

      void (async () => {
        setFinishing(true);
        setError(null);
        setWarning(null);
        try {
          const result = await api.finalizeSaltEdgeConnection({
            connectionId: completedConnectionId,
            customerId: activeSession.customerId,
            connectionSecret: payload.data?.secret || undefined,
            label: label.trim() || undefined
          });
          setMessage("Salt Edge connection saved.");
          setWarning(result.warning || null);
          setLabel("");
          setActiveSession(null);
          setStatusMessage(null);
          await load();
        } catch (finalizeError) {
          setError(formatSaltEdgeError(finalizeError, "Failed to finalize the Salt Edge connection."));
        } finally {
          setFinishing(false);
        }
      })();
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [activeSession, label]);

  const saltEdgeConnections = useMemo(
    () => connections.filter(connection => connection.provider === "SALT_EDGE"),
    [connections]
  );
  const saltEdgeRuntime = runtime?.providers.find(provider => provider.provider === "SALT_EDGE") ?? null;

  return (
    <div className="page-stack">
      {saltEdgeRuntime ? <ProviderReadinessPanel provider={saltEdgeRuntime} /> : null}
      {runtime ? (
        <ProviderSettingsPanel
          provider="SALT_EDGE"
          label="Salt Edge"
          settings={runtime.settings.SALT_EDGE}
          onSaved={load}
        />
      ) : null}

      <section className="panel">
        <p className="eyebrow">Connect Salt Edge</p>
        <div className="status-copy">
          <p className="muted">
            Create a Salt Edge Connect session, complete the provider flow in the embedded frame, and the connection
            will be imported into the sync hub automatically when Salt Edge posts back the success payload.
          </p>
        </div>
        <div className="grid account-settings-grid">
          <label>
            <span>Label</span>
            <input
              type="text"
              value={label}
              onChange={event => setLabel(event.target.value)}
              placeholder="Optional connection label"
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={creatingSession || finishing}
            onClick={async () => {
              setCreatingSession(true);
              setMessage(null);
              setWarning(null);
              setError(null);
              setStatusMessage(null);
              try {
                const session = await api.createSaltEdgeConnectSession(label.trim() || undefined);
                setActiveSession(session);
              } catch (sessionError) {
                setActiveSession(null);
                setError(formatSaltEdgeError(sessionError, "Failed to create a Salt Edge connect session."));
              } finally {
                setCreatingSession(false);
              }
            }}
          >
            {creatingSession ? "Preparing..." : "Start Salt Edge Connect"}
          </button>
          {activeSession ? (
            <button
              className="ghost-button"
              disabled={finishing}
              onClick={() => {
                setActiveSession(null);
                setStatusMessage(null);
              }}
            >
              Close connect frame
            </button>
          ) : null}
        </div>
        {statusMessage ? <p className="muted">{statusMessage}</p> : null}
        {activeSession ? (
          <iframe
            title="Salt Edge Connect"
            src={activeSession.connectUrl}
            style={{
              width: "100%",
              minHeight: 720,
              border: 0,
              borderRadius: 18,
              marginTop: 16
            }}
          />
        ) : null}
        {message ? <p className="success-text">{message}</p> : null}
        {warning ? <p className="muted">{warning}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Salt Edge provider accounts</p>
        {runtime ? (
          <p className="muted">
            {runtime.instanceLabel}
            {` · ${runtime.saltEdge.environment}`}
            {runtime.saltEdge.includeSandboxes ? " · sandboxes enabled" : ""}
          </p>
        ) : null}
        {loading ? <p>Loading Salt Edge connections…</p> : null}
        {!loading && saltEdgeConnections.length === 0 ? (
          <p className="muted">No Salt Edge connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {saltEdgeConnections.map(connection => (
            <SaltEdgeConnectionCard key={connection.id} connection={connection} onRefresh={load} />
          ))}
        </div>
      </section>
    </div>
  );
}
