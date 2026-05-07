import { useEffect, useMemo, useState } from "react";
import type {
  ConnectionDto,
  HomeValueEstimateStateDto,
  HomeValueSource,
  RuntimeInfoDto,
  UpsertHomeValueConnectionPayload
} from "@actual-sync/shared";
import { api } from "../api";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { getDisplayErrorMessage } from "../lib/errors";

type HomeValueFormState = {
  label: string;
  address: string;
  source: HomeValueSource;
  redfinUrl: string;
  movotoUrl: string;
  homesUrl: string;
  truliaUrl: string;
};

type SourceStateKey = "redfin" | "movoto" | "homes" | "trulia";

const emptyForm: HomeValueFormState = {
  label: "",
  address: "",
  source: "AVERAGE",
  redfinUrl: "",
  movotoUrl: "",
  homesUrl: "",
  truliaUrl: ""
};

const homeValueSourceOptions: Array<{ value: HomeValueSource; label: string }> = [
  { value: "AVERAGE", label: "Average all available estimates" },
  { value: "REDFIN", label: "Redfin only" },
  { value: "MOVOTO", label: "Movoto only" },
  { value: "HOMES_COM", label: "Homes.com only" },
  { value: "TRULIA", label: "Trulia only" }
];

function getHomeValueSourceOptions(selectedSource?: HomeValueSource) {
  void selectedSource;
  return homeValueSourceOptions;
}

function formatSourceLabel(source: HomeValueSource) {
  return getHomeValueSourceOptions(source).find(option => option.value === source)?.label ?? source;
}

function normalizeOptionalUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function normalizeFormState(form: HomeValueFormState): HomeValueFormState {
  return {
    ...form,
    label: form.label.trim(),
    address: form.address.trim(),
    redfinUrl: normalizeOptionalUrl(form.redfinUrl),
    movotoUrl: normalizeOptionalUrl(form.movotoUrl),
    homesUrl: normalizeOptionalUrl(form.homesUrl),
    truliaUrl: normalizeOptionalUrl(form.truliaUrl)
  };
}

function validatePropertyUrl(url: string, hostSuffix: string, label: string) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(hostSuffix)) {
      return `${label} URL must point to ${hostSuffix}.`;
    }
    return null;
  } catch {
    return `${label} URL must be a valid ${label} property page URL.`;
  }
}

function validateForm(form: HomeValueFormState) {
  if (!form.address) {
    return "Address is required.";
  }

  const validations = [
    validatePropertyUrl(form.redfinUrl, "redfin.com", "Redfin"),
    validatePropertyUrl(form.movotoUrl, "movoto.com", "Movoto"),
    validatePropertyUrl(form.homesUrl, "homes.com", "Homes.com"),
    validatePropertyUrl(form.truliaUrl, "trulia.com", "Trulia")
  ].filter((message): message is string => Boolean(message));

  if (validations.length > 0) {
    return validations[0];
  }

  if (form.source === "AVERAGE") {
    if (!form.redfinUrl && !form.movotoUrl && !form.homesUrl && !form.truliaUrl) {
      return "At least one property URL is required when Average all available estimates is the selected source.";
    }
    return null;
  }

  if (form.source === "REDFIN" && !form.redfinUrl) {
    return "Redfin URL is required when Redfin is the selected source.";
  }
  if (form.source === "MOVOTO" && !form.movotoUrl) {
    return "Movoto URL is required when Movoto is the selected source.";
  }
  if (form.source === "HOMES_COM" && !form.homesUrl) {
    return "Homes.com URL is required when Homes.com is the selected source.";
  }
  if (form.source === "TRULIA" && !form.truliaUrl) {
    return "Trulia URL is required when Trulia is the selected source.";
  }

  return null;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "Not available";
}

function toFormState(connection: ConnectionDto): HomeValueFormState {
  return {
    label: connection.label,
    address: connection.homeValues?.address ?? "",
    source: connection.homeValues?.source ?? "AVERAGE",
    redfinUrl: connection.homeValues?.redfinUrl ?? "",
    movotoUrl: connection.homeValues?.movotoUrl ?? "",
    homesUrl: connection.homeValues?.homesUrl ?? "",
    truliaUrl: connection.homeValues?.truliaUrl ?? ""
  };
}

function toPayload(form: HomeValueFormState): UpsertHomeValueConnectionPayload {
  return {
    label: form.label.trim() || null,
    address: form.address.trim(),
    source: form.source,
    redfinEstimate: null,
    redfinUrl: form.redfinUrl.trim() || null,
    movotoEstimate: null,
    movotoUrl: form.movotoUrl.trim() || null,
    homesEstimate: null,
    homesUrl: form.homesUrl.trim() || null,
    truliaEstimate: null,
    truliaUrl: form.truliaUrl.trim() || null
  };
}

