import { useState } from "react";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { loadStripeFinancialConnections } from "../lib/stripe-financial-connections";

export function StripeLinkPanel({
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
      <p className="eyebrow">Stripe Financial Connections</p>
      <h2>Launch Stripe’s hosted account-link flow and reuse connected bank accounts across Actual links.</h2>
      <p className="muted">
        The first pass uses Stripe Financial Connections sessions plus on-demand refresh and polling for balances and transactions.
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
              const session = await api.createStripeSession();
              const stripe = await loadStripeFinancialConnections(session.publishableKey);
              const result = await stripe.collectFinancialConnectionsAccounts({
                clientSecret: session.clientSecret
              });
              const accountIds = (result.financialConnectionsSession?.accounts ?? []).map(account => account.id).filter(Boolean);
              if (accountIds.length === 0) {
                throw new Error("Stripe did not return any linked accounts.");
              }

              await api.finalizeStripeSession({
                sessionId: result.financialConnectionsSession?.id || session.sessionId,
                accountIds,
                ...(label.trim() ? { label: label.trim() } : {})
              });
              setLabel("");
              setMessage("Stripe connection saved.");
              await onConnected();
            } catch (connectError) {
              setError(
                getDisplayErrorMessage(connectError, "Failed to complete the Stripe connection.", {
                  serverUnavailableMessage: "Could not reach the API server to complete the Stripe connection."
                })
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Connecting..." : "Launch Stripe Financial Connections"}
        </button>
      </div>
      {!enabled ? (
        <p className="muted">Save a Stripe publishable key and secret key first.</p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      {message ? <p className="success-text">{message}</p> : null}
    </section>
  );
}
