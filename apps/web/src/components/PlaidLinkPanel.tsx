import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { api } from "../api";

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

  useEffect(() => {
    void api.createPlaidLinkToken().then(result => setToken(result.linkToken));
  }, []);

  const plaid = usePlaidLink({
    token,
    onSuccess: async publicToken => {
      setBusy(true);
      try {
        await api.exchangePlaidPublicToken(publicToken);
        await onConnected();
        const nextToken = await api.createPlaidLinkToken();
        setToken(nextToken.linkToken);
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
        Connections populate the available provider accounts. Mapping and schedule choices stay at the Actual account level so future providers can share the same workflow.
      </p>
      <div className="button-row">
        <button className="primary-button" onClick={() => plaid.open()} disabled={!plaid.ready || busy || !token}>
          {busy ? "Finishing connection..." : "Launch Plaid Link"}
        </button>
        <button
          className="ghost-button"
          onClick={async () => {
            setRefreshing(true);
            try {
              await api.refreshAllConnections();
              await onRefreshAll();
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={refreshing}
        >
          {refreshing ? "Polling Plaid..." : "Poll all connection accounts"}
        </button>
        {sandboxToolsEnabled ? (
          <button
            className="ghost-button"
            onClick={async () => {
              setSeeding(true);
              try {
                await api.seedPlaidSandboxConnection();
                await onConnected();
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
        <p className="muted">Sandbox mode detected. Extra controls can create Plaid Sandbox Items and seed test transactions without using Link.</p>
      ) : null}
    </section>
  );
}
