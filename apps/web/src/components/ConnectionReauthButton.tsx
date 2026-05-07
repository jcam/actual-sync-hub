import { useEffect, useState } from "react";
import type { ConnectionReauthSessionDto, Provider } from "@actual-sync/shared";
import { usePlaidLink } from "react-plaid-link";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { loadTellerConnect } from "../lib/teller-connect";

function getErrorMessage(error: unknown) {
  return getDisplayErrorMessage(error, "Reauthentication failed", {
    serverUnavailableMessage: "Could not reach the API server to complete reauthentication."
  });
}

export function ConnectionReauthButton({
  connectionId,
  provider,
  onCompleted,
  label = "Reconnect"
}: {
  connectionId: string;
  provider: Provider;
  onCompleted?: () => Promise<void>;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plaidSession, setPlaidSession] = useState<Extract<
    ConnectionReauthSessionDto,
    { mode: "plaid_update" }
  > | null>(null);
  const [saltEdgeSession, setSaltEdgeSession] = useState<Extract<
    ConnectionReauthSessionDto,
    { mode: "saltedge_connect" }
  > | null>(null);

  const plaid = usePlaidLink({
    token: plaidSession?.linkToken ?? null,
    onSuccess: () => {
      void (async () => {
        try {
          await api.refreshConnection(connectionId);
          await onCompleted?.();
        } catch (refreshError) {
          setError(getErrorMessage(refreshError));
        } finally {
          setPlaidSession(null);
          setBusy(false);
        }
      })();
    },
    onExit: error => {
      if (error) {
        const nextError =
          ("display_message" in error && typeof error.display_message === "string" && error.display_message) ||
          ("error_message" in error && typeof error.error_message === "string" && error.error_message) ||
          ("error_code" in error && typeof error.error_code === "string" && error.error_code) ||
          "Plaid reauthentication was not completed";
        setError(nextError);
      }
      setPlaidSession(null);
      setBusy(false);
    }
  });

  useEffect(() => {
    if (plaidSession && plaid.ready) {
      plaid.open();
    }
  }, [plaid.ready, plaid, plaidSession]);

  useEffect(() => {
    if (!saltEdgeSession) {
      return;
    }

    const listener = (event: MessageEvent) => {
      if (!event.origin.includes("saltedge.com")) {
        return;
      }

      let payload: {
        data?: {
          stage?: string;
          connection_id?: string;
          secret?: string;
          error_class?: string;
          error_message?: string;
        };
      };

      if (typeof event.data === "string") {
        try {
          payload = JSON.parse(event.data) as typeof payload;
        } catch {
          return;
        }
      } else if (typeof event.data === "object" && event.data) {
        payload = event.data as typeof payload;
      } else {
        return;
      }

      const stage = payload.data?.stage;
      if (!stage || stage === "fetching") {
        return;
      }

      if (stage === "error") {
        setError(payload.data?.error_message || payload.data?.error_class || "Salt Edge reauthentication failed.");
        setSaltEdgeSession(null);
        setBusy(false);
        return;
      }

      if (stage !== "success" || !payload.data?.connection_id) {
        return;
      }

      const completedConnectionId = payload.data.connection_id;

      void (async () => {
        try {
          await api.finalizeSaltEdgeConnection({
            connectionId: completedConnectionId,
            connectionSecret: payload.data?.secret || undefined
          });
          await onCompleted?.();
        } catch (refreshError) {
          setError(getErrorMessage(refreshError));
        } finally {
          setSaltEdgeSession(null);
          setBusy(false);
        }
      })();
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onCompleted, saltEdgeSession]);

  if (provider === "SIMPLEFIN" || provider === "HOME_VALUES") {
    return null;
  }

  return (
    <>
      <button
        className="ghost-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const session = await api.createConnectionReauthSession(connectionId);
            if (session.mode === "plaid_update") {
              setPlaidSession(session);
              return;
            }

            if (session.mode === "teller_repair") {
              const TellerConnect = await loadTellerConnect();
              const teller = TellerConnect.setup({
                ...session.config,
                onSuccess: () => {
                  void (async () => {
                    try {
                      await api.refreshConnection(connectionId);
                      await onCompleted?.();
                    } catch (refreshError) {
                      setError(getErrorMessage(refreshError));
                    } finally {
                      setBusy(false);
                    }
                  })();
                },
                onExit: () => {
                  setBusy(false);
                }
              });
              teller.open();
              return;
            }

            if (session.mode === "saltedge_connect") {
              setSaltEdgeSession(session);
              return;
            }

            setError(session.message);
            setBusy(false);
          } catch (sessionError) {
            setError(getErrorMessage(sessionError));
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting on provider..." : label}
      </button>
      {saltEdgeSession ? (
        <>
          <iframe
            title="Salt Edge Reconnect"
            src={saltEdgeSession.connectUrl}
            style={{
              width: "100%",
              minHeight: 720,
              border: 0,
              borderRadius: 18,
              marginTop: 12
            }}
          />
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => {
                setSaltEdgeSession(null);
                setBusy(false);
              }}
            >
              Close Salt Edge frame
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}