function renderEstimateLine(
  label: string,
  sourceState: HomeValueEstimateStateDto | null | undefined,
  fallbackValue: number | null | undefined
) {
  const amount = sourceState?.estimate ?? fallbackValue;

  return (
    <div>
      <p className="muted">
        {label}: {amount == null ? "fetched after save" : formatMoney(amount)}
      </p>
      {sourceState?.usingCachedEstimate ? (
        <p className="error-text">{label} is using the last stored value after a failed scheduled refresh.</p>
      ) : null}
      {sourceState?.stale ? <p className="error-text">{label} has not refreshed successfully in over two weeks.</p> : null}
      {sourceState?.lastFailureMessage ? <p className="error-text">{label} warning: {sourceState.lastFailureMessage}</p> : null}
    </div>
  );
}

function renderConnectionSourceState(connection: ConnectionDto, sourceKey: SourceStateKey) {
  const state = connection.homeValues?.sources?.[sourceKey];
  const label =
    sourceKey === "redfin"
      ? "Redfin estimate"
      : sourceKey === "movoto"
        ? "Movoto estimate"
        : sourceKey === "homes"
          ? "Homes.com estimate"
          : "Trulia estimate";
  const fallbackValue =
    sourceKey === "redfin"
      ? connection.homeValues?.redfinEstimate
      : sourceKey === "movoto"
        ? connection.homeValues?.movotoEstimate
        : sourceKey === "homes"
          ? connection.homeValues?.homesEstimate
          : connection.homeValues?.truliaEstimate;

  return renderEstimateLine(label, state, fallbackValue);
}

