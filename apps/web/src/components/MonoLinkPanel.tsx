import { useState } from "react";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { loadMonoConnect } from "../lib/mono-connect";

function getMonoWidgetErrorMessage(data: Record<string, unknown>) {
  return (
    (typeof data.errorMessage === "string" && data.errorMessage) ||
    (typeof data.errorType === "string" && data.errorType) ||
    "Mono Connect reported an error."
  );
}

export function MonoLinkPanel({
  enabled,
  publicKey,
  onConnected
}: {
  enabled: boolean;
  publicKey: string;
  onConnected: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section className="hero-panel">
      <p className="eyebrow">Mono Connect</p>
      <h2>Launch the current Mono SDK, exchange the returned code on the server, and reuse that account from Actual.</h2>
      <p className="muted">
        This adapter is wired against the current `@mono.co/connect.js` package, then synced through Mono’s Bank Data API and webhook events.
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
          disabled={busy || !enabled || !publicKey.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setMessage(null);
            try {
              const MonoConnect = await loadMonoConnect();
              const mono = new MonoConnect({
                key: publicKey,
                scope: "auth",
                onSuccess: payload => {
                  void (async () => {
                    try {
                      if (!payload.code) {
                        throw new Error("Mono Connect did not return an auth code.");
                      }

                      const result = await api.exchangeMonoCode(payload.code, label.trim() || undefined);
                      setLabel("");
                      setMessage(result.warning ? `Mono connection saved. ${result.warning}` : "Mono connection saved.");
                      await onConnected();
                    } catch (connectError) {
                      setError(
                        getDisplayErrorMessage(connectError, "Failed to complete the Mono connection.", {
                          serverUnavailableMessage: "Could not reach the API server to complete the Mono connection."
                        })
                      );
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
                    setError(getMonoWidgetErrorMessage(data));
                    setBusy(false);
                  }
                }
              });

              mono.setup();
              mono.open();
            } catch (connectError) {
              setBusy(false);
              setError(getDisplayErrorMessage(connectError, "Failed to launch Mono Connect."));
            }
          }}
        >
          {busy ? "Waiting on Mono..." : "Launch Mono Connect"}
        </button>
      </div>
      {!enabled ? <p className="muted">Save a Mono public key and secret key first.</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
    </section>
  );
}
