import { useEffect, useMemo, useState } from "react";
import type {
  ConnectionDto,
  HomeValueEstimateStateDto,
  RuntimeInfoDto,
  UpsertVehicleValueConnectionPayload,
  VehicleCondition,
  VehicleValueSource
} from "@actual-sync/shared";
import { api } from "../api";
import { ProviderReadinessPanel } from "../components/ProviderReadinessPanel";
import { ProviderSettingsPanel } from "../components/ProviderSettingsPanel";
import { getDisplayErrorMessage } from "../lib/errors";

type VehicleValueFormState = {
  label: string;
  vin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  mileage: string;
  zipCode: string;
  condition: VehicleCondition;
  source: VehicleValueSource;
  kbbValue: string;
  edmundsValue: string;
  carmaxValue: string;
  hagertyValue: string;
};

type SourceStateKey = "kbb" | "edmunds" | "carmax" | "hagerty";

const emptyForm: VehicleValueFormState = {
  label: "",
  vin: "",
  year: "",
  make: "",
  model: "",
  trim: "",
  mileage: "",
  zipCode: "",
  condition: "GOOD",
  source: "AVERAGE",
  kbbValue: "",
  edmundsValue: "",
  carmaxValue: "",
  hagertyValue: ""
};

const vehicleValueSourceOptions: Array<{ value: VehicleValueSource; label: string }> = [
  { value: "AVERAGE", label: "Average all available values" },
  { value: "KBB", label: "Kelley Blue Book only" },
  { value: "EDMUNDS", label: "Edmunds only" },
  { value: "CARMAX", label: "CarMax only" },
  { value: "HAGERTY", label: "Hagerty only" }
];

const conditionOptions: Array<{ value: VehicleCondition; label: string }> = [
  { value: "EXCELLENT", label: "Excellent" },
  { value: "GOOD", label: "Good" },
  { value: "FAIR", label: "Fair" },
  { value: "POOR", label: "Poor" }
];

function formatSourceLabel(source: VehicleValueSource) {
  return vehicleValueSourceOptions.find(option => option.value === source)?.label ?? source;
}

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : Number.NaN;
}

function validateForm(form: VehicleValueFormState) {
  if (!form.make.trim()) {
    return "Make is required.";
  }
  if (!form.model.trim()) {
    return "Model is required.";
  }
  if (!form.mileage.trim()) {
    return "Mileage is required.";
  }
  if (Number.isNaN(parseOptionalNumber(form.mileage))) {
    return "Mileage must be zero or greater.";
  }
  if (!form.zipCode.trim()) {
    return "ZIP code is required.";
  }

  const sourceValues = [
    { label: "Kelley Blue Book", value: parseOptionalNumber(form.kbbValue) },
    { label: "Edmunds", value: parseOptionalNumber(form.edmundsValue) },
    { label: "CarMax", value: parseOptionalNumber(form.carmaxValue) },
    { label: "Hagerty", value: parseOptionalNumber(form.hagertyValue) }
  ];
  const invalidSource = sourceValues.find(source => Number.isNaN(source.value));
  if (invalidSource) {
    return `${invalidSource.label} value must be zero or greater.`;
  }

  if (form.source === "AVERAGE") {
    if (sourceValues.every(source => source.value == null)) {
      return "At least one source value is required when Average is the selected source.";
    }
    return null;
  }

  const selectedSource = sourceValues.find(source =>
    (form.source === "KBB" && source.label === "Kelley Blue Book") ||
    (form.source === "EDMUNDS" && source.label === "Edmunds") ||
    (form.source === "CARMAX" && source.label === "CarMax") ||
    (form.source === "HAGERTY" && source.label === "Hagerty")
  );

  if (!selectedSource || selectedSource.value == null) {
    return `${formatSourceLabel(form.source)} value is required when ${formatSourceLabel(form.source)} is the selected source.`;
  }

  return null;
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "Not available";
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
        {label}: {amount == null ? "saved after create" : formatMoney(amount)}
      </p>
      {sourceState?.lastSuccessfulAt ? (
        <p className="muted">Last saved: {new Date(sourceState.lastSuccessfulAt).toLocaleString()}</p>
      ) : null}
    </div>
  );
}

function toFormState(connection: ConnectionDto): VehicleValueFormState {
  return {
    label: connection.label,
    vin: connection.vehicleValues?.vin ?? "",
    year: connection.vehicleValues?.year != null ? String(connection.vehicleValues.year) : "",
    make: connection.vehicleValues?.make ?? "",
    model: connection.vehicleValues?.model ?? "",
    trim: connection.vehicleValues?.trim ?? "",
    mileage: String(connection.vehicleValues?.mileage ?? ""),
    zipCode: connection.vehicleValues?.zipCode ?? "",
    condition: connection.vehicleValues?.condition ?? "GOOD",
    source: connection.vehicleValues?.source ?? "AVERAGE",
    kbbValue: connection.vehicleValues?.kbbValue != null ? String(connection.vehicleValues.kbbValue) : "",
    edmundsValue: connection.vehicleValues?.edmundsValue != null ? String(connection.vehicleValues.edmundsValue) : "",
    carmaxValue: connection.vehicleValues?.carmaxValue != null ? String(connection.vehicleValues.carmaxValue) : "",
    hagertyValue: connection.vehicleValues?.hagertyValue != null ? String(connection.vehicleValues.hagertyValue) : ""
  };
}