export function HomeValuesConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [form, setForm] = useState<HomeValueFormState>(emptyForm);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [nextConnections, nextRuntime] = await Promise.all([api.listConnections(), api.getRuntimeInfo()]);
      setConnections(nextConnections);
      setRuntime(nextRuntime);
      setError(null);
    } catch (loadError) {
      setConnections([]);
      setRuntime(null);
      setError(
        getDisplayErrorMessage(loadError, "Failed to load Home Values connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Home Values connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const homeValueConnections = useMemo(
    () => connections.filter(connection => connection.provider === "HOME_VALUES"),
    [connections]
  );
  const runtimeProvider = runtime?.providers.find(provider => provider.provider === "HOME_VALUES") ?? null;
  const sourceOptions = getHomeValueSourceOptions(form.source);
  const editingConnection = useMemo(
    () => homeValueConnections.find(connection => connection.id === editingConnectionId) ?? null,
    [editingConnectionId, homeValueConnections]
  );

  const resetForm = () => {
    setEditingConnectionId(null);
    setForm(emptyForm);
  };

  const formDetails = editingConnection?.homeValues ?? null;

  return (
    <div className="page-stack">
      {runtimeProvider ? <ProviderReadinessPanel provider={runtimeProvider} /> : null}
      {runtime?.settings.HOME_VALUES ? (
        <ProviderSettingsPanel
          provider="HOME_VALUES"
          label="Home Values"
          settings={runtime.settings.HOME_VALUES}
          onSaved={load}
        />
      ) : null}

      <section className="panel">
        <p className="eyebrow">Home Values</p>
        <h3>{editingConnection ? "Edit saved property" : "Add a property"}</h3>
        <p className="muted">
          Paste property URLs for Redfin, Movoto, Homes.com, or Trulia and the sync hub will fetch current estimates, map the
          result to an off-budget asset account in Actual, and spread automatic refreshes across the week.
        </p>
        <div className="grid provider-settings-grid">
          <label>
            <span>Label</span>
            <input
              value={form.label}
              onChange={event => setForm(current => ({ ...current, label: event.target.value }))}
              placeholder="Primary residence"
            />
          </label>

          <label>
            <span>Address</span>
            <input
              value={form.address}
              onChange={event => setForm(current => ({ ...current, address: event.target.value }))}
              placeholder="123 Main St, Springfield, IL"
            />
          </label>

          <label>
            <span>Source</span>
            <select
              value={form.source}
              onChange={event => setForm(current => ({ ...current, source: event.target.value as HomeValueSource }))}
            >
              {sourceOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Redfin URL</span>
            <input
              value={form.redfinUrl}
              onChange={event => setForm(current => ({ ...current, redfinUrl: event.target.value }))}
              placeholder="https://www.redfin.com/..."
            />
          </label>
          {renderEstimateLine("Redfin estimate", formDetails?.sources?.redfin, formDetails?.redfinEstimate)}

          <label>
            <span>Movoto URL</span>
            <input
              value={form.movotoUrl}
              onChange={event => setForm(current => ({ ...current, movotoUrl: event.target.value }))}
              placeholder="https://www.movoto.com/..."
            />
          </label>
          {renderEstimateLine("Movoto estimate", formDetails?.sources?.movoto, formDetails?.movotoEstimate)}

          <label>
            <span>Homes.com URL</span>
            <input
              value={form.homesUrl}
              onChange={event => setForm(current => ({ ...current, homesUrl: event.target.value }))}
              placeholder="https://www.homes.com/..."
            />
          </label>
          {renderEstimateLine("Homes.com estimate", formDetails?.sources?.homes, formDetails?.homesEstimate)}

          <label>
            <span>Trulia URL</span>
            <input
              value={form.truliaUrl}
              onChange={event => setForm(current => ({ ...current, truliaUrl: event.target.value }))}
              placeholder="https://www.trulia.com/..."
            />
          </label>
          {renderEstimateLine("Trulia estimate", formDetails?.sources?.trulia, formDetails?.truliaEstimate)}
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={saving}
            onClick={async () => {
              const normalizedForm = normalizeFormState(form);
              setForm(normalizedForm);
              const validationMessage = validateForm(normalizedForm);
              if (validationMessage) {
                setError(validationMessage);
                return;
              }

              setSaving(true);
              setError(null);
              try {
                if (editingConnection) {
                  await api.updateHomeValueConnection(editingConnection.id, toPayload(normalizedForm));
                } else {
                  await api.createHomeValueConnection(toPayload(normalizedForm));
                }
                resetForm();
                await load();
              } catch (saveError) {
                setError(
                  getDisplayErrorMessage(
                    saveError,
                    editingConnection
                      ? "Failed to save this home value connection."
                      : "Failed to create this home value connection.",
                    {
                      serverUnavailableMessage: editingConnection
                        ? "Could not reach the API server to save this home value connection."
                        : "Could not reach the API server to create this home value connection."
                    }
                  )
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? (editingConnection ? "Saving..." : "Creating...") : editingConnection ? "Save property" : "Add property"}
          </button>
          {editingConnection ? (
            <button
              className="ghost-button"
              disabled={saving}
              onClick={() => {
                setError(null);
                resetForm();
              }}
            >
              Cancel edit
            </button>
          ) : null}
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Saved properties</p>
        {loading ? <p>Loading Home Values connections…</p> : null}
        {!loading && homeValueConnections.length === 0 ? <p className="muted">No home value connections have been added.</p> : null}
        <div className="connection-grid">
          {homeValueConnections.map(connection => {
            const currentValue = connection.homeValues?.calculatedValue ?? connection.accounts[0]?.currentBalance ?? null;
            const isBusy = busyConnectionId === connection.id;

            return (
              <article key={connection.id} className="list-card">
                <div className="connection-head">
                  <div>
                    <p className="eyebrow">Property</p>
                    <h3>{connection.label}</h3>
                    <p className="muted">{connection.homeValues?.address ?? "No address saved"}</p>
                    <p className="muted">
                      {formatSourceLabel(connection.homeValues?.source ?? "AVERAGE")}
                      {currentValue != null ? ` · applied value ${formatMoney(currentValue)}` : ""}
                    </p>
                    {connection.homeValues?.lastCalculatedAt ? (
                      <p className="muted">Last calculated: {new Date(connection.homeValues.lastCalculatedAt).toLocaleString()}</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid provider-settings-grid">
                  {renderConnectionSourceState(connection, "redfin")}
                  {renderConnectionSourceState(connection, "movoto")}
                  {renderConnectionSourceState(connection, "homes")}
                  {renderConnectionSourceState(connection, "trulia")}
                </div>

                <div className="button-row">
                  <button
                    className="primary-button"
                    onClick={() => {
                      setEditingConnectionId(connection.id);
                      setForm(toFormState(connection));
                      setError(null);
                    }}
                  >
                    Edit property
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isBusy}
                    onClick={async () => {
                      setBusyConnectionId(connection.id);
                      setError(null);
                      try {
                        await api.refreshConnection(connection.id);
                        await load();
                      } catch (refreshError) {
                        setError(
                          getDisplayErrorMessage(refreshError, "Failed to recalculate this home value connection.", {
                            serverUnavailableMessage: "Could not reach the API server to recalculate this home value connection."
                          })
                        );
                      } finally {
                        setBusyConnectionId(null);
                      }
                    }}
                  >
                    {isBusy ? "Recalculating..." : "Recalculate"}
                  </button>
                  <button
                    className="ghost-button"
                    disabled={isBusy}
                    onClick={async () => {
                      setBusyConnectionId(connection.id);
                      setError(null);
                      try {
                        await api.disconnectConnection(connection.id);
                        if (editingConnectionId === connection.id) {
                          resetForm();
                        }
                        await load();
                      } catch (disconnectError) {
                        setError(
                          getDisplayErrorMessage(disconnectError, "Failed to disconnect this home value connection.", {
                            serverUnavailableMessage: "Could not reach the API server to disconnect this home value connection."
                          })
                        );
                      } finally {
                        setBusyConnectionId(null);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
