import { useEffect, useState } from "react";
import type { ConnectionReauthSessionDto, Provider } from "@actual-sync/shared";
import { usePlaidLink } from "react-plaid-link";
import { api } from "../api";
import { openBelvoWidget } from "../lib/belvo-widget";
import { getDisplayErrorMessage } from "../lib/errors";
import { loadMonoConnect } from "../lib/mono-connect";
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
    case undefined:
    case null:
    case "other":
      return "Stripe reauthentication failed.";
    case "no_account":
      return "Stripe reauthentication completed, but the expected bank account was not relinked.";
    case "no_authorization":
      return "Stripe reauthentication was not completed.";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plaidSession, setPlaidSession] = useState<Extract<
    ConnectionReauthSessionDto,
    { mode: "plaid_update" }
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

  if (provider === "SIMPLEFIN" || provider === "HOME_VALUES" || provider === "VEHICLE_VALUES") {
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

            if (session.mode === "mono_reauth") {
              const MonoConnect = await loadMonoConnect();
              const mono = new MonoConnect({
                key: session.config.publicKey,
                scope: "auth",
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
                onClose: () => {
                  setBusy(false);
                },
                onEvent: (eventName, data) => {
                  if (eventName === "ERROR") {
                    const nextError =
                      (typeof data.errorMessage === "string" && data.errorMessage) ||
                      (typeof data.errorType === "string" && data.errorType) ||
                      "Mono reauthentication failed.";
                    setError(nextError);
                    setBusy(false);
                  }
                }
              });
              mono.reauthorise(session.config.accountId);
              mono.open();
              return;
            }

            if (session.mode === "belvo_widget") {
              await openBelvoWidget(session.session, {
                callback: () => {
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
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}
