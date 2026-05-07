import { useEffect, useMemo, useState } from "react";
import type { ConnectionDto, HomeValueSource, RuntimeInfoDto, UpsertHomeValueConnectionPayload } from "@actual-sync/shared";
import { api } from "../api";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { getDisplayErrorMessage } from "../lib/errors";

type HomeValueFormState = {
  label: string;
  address: string;
  source: HomeValueSource;
  redfinEstimate: string;
  redfinUrl: string;
  zillowEstimate: string;
  zillowUrl: string;
};

const emptyForm: HomeValueFormState = {
  label: "",
  address: "",
  source: "AVERAGE",
  redfinEstimate: "",
  redfinUrl: "",
  zillowEstimate: "",
  zillowUrl: ""
};

function toFormState(connection: ConnectionDto): HomeValueFormState {
  return {
    label: connection.label,
    address: connection.homeValues?.address ?? "",
    source: connection.homeValues?.source ?? "AVERAGE",
    redfinEstimate:
      typeof connection.homeValues?.redfinEstimate === "number" ? String(connection.homeValues.redfinEstimate) : "",
    redfinUrl: connection.homeValues?.redfinUrl ?? "",
    zillowEstimate:
      typeof connection.homeValues?.zillowEstimate === "number" ? String(connection.homeValues.zillowEstimate) : "",
    zillowUrl: connection.homeValues?.zillowUrl ?? ""
  };
}

function toPayload(form: HomeValueFormState): UpsertHomeValueConnectionPayload {
  const parseEstimate = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    label: form.label.trim() || null,
    address: form.address.trim(),
    source: form.source,
    redfinEstimate: parseEstimate(form.redfinEstimate),
    redfinUrl: form.redfinUrl.trim() || null,
    zillowEstimate: parseEstimate(form.zillowEstimate),
    zillowUrl: form.zillowUrl.trim() || null
  };
}

function HomeValueConnectionEditor({
  connection,
  onRefresh
}: {
  connection: ConnectionDto;
  onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<HomeValueFormState>(() => toFormState(connection));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(toFormState(connection));
  }, [connection]);

  const currentValue = connection.homeValues?.calculatedValue ?? connection.accounts[0]?.currentBalance ?? null;

  return (
    <article className="list-card">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Property</p>
          <h3>{connection.label}</h3>
          <p className="muted">
            {connection.homeValues?.source ?? "AVERAGE"}
            {currentValue != null ? ` · applied value $${currentValue.toFixed(2)}` : ""}
          </p>
        </div>
      </div>

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
            onChange={event =>
              setForm(current => ({
                ...current,
                source: event.target.value as HomeValueSource
              }))
            }
          >
            <option value="AVERAGE">Average Redfin + Zillow</option>
            <option value="REDFIN">Redfin only</option>
            <option value="ZILLOW">Zillow only</option>
          </select>
        </label>

        <label>
          <span>Redfin estimate</span>
          <input
            value={form.redfinEstimate}
            onChange={event => setForm(current => ({ ...current, redfinEstimate: event.target.value }))}
            placeholder="650000"
          />
        </label>

        <label>
          <span>Redfin URL</span>
          <input
            value={form.redfinUrl}
            onChange={event => setForm(current => ({ ...current, redfinUrl: event.target.value }))}
            placeholder="https://www.redfin.com/..."
          />
        </label>

        <label>
          <span>Zillow estimate</span>
          <input
            value={form.zillowEstimate}
            onChange={event => setForm(current => ({ ...current, zillowEstimate: event.target.value }))}
            placeholder="645000"
          />
        </label>

        <label>
          <span>Zillow URL</span>
          <input
            value={form.zillowUrl}
            onChange={event => setForm(current => ({ ...current, zillowUrl: event.target.value }))}
            placeholder="https://www.zillow.com/..."
          />
        </label>
      </div>

      <div className="button-row">
        <button
          className="primary-button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.updateHomeValueConnection(connection.id, toPayload(form));
              await onRefresh();
            } catch (saveError) {
              setError(
                getDisplayErrorMessage(saveError, "Failed to save this home value connection.", {
                  serverUnavailableMessage: "Could not reach the API server to save this home value connection."
                })
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving..." : "Save property"}
        </button>
        <button
          className="ghost-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.refreshConnection(connection.id);
              await onRefresh();
            } catch (refreshError) {
              setError(
                getDisplayErrorMessage(refreshError, "Failed to recalculate this home value connection.", {
                  serverUnavailableMessage: "Could not reach the API server to recalculate this home value connection."
                })
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Recalculating..." : "Recalculate"}
        </button>
        <button
          className="ghost-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.disconnectConnection(connection.id);
              await onRefresh();
            } catch (disconnectError) {
              setError(
                getDisplayErrorMessage(disconnectError, "Failed to disconnect this home value connection.", {
                  serverUnavailableMessage: "Could not reach the API server to disconnect this home value connection."
                })
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Disconnect
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </article>
  );
}

export function HomeValuesConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [form, setForm] = useState<HomeValueFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  return (
    <div className="page-stack">
      {runtimeProvider ? <ProviderReadinessPanel provider={runtimeProvider} /> : null}

      <section className="panel">
        <p className="eyebrow">Home Values</p>
        <h3>Track property values with synthetic valuation transactions.</h3>
        <p className="muted">
          Enter Redfin and Zillow estimates manually, choose which source to trust, and map the result to an off-budget
          asset account in Actual for net worth tracking.
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
              <option value="AVERAGE">Average Redfin + Zillow</option>
              <option value="REDFIN">Redfin only</option>
              <option value="ZILLOW">Zillow only</option>
            </select>
          </label>

          <label>
            <span>Redfin estimate</span>
            <input
              value={form.redfinEstimate}
              onChange={event => setForm(current => ({ ...current, redfinEstimate: event.target.value }))}
              placeholder="650000"
            />
          </label>

          <label>
            <span>Redfin URL</span>
            <input
              value={form.redfinUrl}
              onChange={event => setForm(current => ({ ...current, redfinUrl: event.target.value }))}
              placeholder="https://www.redfin.com/..."
            />
          </label>

          <label>
            <span>Zillow estimate</span>
            <input
              value={form.zillowEstimate}
              onChange={event => setForm(current => ({ ...current, zillowEstimate: event.target.value }))}
              placeholder="645000"
            />
          </label>

          <label>
            <span>Zillow URL</span>
            <input
              value={form.zillowUrl}
              onChange={event => setForm(current => ({ ...current, zillowUrl: event.target.value }))}
              placeholder="https://www.zillow.com/..."
            />
          </label>
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await api.createHomeValueConnection(toPayload(form));
                setForm(emptyForm);
                await load();
              } catch (saveError) {
                setError(
                  getDisplayErrorMessage(saveError, "Failed to create this home value connection.", {
                    serverUnavailableMessage: "Could not reach the API server to create this home value connection."
                  })
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Creating..." : "Add property"}
          </button>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </section>

      <section className="panel">
        <p className="eyebrow">Saved properties</p>
        {loading ? <p>Loading Home Values connections…</p> : null}
        {!loading && homeValueConnections.length === 0 ? (
          <p className="muted">No home value connections have been added.</p>
        ) : null}
        <div className="connection-grid">
          {homeValueConnections.map(connection => (
            <HomeValueConnectionEditor key={connection.id} connection={connection} onRefresh={load} />
          ))}
        </div>
      </section>
    </div>
  );
}
