import { useEffect, useRef, useState } from "react";
import type { ConnectionReauthSessionDto, Provider } from "@actual-sync/shared";
import { usePlaidLink } from "react-plaid-link";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { closeSaltEdgeWindow, navigateSaltEdgeWindow, openSaltEdgeWindow } from "../lib/saltedge-window";
import { loadStripeFinancialConnections } from "../lib/stripe-financial-connections";
import { loadTellerConnect } from "../lib/teller-connect";

function getErrorMessage(error: unknown) {
  return getDisplayErrorMessage(error, "Reauthentication failed", {
    serverUnavailableMessage: "Could not reach the API server to complete reauthentication."
  });
}

function getStripeRelinkFailureMessage(session: {
  relink_result?: {
    failure_reason?: "no_account" | "no_authorization" | "other" | null;
  };
}) {
  switch (session.relink_result?.failure_reason) {
    case "no_account":
      return "Stripe reauthentication completed, but the expected bank account was not relinked.";
    case "no_authorization":
      return "Stripe reauthentication was not completed.";
    default:
      return "Stripe reauthentication failed.";
  }
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
  const saltEdgeWindowRef = useRef<Window | null>(null);
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
        closeSaltEdgeWindow(saltEdgeWindowRef.current);
        saltEdgeWindowRef.current = null;
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
          closeSaltEdgeWindow(saltEdgeWindowRef.current);
          saltEdgeWindowRef.current = null;
          setSaltEdgeSession(null);
          setBusy(false);
        }
      })();
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onCompleted, saltEdgeSession]);

  useEffect(() => {
    if (!saltEdgeSession) {
      return;
    }

    const interval = window.setInterval(() => {
      if (!saltEdgeWindowRef.current) {
        return;
      }

      if (!saltEdgeWindowRef.current.closed) {
        return;
      }

      saltEdgeWindowRef.current = null;
      setSaltEdgeSession(null);
      setBusy(false);
    }, 500);

    return () => window.clearInterval(interval);
  }, [saltEdgeSession]);

  useEffect(() => {
    return () => {
      closeSaltEdgeWindow(saltEdgeWindowRef.current);
      saltEdgeWindowRef.current = null;
    };
  }, []);

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
              const popup = openSaltEdgeWindow();
              if (!popup) {
                throw new Error("Salt Edge reconnect needs a popup or new tab. Allow popups and try again.");
              }

              saltEdgeWindowRef.current = popup;
              setSaltEdgeSession(session);
              navigateSaltEdgeWindow(popup, session.connectUrl);
              return;
            }

            if (session.mode === "stripe_relink") {
              const stripe = await loadStripeFinancialConnections(session.publishableKey);
              const result = await stripe.collectFinancialConnectionsAccounts({
                clientSecret: session.clientSecret
              });
              const finalSession = result.financialConnectionsSession;
              const accountIds = (finalSession?.accounts ?? []).map(account => account.id).filter(Boolean);

              if (!finalSession) {
                throw new Error("Stripe did not return a relink session result.");
              }

              if (accountIds.length === 0) {
                throw new Error(getStripeRelinkFailureMessage(finalSession));
              }

              await api.finalizeStripeReauthSession(connectionId, {
                sessionId: finalSession.id || session.sessionId,
                accountIds
              });
              await onCompleted?.();
              setBusy(false);
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
          <p className="muted">Salt Edge reauthentication is open in a separate window. Finish the provider flow there.</p>
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => {
                closeSaltEdgeWindow(saltEdgeWindowRef.current);
                saltEdgeWindowRef.current = null;
                setSaltEdgeSession(null);
                setBusy(false);
              }}
            >
              Close Salt Edge window
            </button>
          </div>
        </>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}