function toPayload(form: VehicleValueFormState): UpsertVehicleValueConnectionPayload {
  const year = form.year.trim() ? Number(form.year) : null;
  const mileage = Number(form.mileage);
  return {
    label: form.label.trim() || null,
    vin: form.vin.trim() || null,
    year: Number.isInteger(year) ? year : null,
    make: form.make.trim(),
    model: form.model.trim(),
    trim: form.trim.trim() || null,
    mileage: Number.isFinite(mileage) ? mileage : 0,
    zipCode: form.zipCode.trim(),
    condition: form.condition,
    source: form.source,
    kbbValue: parseOptionalNumber(form.kbbValue),
    edmundsValue: parseOptionalNumber(form.edmundsValue),
    carmaxValue: parseOptionalNumber(form.carmaxValue),
    hagertyValue: parseOptionalNumber(form.hagertyValue)
  };
}

function renderConnectionSourceState(connection: ConnectionDto, sourceKey: SourceStateKey) {
  const state = connection.vehicleValues?.sources?.[sourceKey];
  const label =
    sourceKey === "kbb"
      ? "Kelley Blue Book"
      : sourceKey === "edmunds"
        ? "Edmunds"
        : sourceKey === "carmax"
          ? "CarMax"
          : "Hagerty";
  const fallbackValue =
    sourceKey === "kbb"
      ? connection.vehicleValues?.kbbValue
      : sourceKey === "edmunds"
        ? connection.vehicleValues?.edmundsValue
        : sourceKey === "carmax"
          ? connection.vehicleValues?.carmaxValue
          : connection.vehicleValues?.hagertyValue;

  return renderEstimateLine(label, state, fallbackValue);
}

