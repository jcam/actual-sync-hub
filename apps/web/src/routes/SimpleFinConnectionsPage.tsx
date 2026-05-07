import { useEffect, useMemo, useState } from "react";
import type { ActualBankSyncLinkDto, ConnectionDto, RuntimeInfoDto, SyncHealthDto } from "@actual-sync/shared";
import { api } from "../api";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { SyncHealthBadge } from "../components/SyncHealthBadge";
import { getDisplayErrorMessage } from "../lib/errors";

function formatImportSummary(summary: {
  imported: number;
  updated: number;
  skipped: number;
  unmatched: number;
}) {
  return `Imported ${summary.imported}, refreshed ${summary.updated}, skipped ${summary.skipped}, unmatched ${summary.unmatched}.`;
}

function formatSimpleFinPageError(error: unknown, fallback: string) {
  const message = getDisplayErrorMessage(error, fallback, {
    serverUnavailableMessage: "Could not reach the API server while loading SimpleFIN state."
  });
  const normalized = message.toLowerCase();

  if (normalized.includes("could not get remote files")) {
    return "Failed to reach the connected Actual budget while loading SimpleFIN state.";
  }

  return message || fallback;
}

function normalizeSimpleFinGroupKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function parseSimpleFinConnectionWarnings(health: SyncHealthDto | null | undefined) {
  if (!health?.message) {
    return {
      byName: new Map<string, string>(),
      unmatched: [] as string[]
    };
  }

  const byName = new Map<string, string>();
  const pattern = /Connection to (.+?) may need attention\.\s*([\s\S]*?)(?=Connection to .+? may need attention\.|$)/g;
  const matches = [...health.message.matchAll(pattern)];

  if (matches.length === 0) {
    return {
      byName,
      unmatched: [health.message]
    };
  }

  for (const match of matches) {
    const name = match[1]?.trim();
    if (!name) {
      continue;
    }

    const detail = match[2]?.trim();
    byName.set(
      normalizeSimpleFinGroupKey(name),
      detail ? `Connection to ${name} may need attention. ${detail}` : `Connection to ${name} may need attention.`
    );
  }

  return {
    byName,
    unmatched: [] as string[]
  };
}

