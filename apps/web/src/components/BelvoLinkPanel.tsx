import { useState } from "react";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { openBelvoWidget } from "../lib/belvo-widget";

function getBelvoWidgetErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") {
    return "Belvo Connect reported an error.";
  }

  if ("data" in data && Array.isArray(data.data)) {
    const first = data.data[0];
    if (first && typeof first === "object" && "last_encountered_error" in first) {
      const error = first.last_encountered_error;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        return error.message;
      }
    }
  }

  if ("message" in data && typeof data.message === "string" && data.message) {
    return data.message;
  }

  return "Belvo Connect reported an error.";
}

export function BelvoLinkPanel({
  enabled,
  onConnected
}: {
  enabled: boolean;
  onConnected: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section className="hero-panel">
      <p className="eyebrow">Belvo Connect</p>
      <h2>Launch the current Belvo widget, save the resulting link on the server, and sync the accounts from Actual.</h2>
      <p className="muted">
        The widget handles link creation and update mode in-app. The server-side Belvo SDK then refreshes accounts and
        imports transactions.
      </p>
      <div className="grid account-settings-grid">
        <label>
          <span>Connection label</span>
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
          disabled={busy || !enabled}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setMessage(null);

            try {
              const session = await api.createBelvoConnectSession();
              await openBelvoWidget(session, {
                callback: (linkId: string) => {
                  void (async () => {
                    try {
                      const result = await api.finalizeBelvoConnection(linkId, label.trim() || undefined);
                      setLabel("");
                      setMessage(result.warning ? `Belvo connection saved. ${result.warning}` : "Belvo connection saved.");
                      await onConnected();
                    } catch (connectError) {
                      setError(
                        getDisplayErrorMessage(connectError, "Failed to complete the Belvo connection.", {
                          serverUnavailableMessage: "Could not reach the API server to complete the Belvo connection."
                        })
                      );
                    } finally {
                      setBusy(false);
                    }
                  })();
                },
                onExit: data => {
                  const nextError = getBelvoWidgetErrorMessage(data);
                  if (nextError !== "Belvo Connect reported an error.") {
                    setError(nextError);
                  }
                  setBusy(false);
                },
                onEvent: data => {
                  const nextError = getBelvoWidgetErrorMessage(data);
                  if (nextError !== "Belvo Connect reported an error.") {
                    setError(nextError);
                  }
                }
              });
            } catch (connectError) {
              setBusy(false);
              setError(getDisplayErrorMessage(connectError, "Failed to launch Belvo Connect."));
            }
          }}
        >
          {busy ? "Waiting on Belvo..." : "Launch Belvo Connect"}
        </button>
      </div>
      {!enabled ? <p className="muted">Save a Belvo secret ID and secret password first.</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
    </section>
  );
}