export function VehicleValuesConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionDto[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfoDto | null>(null);
  const [form, setForm] = useState<VehicleValueFormState>(emptyForm);
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
        getDisplayErrorMessage(loadError, "Failed to load Vehicle Values connections.", {
          serverUnavailableMessage: "Could not reach the API server while loading Vehicle Values connections."
        })
      );
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  const vehicleValueConnections = useMemo(
    () => connections.filter(connection => connection.provider === "VEHICLE_VALUES"),
    [connections]
  );
  const runtimeProvider = runtime?.providers.find(provider => provider.provider === "VEHICLE_VALUES") ?? null;
  const editingConnection = useMemo(
    () => vehicleValueConnections.find(connection => connection.id === editingConnectionId) ?? null,
    [editingConnectionId, vehicleValueConnections]
  );

  const resetForm = () => {
    setEditingConnectionId(null);
    setForm(emptyForm);
  };

  const formDetails = editingConnection?.vehicleValues ?? null;

  return (
    <div className="page-stack">
      {runtimeProvider ? <ProviderReadinessPanel provider={runtimeProvider} /> : null}
      {runtime?.settings.VEHICLE_VALUES ? (
        <ProviderSettingsPanel
          provider="VEHICLE_VALUES"
          label="Vehicle Values"
          settings={runtime.settings.VEHICLE_VALUES}
          onSaved={load}
        />
      ) : null}

      <section className="panel">
        <p className="eyebrow">Vehicle Values</p>
        <h3>{editingConnection ? "Edit saved vehicle" : "Add a vehicle"}</h3>
        <p className="muted">
          Save manual valuation snapshots from Kelley Blue Book, Edmunds, CarMax, or Hagerty and sync the result into
          Actual as an off-budget other-asset account.
        </p>
        <div className="grid provider-settings-grid">
          <label>
            <span>Label</span>
            <input
              value={form.label}
              onChange={event => setForm(current => ({ ...current, label: event.target.value }))}
              placeholder="Family SUV"
            />
          </label>
          <label>
            <span>VIN</span>
            <input
              value={form.vin}
              onChange={event => setForm(current => ({ ...current, vin: event.target.value }))}
              placeholder="1HGCM82633A123456"
            />
          </label>
          <label>
            <span>Year</span>
            <input
              value={form.year}
              onChange={event => setForm(current => ({ ...current, year: event.target.value }))}
              placeholder="2022"
            />
          </label>
          <label>
            <span>Make</span>
            <input
              value={form.make}
              onChange={event => setForm(current => ({ ...current, make: event.target.value }))}
              placeholder="Honda"
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={form.model}
              onChange={event => setForm(current => ({ ...current, model: event.target.value }))}
              placeholder="CR-V"
            />
          </label>
          <label>
            <span>Trim</span>
            <input
              value={form.trim}
              onChange={event => setForm(current => ({ ...current, trim: event.target.value }))}
              placeholder="EX-L"
            />
          </label>
          <label>
            <span>Mileage</span>
            <input
              value={form.mileage}
              onChange={event => setForm(current => ({ ...current, mileage: event.target.value }))}
              placeholder="24500"
            />
          </label>
          <label>
            <span>ZIP code</span>
            <input
              value={form.zipCode}
              onChange={event => setForm(current => ({ ...current, zipCode: event.target.value }))}
              placeholder="02143"
            />
          </label>
          <label>
            <span>Condition</span>
            <select
              value={form.condition}
              onChange={event => setForm(current => ({ ...current, condition: event.target.value as VehicleCondition }))}
            >
              {conditionOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Source</span>
            <select
              value={form.source}
              onChange={event => setForm(current => ({ ...current, source: event.target.value as VehicleValueSource }))}
            >
              {vehicleValueSourceOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Kelley Blue Book value</span>
            <input
              value={form.kbbValue}
              onChange={event => setForm(current => ({ ...current, kbbValue: event.target.value }))}
              placeholder="26500"
            />
          </label>
          {renderEstimateLine("Kelley Blue Book", formDetails?.sources?.kbb, formDetails?.kbbValue)}
          <label>
            <span>Edmunds value</span>
            <input
              value={form.edmundsValue}
              onChange={event => setForm(current => ({ ...current, edmundsValue: event.target.value }))}
              placeholder="25900"
            />
          </label>
          {renderEstimateLine("Edmunds", formDetails?.sources?.edmunds, formDetails?.edmundsValue)}
          <label>
            <span>CarMax value</span>
            <input
              value={form.carmaxValue}
              onChange={event => setForm(current => ({ ...current, carmaxValue: event.target.value }))}
              placeholder="25200"
            />
          </label>
          {renderEstimateLine("CarMax", formDetails?.sources?.carmax, formDetails?.carmaxValue)}
          <label>
            <span>Hagerty value</span>
            <input
              value={form.hagertyValue}
              onChange={event => setForm(current => ({ ...current, hagertyValue: event.target.value }))}
              placeholder="27800"
            />
          </label>
          {renderEstimateLine("Hagerty", formDetails?.sources?.hagerty, formDetails?.hagertyValue)}
        </div>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={saving}
            onClick={async () => {
              const validationMessage = validateForm(form);
              if (validationMessage) {
                setError(validationMessage);
                return;
              }

              setSaving(true);
              setError(null);
              try {
                if (editingConnection) {
                  await api.updateVehicleValueConnection(editingConnection.id, toPayload(form));
                } else {
                  await api.createVehicleValueConnection(toPayload(form));
                }
                resetForm();
                await load();
              } catch (saveError) {
                setError(
                  getDisplayErrorMessage(
                    saveError,
                    editingConnection
                      ? "Failed to save this vehicle value connection."
                      : "Failed to create this vehicle value connection.",
                    {
                      serverUnavailableMessage: editingConnection
                        ? "Could not reach the API server to save this vehicle value connection."
                        : "Could not reach the API server to create this vehicle value connection."
                    }
                  )
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? (editingConnection ? "Saving..." : "Creating...") : editingConnection ? "Save vehicle" : "Add vehicle"}
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
        <p className="eyebrow">Saved vehicles</p>
        {loading ? <p>Loading Vehicle Values connections…</p> : null}
        {!loading && vehicleValueConnections.length === 0 ? <p className="muted">No vehicle value connections have been added.</p> : null}
        <div className="connection-grid">
          {vehicleValueConnections.map(connection => {
            const currentValue = connection.vehicleValues?.calculatedValue ?? connection.accounts[0]?.currentBalance ?? null;
            const isBusy = busyConnectionId === connection.id;

            return (
              <article key={connection.id} className="list-card">
                <div className="connection-head">
                  <div>
                    <p className="eyebrow">Vehicle</p>
                    <h3>{connection.label}</h3>
                    <p className="muted">
                      {[connection.vehicleValues?.year ?? null, connection.vehicleValues?.make, connection.vehicleValues?.model, connection.vehicleValues?.trim ?? null]
                        .filter(Boolean)
                        .join(" ")}
                    </p>
                    <p className="muted">
                      {formatSourceLabel(connection.vehicleValues?.source ?? "AVERAGE")}
                      {currentValue != null ? ` · applied value ${formatMoney(currentValue)}` : ""}
                    </p>
                    {connection.vehicleValues?.lastCalculatedAt ? (
                      <p className="muted">Last calculated: {new Date(connection.vehicleValues.lastCalculatedAt).toLocaleString()}</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid provider-settings-grid">
                  {renderConnectionSourceState(connection, "kbb")}
                  {renderConnectionSourceState(connection, "edmunds")}
                  {renderConnectionSourceState(connection, "carmax")}
                  {renderConnectionSourceState(connection, "hagerty")}
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
                    Edit vehicle
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
                          getDisplayErrorMessage(refreshError, "Failed to recalculate this vehicle value connection.", {
                            serverUnavailableMessage: "Could not reach the API server to recalculate this vehicle value connection."
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
                          getDisplayErrorMessage(disconnectError, "Failed to disconnect this vehicle value connection.", {
                            serverUnavailableMessage: "Could not reach the API server to disconnect this vehicle value connection."
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
