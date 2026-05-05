import { useEffect, useState } from "react";
import type { TellerConnectConfigDto } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { loadTellerConnect } from "../lib/teller-connect";

export function TellerLinkPanel({
  enabled,
  mtlsConfigured,
  onConnected,
  onRefreshAll
}: {
  enabled: boolean;
  mtlsConfigured: boolean;
  onConnected: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
}) {
  const [config, setConfig] = useState<TellerConnectConfigDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [reusingCached, setReusingCached] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setConfig(null);
      return;
    }

    void api
      .getTellerConnectConfig()
      .then(nextConfig => {
        setConfig(nextConfig);
        setError(null);
      })
      .catch(err => {
        setError(
          getDisplayErrorMessage(err, "Failed to load Teller Connect.", {
            serverUnavailableMessage: "Could not reach the API server to load Teller Connect."
          })
        );
      });
  }, [enabled]);

  const launch = async () => {
    if (!config) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const TellerConnect = await loadTellerConnect();
      const teller = TellerConnect.setup({
        ...config,
        onSuccess: async enrollment => {
          try {
            await api.enrollTellerConnection({
              accessToken: enrollment.accessToken,
              enrollmentId: enrollment.enrollment?.id || "",
              userId: enrollment.user?.id || null,
              institutionName: enrollment.enrollment?.institution?.name || null
            });
            await onConnected();
          } catch (err) {
            setError(
              getDisplayErrorMessage(err, "Failed to persist Teller enrollment.", {
                serverUnavailableMessage: "Could not reach the API server to save the Teller enrollment."
              })
            );
          } finally {
            setBusy(false);
          }
        },
        onExit: () => {
          setBusy(false);
        }
      });

      teller.open();
    } catch (err) {
      setBusy(false);
      setError(getDisplayErrorMessage(err, "Failed to launch Teller Connect."));
    }
  };

  return (
    <section className="hero-panel">
      <p className="eyebrow">Teller.io setup</p>
      <h2>Enroll bank access through Teller Connect, then reuse those accounts from Actual.</h2>
      <p className="muted">
        Teller enrollments supply reusable provider accounts. Link, schedule, and review settings stay with each
        Actual account.
      </p>
      <div className="button-row">
        <button className="primary-button" onClick={() => void launch()} disabled={!enabled || !config || busy}>
          {busy ? "Waiting on Teller..." : "Launch Teller Connect"}
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
          {refreshing ? "Refreshing accounts..." : "Refresh connected accounts"}
        </button>
        {config?.environment === "sandbox" ? (
          <button
            className="ghost-button"
            onClick={async () => {
              setSeeding(true);
              setError(null);
              try {
                await api.seedTellerSandboxConnection();
                await onConnected();
              } catch (err) {
                setError(
                  getDisplayErrorMessage(err, "Failed to seed Teller sandbox connection.", {
                    serverUnavailableMessage: "Could not reach the API server to seed a Teller sandbox connection."
                  })
                );
              } finally {
                setSeeding(false);
              }
            }}
            disabled={seeding}
          >
            {seeding ? "Seeding Teller sandbox..." : "Seed Teller sandbox connection"}
          </button>
        ) : null}
        <button
          className="ghost-button"
          onClick={async () => {
            setReusingCached(true);
            setError(null);
            try {
              await api.reuseCachedTellerConnection();
              await onConnected();
            } catch (err) {
              setError(
                getDisplayErrorMessage(err, "Failed to reuse cached Teller fixture.", {
                  serverUnavailableMessage: "Could not reach the API server to reuse a cached Teller fixture."
                })
              );
            } finally {
              setReusingCached(false);
            }
          }}
          disabled={reusingCached}
        >
          {reusingCached ? "Reusing fixture..." : "Reuse cached Teller fixture"}
        </button>
      </div>
      {!enabled ? <p className="muted">Set `TELLER_APP_ID` to enable Teller Connect.</p> : null}
      {enabled && !mtlsConfigured && config?.environment !== "sandbox" ? (
        <p className="muted">Development and production Teller API calls require `TELLER_CERT_FILE` and `TELLER_KEY_FILE`.</p>
      ) : null}
      {config?.environment === "sandbox" ? (
        <p className="muted">Sandbox tools can seed a Teller test enrollment directly without opening the Connect iframe.</p>
      ) : null}
      <p className="muted">When provider fixture caching is enabled, you can reuse the most recent Teller enrollment without opening Connect again.</p>
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
