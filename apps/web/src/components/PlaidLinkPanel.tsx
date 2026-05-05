import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";

export function PlaidLinkPanel({
  onConnected,
  onRefreshAll,
  sandboxToolsEnabled
}: {
  onConnected: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
  sandboxToolsEnabled: boolean;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .createPlaidLinkToken()
      .then(result => {
        setToken(result.linkToken);
        setError(null);
      })
      .catch(loadError => {
        setError(
          getDisplayErrorMessage(loadError, "Failed to prepare Plaid Link.", {
            serverUnavailableMessage: "Could not reach the API server to prepare Plaid Link."
          })
        );
      });
  }, []);

  const plaid = usePlaidLink({
    token,
    onSuccess: async publicToken => {
      setBusy(true);
      setError(null);
      try {
        await api.exchangePlaidPublicToken(publicToken);
        await onConnected();
        const nextToken = await api.createPlaidLinkToken();
        setToken(nextToken.linkToken);
      } catch (exchangeError) {
        setError(
          getDisplayErrorMessage(exchangeError, "Failed to finish the Plaid connection.", {
            serverUnavailableMessage: "Could not reach the API server to finish the Plaid connection."
          })
        );
      } finally {
        setBusy(false);
      }
    }
  });

  return (
    <section className="hero-panel">
      <p className="eyebrow">Plaid setup</p>
      <h2>Connect institutions once, then reuse them from each Actual account.</h2>
      <p className="muted">
        Plaid connections supply reusable provider accounts. Link, schedule, and review settings stay with each Actual account.
      </p>
      <div className="button-row">
        <button className="primary-button" onClick={() => plaid.open()} disabled={!plaid.ready || busy || !token}>
          {busy ? "Finishing connection..." : "Launch Plaid Link"}
        </button>
        <button
          className="ghost-button"
          onClick={async () => {
            setRefreshing(true);
            setError(null);
            try {
              await api.refreshAllConnections();
              await onRefreshAll();
            } catch (refreshError) {
              setError(
                getDisplayErrorMessage(refreshError, "Failed to refresh Plaid connections.", {
                  serverUnavailableMessage: "Could not reach the API server to refresh Plaid connections."
                })
              );
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing Plaid..." : "Refresh all Plaid accounts"}
        </button>
        {sandboxToolsEnabled ? (
          <button
            className="ghost-button"
            onClick={async () => {
              setSeeding(true);
              setError(null);
              try {
                await api.seedPlaidSandboxConnection();
                await onConnected();
              } catch (seedError) {
                setError(
                  getDisplayErrorMessage(seedError, "Failed to seed a Plaid sandbox connection.", {
                    serverUnavailableMessage: "Could not reach the API server to seed a Plaid sandbox connection."
                  })
                );
              } finally {
                setSeeding(false);
              }
            }}
            disabled={seeding}
          >
            {seeding ? "Seeding sandbox bank..." : "Seed sandbox bank connection"}
          </button>
        ) : null}
      </div>
      {sandboxToolsEnabled ? (
        <p className="muted">Sandbox tools can create Plaid test institutions and seed transactions without opening Link.</p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