export function SimpleFinConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [bankSyncLinks, setBankSyncLinks] = useState<ActualBankSyncLinkDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupToken, setSetupToken] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reusingCached, setReusingCached] = useState(false);
  const [refreshingConnectionId, setRefreshingConnectionId] = useState<string | null>(null);
  const [importingConnectionId, setImportingConnectionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [bankSyncLinksError, setBankSyncLinksError] = useState<string | null>(null);

  const load = async () => {
    const [connectionsResult, bankSyncLinksResult, runtimeResult] = await Promise.allSettled([
      api.listConnections(),
      api.listActualBankSyncLinks(),
      api.getRuntimeInfo()
    ]);

    if (connectionsResult.status === "fulfilled") {
      setConnections(connectionsResult.value);
      setConnectionsError(null);
    } else {
      setConnections([]);
      setConnectionsError(
        formatSimpleFinPageError(
          connectionsResult.reason,
          "Failed to load app-managed SimpleFIN connections."
        )
      );
    }

    if (bankSyncLinksResult.status === "fulfilled") {
      setBankSyncLinks(bankSyncLinksResult.value);
      setBankSyncLinksError(null);
    } else {
      setBankSyncLinks([]);
      setBankSyncLinksError(
        formatSimpleFinPageError(
          bankSyncLinksResult.reason,
          "Failed to inspect existing SimpleFIN-linked accounts from Actual."
        )
      );
    }

    if (runtimeResult?.status === "fulfilled") {
      setRuntime(runtimeResult.value);
    } else {
      setRuntime(null);
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const simplefinConnections = useMemo(
    () => connections.filter(connection => connection.provider === "SIMPLEFIN"),
    [connections]
  );
  const groupedSimpleFinConnections = useMemo(
    () =>
      simplefinConnections.map(connection => {
        const groups = new Map<
          string,
          {
            connectionIds: string[];
            connectionNames: string[];
            institutionName: string | null;
            accounts: typeof connection.accounts;
          }
        >();

        for (const account of connection.accounts) {
          const key =
            account.providerInstitutionName ||
            account.providerConnectionId ||
            account.providerConnectionName ||
            "__unscoped__";
          const existing = groups.get(key);
          if (existing) {
            if (
              account.providerConnectionId &&
              !existing.connectionIds.includes(account.providerConnectionId)
            ) {
              existing.connectionIds.push(account.providerConnectionId);
            }
            if (
              account.providerConnectionName &&
              !existing.connectionNames.includes(account.providerConnectionName)
            ) {
              existing.connectionNames.push(account.providerConnectionName);
            }
            existing.accounts.push(account);
            continue;
          }
          groups.set(key, {
            connectionIds: account.providerConnectionId ? [account.providerConnectionId] : [],
            connectionNames: account.providerConnectionName ? [account.providerConnectionName] : [],
            institutionName: account.providerInstitutionName ?? null,
            accounts: [account]
          });
        }

        const providerConnections = [...groups.values()];
        const parsedWarnings = parseSimpleFinConnectionWarnings(connection.health);
        const rows = providerConnections.map(group => {
          const institutionWarning = group.institutionName
            ? parsedWarnings.byName.get(normalizeSimpleFinGroupKey(group.institutionName)) ?? null
            : null;
          const matchedConnectionName = group.connectionNames.find(name =>
            parsedWarnings.byName.has(normalizeSimpleFinGroupKey(name))
          );
          const connectionWarning = matchedConnectionName
            ? parsedWarnings.byName.get(normalizeSimpleFinGroupKey(matchedConnectionName)) ?? null
            : null;
          const matchedWarning = institutionWarning || connectionWarning;
          const health =
            matchedWarning && connection.health
              ? {
                  ...connection.health,
                  message: matchedWarning
                }
              : !matchedWarning && providerConnections.length === 1 && parsedWarnings.unmatched.length > 0 && connection.health
                ? connection.health
                : null;

          return {
            ...group,
            health
          };
        });

        return {
          connection,
          providerConnections: rows,
          unmatchedWarnings:
            rows.some(group => group.health) || parsedWarnings.unmatched.length === 0 ? [] : parsedWarnings.unmatched
        };
      }),
    [simplefinConnections]
  );
  const simplefinBudgetLinks = useMemo(
    () => bankSyncLinks.filter(link => link.accountSyncSource === "simpleFin"),
    [bankSyncLinks]
  );
  const simplefinRuntime = runtime?.providers.find(provider => provider.provider === "SIMPLEFIN") ?? {
    provider: "SIMPLEFIN" as const,
    label: "SimpleFIN",
    enabled: true,
    ready: true,
    environment: null,
    issues: [],
    notes: ["Each SimpleFIN connection is created from a one-time setup token."]
  };

  return (
    <div className="page-stack">
      <ProviderReadinessPanel provider={simplefinRuntime} />
      {runtime ? (
        <ProviderSettingsPanel
          provider="SIMPLEFIN"
          label="SimpleFIN"
          settings={runtime.settings.SIMPLEFIN}
          onSaved={load}
        />
      ) : null}
      <section className="panel">
        <p className="eyebrow">Connect SimpleFIN</p>
        <div className="status-copy">
          <p className="muted">
            Enter a one-time SimpleFIN setup token to create a managed SimpleFIN connection. After the connection is
            loaded, you can import matching native Actual <code>simpleFin</code> account links into this app.
          </p>
        </div>
        <div className="grid account-settings-grid">
          <label className="wide-field">
            <span>Setup token</span>
            <textarea
              rows={3}
              value={setupToken}
              onChange={event => setSetupToken(event.target.value)}
              placeholder="Paste the one-time SimpleFIN setup token"
            />
          </label>
          <label>
            <span>Label</span>
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
            disabled={submitting || setupToken.trim().length === 0}
            onClick={async () => {
              const normalizedSetupToken = setupToken.trim();
              const normalizedLabel = label.trim();
              if (!normalizedSetupToken) {
                setError("Setup token is required.");
                setMessage(null);
                setWarning(null);
                return;
              }

              setSubmitting(true);
              setError(null);
              setMessage(null);
              setWarning(null);
              try {
                const result = await api.connectSimpleFin(normalizedSetupToken, normalizedLabel || undefined);
                setSetupToken("");
                setLabel("");
                setMessage("SimpleFIN connection saved.");
                if (result.warning) {
                  setWarning("Connections may need attention. Review the managed connections below.");
                }
                await load();
              } catch (connectError) {
                setError(
                  formatSimpleFinPageError(
                    connectError,
                    "Failed to connect SimpleFIN. The setup token may be invalid or expired."
                  )
                );
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Connecting..." : "Connect SimpleFIN"}
          </button>
          <button
            className="ghost-button"
            disabled={reusingCached}
            onClick={async () => {
              setReusingCached(true);
              setError(null);
              setMessage(null);
              setWarning(null);
              try {
                const result = await api.reuseCachedSimpleFinConnection(label.trim() || undefined);
                setLabel("");
                setMessage("Reused cached SimpleFIN fixture.");
                if (result.warning) {
                  setWarning("Connections may need attention. Review the managed connections below.");
                }
                await load();
              } catch (reuseError) {
                setError(
                  formatSimpleFinPageError(
                    reuseError,
                    "Failed to reuse the cached SimpleFIN fixture."
                  )
                );
              } finally {
                setReusingCached(false);
              }
            }}
          >
            {reusingCached ? "Reusing fixture..." : "Reuse cached SimpleFIN fixture"}
          </button>
        </div>
        <p className="muted">When provider fixture caching is enabled, you can reuse the most recent SimpleFIN credentials instead of pasting a new setup token.</p>
        {message ? <p className="success-text">{message}</p> : null}
        {warning ? <p className="warning-text">{warning}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Existing Actual SimpleFIN links</p>
        {loading ? <p>Loading SimpleFIN-linked Actual accounts…</p> : null}
        {!loading && bankSyncLinksError ? <p className="error-text">{bankSyncLinksError}</p> : null}
        {!loading && simplefinBudgetLinks.length === 0 ? (
          <p className="muted">No existing SimpleFIN-linked accounts were detected in the current Actual budget.</p>
        ) : null}
        <div className="stack-list">
          {simplefinBudgetLinks.map(link => (
            <article key={link.actualAccountId} className="list-card">
              <div className="list-card-header">
                <div>
                  <strong>{link.actualAccountName}</strong>
                  {link.actualOfficialName ? <p className="muted">{link.actualOfficialName}</p> : null}
                </div>
                {link.currentLinkProvider ? <span className="tag">Managed here via {link.currentLinkProvider}</span> : null}
              </div>
              <div className="list-card-meta">
                <span>External account: {link.externalAccountId}</span>
                <span>Native sync source: {link.accountSyncSource}</span>
                <span>{link.actualBankName ? `Actual bank: ${link.actualBankName}` : "Actual bank: not recorded"}</span>
                <span>{link.actualBankExternalId ? `Bank external id: ${link.actualBankExternalId}` : "Bank external id: not recorded"}</span>
                <span>{link.mask ? `Mask: ••${link.mask}` : "Mask: not recorded"}</span>
                <span>
                  {typeof link.balanceCurrent === "number" ? `Current balance ${link.balanceCurrent.toFixed(2)}` : "Current balance: not recorded"}
                </span>
                <span>{link.lastSyncedAt ? `Last synced ${link.lastSyncedAt}` : "Last synced: not recorded"}</span>
                <span>{link.currentLinkStatus ? `Current local link: ${link.currentLinkStatus}` : "Current local link: none"}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Managed SimpleFIN connections</p>
        {loading ? <p>Loading SimpleFIN connections…</p> : null}
        {!loading && connectionsError ? <p className="error-text">{connectionsError}</p> : null}
        {!loading && simplefinConnections.length === 0 ? (
          <p className="muted">No SimpleFIN connections have been added.</p>
        ) : null}
        <div className="stack-list">
          {groupedSimpleFinConnections.map(({ connection, providerConnections, unmatchedWarnings }) => (
            <article key={connection.id} className="list-card">
              <div className="list-card-header">
                <strong>{connection.label}</strong>
                <div className="status-row">
                  {connection.providerAccountsUrl ? (
                    <a
                      className="ghost-button inline-link-button"
                      href={connection.providerAccountsUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open SimpleFIN accounts
                    </a>
                  ) : null}
                  <span className="tag">{connection.status}</span>
                  {connection.health ? <SyncHealthBadge health={connection.health} compact /> : null}
                </div>
              </div>
              <div className="list-card-meta">
                <span>{connection.institutionName || "SimpleFIN"}</span>
                <span>{connection.accounts.length} provider account{connection.accounts.length === 1 ? "" : "s"}</span>
                <span>{providerConnections.length} provider institution{providerConnections.length === 1 ? "" : "s"}</span>
              </div>
              {connection.health ? (
                <p className="muted">Review the provider connection rows below for current status.</p>
              ) : null}
              {providerConnections.length > 0 ? (
                <div className="stack-list">
                  {providerConnections.map(group => (
                    <div
                      key={group.institutionName || group.connectionIds.join("|") || group.connectionNames.join("|") || "unscoped"}
                      className="list-card simplefin-provider-row"
                    >
                      <div className="list-card-header">
                        <div>
                          <strong>{group.institutionName || group.connectionNames[0] || "Provider institution"}</strong>
                          {group.connectionNames.length > 0 ? (
                            <p className="muted">
                              Connection{group.connectionNames.length === 1 ? "" : "s"}: {group.connectionNames.join(", ")}
                            </p>
                          ) : null}
                          {group.connectionIds.length > 0 ? (
                            <p className="muted">
                              Connection id{group.connectionIds.length === 1 ? "" : "s"}: {group.connectionIds.join(", ")}
                            </p>
                          ) : null}
                        </div>
                        <div className="status-row">
                          {group.health ? <SyncHealthBadge health={group.health} compact /> : <span className="tag success-tag">Healthy</span>}
                        </div>
                      </div>
                      {group.health?.message ? <p className="warning-text">{group.health.message}</p> : null}
                      <div className="simplefin-provider-accounts">
                        {group.accounts.map(account => (
                          <div key={account.id} className="simplefin-provider-account">
                            <strong>{account.name}</strong>
                            {account.externalAccountId ? <span className="muted">{account.externalAccountId}</span> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {unmatchedWarnings.length > 0 ? (
                <div className="list-card">
                  <p className="eyebrow">Connection note</p>
                  {unmatchedWarnings.map(messageText => (
                    <p key={messageText} className="warning-text">
                      {messageText}
                    </p>
                  ))}
                </div>
              ) : null}
              <div className="button-row">
                <button
                  className="ghost-button"
                  disabled={refreshingConnectionId === connection.id}
                  onClick={async () => {
                    setRefreshingConnectionId(connection.id);
                    setError(null);
                    setMessage(null);
                    try {
                      await api.refreshConnection(connection.id);
                      setMessage(`Refreshed ${connection.label}.`);
                      await load();
                    } catch (refreshError) {
                      setError(
                        formatSimpleFinPageError(
                          refreshError,
                          "Failed to refresh this SimpleFIN connection."
                        )
                      );
                    } finally {
                      setRefreshingConnectionId(null);
                    }
                  }}
                >
                  {refreshingConnectionId === connection.id ? "Refreshing..." : "Refresh accounts"}
                </button>
                <button
                  className="ghost-button"
                  onClick={async () => {
                    setError(null);
                    setMessage(null);
                    try {
                      await api.disconnectConnection(connection.id);
                      setMessage(`Disconnected ${connection.label}.`);
                      await load();
                    } catch (disconnectError) {
                      setError(formatSimpleFinPageError(disconnectError, "Failed to disconnect this SimpleFIN connection."));
                    }
                  }}
                >
                  Disconnect
                </button>
                <button
                  className="primary-button"
                  disabled={importingConnectionId === connection.id}
                  onClick={async () => {
                    setImportingConnectionId(connection.id);
                    setError(null);
                    setMessage(null);
                    try {
                      const summary = await api.importExistingSimpleFinLinks(connection.id);
                      setMessage(formatImportSummary(summary));
                      await load();
                    } catch (importError) {
                      setError(
                        formatSimpleFinPageError(
                          importError,
                          "Failed to import matching Actual SimpleFIN links."
                        )
                      );
                    } finally {
                      setImportingConnectionId(null);
                    }
                  }}
                >
                  {importingConnectionId === connection.id ? "Importing..." : "Import matching Actual links"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
