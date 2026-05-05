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

  const plaid = usePlaidLink({
    token: plaidSession?.linkToken ?? null,
    onSuccess: async () => {
      try {
        await api.refreshConnection(connectionId);
        await onCompleted?.();
      } catch (refreshError) {
        setError(getErrorMessage(refreshError));
      } finally {
        setPlaidSession(null);
        setBusy(false);
      }
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

  if (provider === "SIMPLEFIN") {
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
                onSuccess: async () => {
                  try {
                    await api.refreshConnection(connectionId);
                    await onCompleted?.();
                  } catch (refreshError) {
                    setError(getErrorMessage(refreshError));
                  } finally {
                    setBusy(false);
                  }
                },
                onExit: () => {
                  setBusy(false);
                }
              });
              teller.open();
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
