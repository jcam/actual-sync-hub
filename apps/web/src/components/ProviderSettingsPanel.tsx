import { useEffect, useState } from "react";
import { type Provider, type ProviderSettingsByProviderDto, type SaltEdgeEnvironment } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";

type ProviderSettingsPanelProps<T extends Provider> = {
  provider: T;
  label: string;
  settings: ProviderSettingsByProviderDto<T>;
  onSaved?: () => Promise<void> | void;
};

type PlaidSettingsDraft = {
  environment: "sandbox" | "production";
  sandboxClientId: string;
  sandboxSecret: string;
  productionClientId: string;
  productionSecret: string;
  countryCodes: string;
  products: string;
  transactionsDaysRequested: string;
  personalFinanceCategoryVersion: "v1" | "v2";
  automaticSyncConcurrency: string;
};

type TellerSettingsDraft = {
  environment: "sandbox" | "development" | "production";
  sandboxAppId: string;
  sandboxAccessToken: string;
  sandboxWebhookSigningSecrets: string;
  developmentAppId: string;
  developmentCertificatePem: string;
  developmentKeyPem: string;
  developmentWebhookSigningSecrets: string;
  productionAppId: string;
  productionCertificatePem: string;
  productionKeyPem: string;
  productionWebhookSigningSecrets: string;
  transactionsInitialDays: string;
  transactionsOverlapDays: string;
  automaticSyncConcurrency: string;
  webhookSyncDebounceSeconds: string;
  webhookToleranceSeconds: string;
};

type SimpleFinSettingsDraft = {
  mode: "sandbox" | "development" | "production";
  developmentServerUrl: string;
  transactionsInitialDays: string;
  automaticSyncConcurrency: string;
};

type SaltEdgeSettingsDraft = {
  environment: SaltEdgeEnvironment;
  appId: string;
  secret: string;
  consentDays: string;
  transactionsFetchDays: string;
  automaticSyncConcurrency: string;
};

type HomeValuesSettingsDraft = {
  automaticSyncConcurrency: string;
  redfinFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  movotoFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  homesFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  truliaFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
};

type ProviderSettingsDraft =
  | PlaidSettingsDraft
  | TellerSettingsDraft
  | SimpleFinSettingsDraft
  | SaltEdgeSettingsDraft
  | HomeValuesSettingsDraft;

function parseWholeNumber(value: string) {
  if (!/^-?\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function requireIntegerInRange(label: string, value: string, min: number, max: number) {
  const parsed = parseWholeNumber(value);
  if (parsed == null) {
    return `${label} must be a whole number.`;
  }
  if (parsed < min || parsed > max) {
    return `${label} must be between ${min} and ${max}.`;
  }
  return null;
}

function isValidUrl(value: string) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateDraft(provider: Provider, draft: ProviderSettingsDraft) {
  switch (provider) {
    case "PLAID": {
      const plaidDraft = draft as PlaidSettingsDraft;
      if (splitCsvField(plaidDraft.countryCodes).length === 0) {
        return "Country codes must include at least one value.";
      }
      if (splitCsvField(plaidDraft.products).length === 0) {
        return "Products must include at least one value.";
      }
      return (
        requireIntegerInRange("Initial transaction window", plaidDraft.transactionsDaysRequested, 1, 730) ??
        requireIntegerInRange("Automatic sync concurrency", plaidDraft.automaticSyncConcurrency, 1, 20)
      );
    }
    case "TELLER": {
      const tellerDraft = draft as TellerSettingsDraft;
      const currentAppId =
        tellerDraft.environment === "sandbox"
          ? tellerDraft.sandboxAppId
          : tellerDraft.environment === "development"
            ? tellerDraft.developmentAppId
            : tellerDraft.productionAppId;
      if (!currentAppId.trim()) {
        return "Application ID is required.";
      }
      if (tellerDraft.environment !== "sandbox") {
        const certificate =
          tellerDraft.environment === "development"
            ? tellerDraft.developmentCertificatePem
            : tellerDraft.productionCertificatePem;
        const key =
          tellerDraft.environment === "development" ? tellerDraft.developmentKeyPem : tellerDraft.productionKeyPem;
        if (!certificate.trim()) {
          return "Client certificate (PEM) is required.";
        }
        if (!key.trim()) {
          return "Client key (PEM) is required.";
        }
      }
      return (
        requireIntegerInRange("Initial transaction window", tellerDraft.transactionsInitialDays, 1, 3650) ??
        requireIntegerInRange("Overlap window", tellerDraft.transactionsOverlapDays, 1, 30) ??
        requireIntegerInRange("Automatic sync concurrency", tellerDraft.automaticSyncConcurrency, 1, 20) ??
        requireIntegerInRange("Webhook sync debounce", tellerDraft.webhookSyncDebounceSeconds, 0, 3600) ??
        requireIntegerInRange("Webhook tolerance", tellerDraft.webhookToleranceSeconds, 1, 900)
      );
    }
    case "SIMPLEFIN": {
      const simpleFinDraft = draft as SimpleFinSettingsDraft;
      if (simpleFinDraft.mode === "development") {
        const serverUrl = simpleFinDraft.developmentServerUrl.trim();
        if (!serverUrl) {
          return "Development server URL is required in development mode.";
        }
        if (!isValidUrl(serverUrl)) {
          return "Development server URL must be a valid URL.";
        }
      }
      return (
        requireIntegerInRange("Initial transaction window", simpleFinDraft.transactionsInitialDays, 1, 90) ??
        requireIntegerInRange("Automatic sync concurrency", simpleFinDraft.automaticSyncConcurrency, 1, 20)
      );
    }
    case "HOME_VALUES": {
      const homeValuesDraft = draft as HomeValuesSettingsDraft;
      return requireIntegerInRange("Automatic sync concurrency", homeValuesDraft.automaticSyncConcurrency, 1, 20);
    }
    case "SALT_EDGE": {
      const saltEdgeDraft = draft as SaltEdgeSettingsDraft;
      if (!saltEdgeDraft.appId.trim()) {
        return "App ID is required.";
      }
      if (!saltEdgeDraft.secret.trim()) {
        return "Secret is required.";
      }
      return (
        requireIntegerInRange("Consent period", saltEdgeDraft.consentDays, 1, 365) ??
        requireIntegerInRange("Initial transaction window", saltEdgeDraft.transactionsFetchDays, 1, 365) ??
        requireIntegerInRange("Automatic sync concurrency", saltEdgeDraft.automaticSyncConcurrency, 1, 20)
      );
    }
  }
}

function toDraft<T extends Provider>(
  provider: T,
  settings: ProviderSettingsByProviderDto<T>
): ProviderSettingsDraft {
  switch (provider) {
    case "PLAID": {
      const plaidSettings = settings as ProviderSettingsByProviderDto<"PLAID">;
      return {
        environment: plaidSettings.environment ?? "sandbox",
        sandboxClientId: plaidSettings.sandbox?.clientId ?? "",
        sandboxSecret: plaidSettings.sandbox?.secret ?? "",
        productionClientId: plaidSettings.production?.clientId ?? "",
        productionSecret: plaidSettings.production?.secret ?? "",
        countryCodes: (plaidSettings.countryCodes ?? []).join(", "),
        products: (plaidSettings.products ?? []).join(", "),
        transactionsDaysRequested: String(plaidSettings.transactionsDaysRequested),
        personalFinanceCategoryVersion: plaidSettings.personalFinanceCategoryVersion,
        automaticSyncConcurrency: String(plaidSettings.automaticSyncConcurrency)
      } satisfies PlaidSettingsDraft;
    }
    case "TELLER": {
      const tellerSettings = settings as ProviderSettingsByProviderDto<"TELLER">;
      return {
        environment: tellerSettings.environment ?? "sandbox",
        sandboxAppId: tellerSettings.sandbox?.appId ?? "",
        sandboxAccessToken: tellerSettings.sandbox?.sandboxAccessToken ?? "",
        sandboxWebhookSigningSecrets: (tellerSettings.sandbox?.webhookSigningSecrets ?? []).join("\n"),
        developmentAppId: tellerSettings.development?.appId ?? "",
        developmentCertificatePem: tellerSettings.development?.certificatePem ?? "",
        developmentKeyPem: tellerSettings.development?.keyPem ?? "",
        developmentWebhookSigningSecrets: (tellerSettings.development?.webhookSigningSecrets ?? []).join("\n"),
        productionAppId: tellerSettings.production?.appId ?? "",
        productionCertificatePem: tellerSettings.production?.certificatePem ?? "",
        productionKeyPem: tellerSettings.production?.keyPem ?? "",
        productionWebhookSigningSecrets: (tellerSettings.production?.webhookSigningSecrets ?? []).join("\n"),
        transactionsInitialDays: String(tellerSettings.transactionsInitialDays),
        transactionsOverlapDays: String(tellerSettings.transactionsOverlapDays),
        automaticSyncConcurrency: String(tellerSettings.automaticSyncConcurrency),
        webhookSyncDebounceSeconds: String(tellerSettings.webhookSyncDebounceSeconds),
        webhookToleranceSeconds: String(tellerSettings.webhookToleranceSeconds)
      } satisfies TellerSettingsDraft;
    }
    case "SIMPLEFIN": {
      const simpleFinSettings = settings as ProviderSettingsByProviderDto<"SIMPLEFIN">;
      return {
        mode: simpleFinSettings.mode ?? "sandbox",
        developmentServerUrl: simpleFinSettings.development?.serverUrl ?? "",
        transactionsInitialDays: String(simpleFinSettings.transactionsInitialDays),
        automaticSyncConcurrency: String(simpleFinSettings.automaticSyncConcurrency)
      } satisfies SimpleFinSettingsDraft;
    }
    case "HOME_VALUES": {
      const homeValuesSettings = settings as ProviderSettingsByProviderDto<"HOME_VALUES">;
      return {
        automaticSyncConcurrency: String(homeValuesSettings.automaticSyncConcurrency),
        redfinFetchMethod: homeValuesSettings.redfinFetchMethod,
        movotoFetchMethod: homeValuesSettings.movotoFetchMethod,
        homesFetchMethod: homeValuesSettings.homesFetchMethod,
        truliaFetchMethod: homeValuesSettings.truliaFetchMethod
      } satisfies HomeValuesSettingsDraft;
    }
    case "SALT_EDGE": {
      const saltEdgeSettings = settings as ProviderSettingsByProviderDto<"SALT_EDGE">;
      return {
        environment: saltEdgeSettings.environment ?? "test",
        appId: saltEdgeSettings.appId ?? "",
        secret: saltEdgeSettings.secret ?? "",
        consentDays: String(saltEdgeSettings.consentDays),
        transactionsFetchDays: String(saltEdgeSettings.transactionsFetchDays),
        automaticSyncConcurrency: String(saltEdgeSettings.automaticSyncConcurrency)
      } satisfies SaltEdgeSettingsDraft;
    }
  }
}

function splitCsvField(value: string) {
  return value
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}

function splitLineOrCsvField(value: string) {
  return value
    .split(/\r?\n|,/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function toPayload<T extends Provider>(
  provider: T,
  draft: ProviderSettingsDraft
): ProviderSettingsByProviderDto<T> {
  switch (provider) {
    case "PLAID": {
      const plaidDraft = draft as PlaidSettingsDraft;
      return {
        environment: plaidDraft.environment,
        sandbox: {
          clientId: plaidDraft.sandboxClientId.trim(),
          secret: plaidDraft.sandboxSecret
        },
        production: {
          clientId: plaidDraft.productionClientId.trim(),
          secret: plaidDraft.productionSecret
        },
        countryCodes: splitCsvField(plaidDraft.countryCodes).map(code => code.toUpperCase()),
        products: splitCsvField(plaidDraft.products),
        transactionsDaysRequested: Number(plaidDraft.transactionsDaysRequested),
        personalFinanceCategoryVersion: plaidDraft.personalFinanceCategoryVersion,
        automaticSyncConcurrency: Number(plaidDraft.automaticSyncConcurrency)
      } as ProviderSettingsByProviderDto<T>;
    }
    case "TELLER": {
      const tellerDraft = draft as TellerSettingsDraft;
      return {
        environment: tellerDraft.environment,
        sandbox: {
          appId: tellerDraft.sandboxAppId.trim(),
          sandboxAccessToken: tellerDraft.sandboxAccessToken,
          webhookSigningSecrets: splitLineOrCsvField(tellerDraft.sandboxWebhookSigningSecrets)
        },
        development: {
          appId: tellerDraft.developmentAppId.trim(),
          certificatePem: tellerDraft.developmentCertificatePem,
          keyPem: tellerDraft.developmentKeyPem,
          webhookSigningSecrets: splitLineOrCsvField(tellerDraft.developmentWebhookSigningSecrets)
        },
        production: {
          appId: tellerDraft.productionAppId.trim(),
          certificatePem: tellerDraft.productionCertificatePem,
          keyPem: tellerDraft.productionKeyPem,
          webhookSigningSecrets: splitLineOrCsvField(tellerDraft.productionWebhookSigningSecrets)
        },
        transactionsInitialDays: Number(tellerDraft.transactionsInitialDays),
        transactionsOverlapDays: Number(tellerDraft.transactionsOverlapDays),
        automaticSyncConcurrency: Number(tellerDraft.automaticSyncConcurrency),
        webhookSyncDebounceSeconds: Number(tellerDraft.webhookSyncDebounceSeconds),
        webhookToleranceSeconds: Number(tellerDraft.webhookToleranceSeconds)
      } as ProviderSettingsByProviderDto<T>;
    }
    case "SIMPLEFIN": {
      const simpleFinDraft = draft as SimpleFinSettingsDraft;
      return {
        mode: simpleFinDraft.mode,
        development: {
          serverUrl: simpleFinDraft.developmentServerUrl.trim()
        },
        transactionsInitialDays: Number(simpleFinDraft.transactionsInitialDays),
        automaticSyncConcurrency: Number(simpleFinDraft.automaticSyncConcurrency)
      } as ProviderSettingsByProviderDto<T>;
    }
    case "HOME_VALUES": {
      const homeValuesDraft = draft as HomeValuesSettingsDraft;
      return {
        automaticSyncConcurrency: Number(homeValuesDraft.automaticSyncConcurrency),
        redfinFetchMethod: homeValuesDraft.redfinFetchMethod,
        movotoFetchMethod: homeValuesDraft.movotoFetchMethod,
        homesFetchMethod: homeValuesDraft.homesFetchMethod,
        truliaFetchMethod: homeValuesDraft.truliaFetchMethod
      } as ProviderSettingsByProviderDto<T>;
    }
    case "SALT_EDGE": {
      const saltEdgeDraft = draft as SaltEdgeSettingsDraft;
      return {
        environment: saltEdgeDraft.environment,
        appId: saltEdgeDraft.appId.trim(),
        secret: saltEdgeDraft.secret,
        consentDays: Number(saltEdgeDraft.consentDays),
        transactionsFetchDays: Number(saltEdgeDraft.transactionsFetchDays),
        automaticSyncConcurrency: Number(saltEdgeDraft.automaticSyncConcurrency)
      } as ProviderSettingsByProviderDto<T>;
    }
  }
}

export function ProviderSettingsPanel<T extends Provider>({
  provider,
  label,
  settings,
  onSaved
}: ProviderSettingsPanelProps<T>) {
  const [draft, setDraft] = useState<ProviderSettingsDraft>(() => toDraft(provider, settings));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(toDraft(provider, settings));
  }, [provider, settings]);

  const save = async () => {
    const validationMessage = validateDraft(provider, draft);
    if (validationMessage) {
      setMessage(null);
      setError(validationMessage);
      return;
    }

    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      const payload = toPayload(provider, draft);
      const saved = await api.updateProviderSettings(provider, payload);
      setDraft(toDraft(provider, saved));
      if (
        provider === "SALT_EDGE" &&
        "environment" in payload &&
        "environment" in saved &&
        payload.environment !== saved.environment
      ) {
        setMessage(null);
        setError(
          `Salt Edge does not support ${payload.environment} for the current client state. The setting was switched to ${saved.environment}.`
        );
      } else {
        setMessage(`${label} settings saved.`);
      }
      await onSaved?.();
    } catch (saveError) {
      setError(
        getDisplayErrorMessage(saveError, `Failed to save ${label} settings.`, {
          serverUnavailableMessage: `Could not reach the API server while saving ${label} settings.`
        })
      );
    } finally {
      setSaving(false);
    }
  };

  const plaidDraft = provider === "PLAID" ? (draft as PlaidSettingsDraft) : null;
  const tellerDraft = provider === "TELLER" ? (draft as TellerSettingsDraft) : null;
  const simpleFinDraft = provider === "SIMPLEFIN" ? (draft as SimpleFinSettingsDraft) : null;
  const saltEdgeDraft = provider === "SALT_EDGE" ? (draft as SaltEdgeSettingsDraft) : null;
  const homeValuesDraft = provider === "HOME_VALUES" ? (draft as HomeValuesSettingsDraft) : null;

  return (
    <section className="panel provider-settings-panel">
      <div className="provider-settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <p className="muted">
            Adjust provider credentials and sync behavior for {label}. Values are stored in the app and take effect
            immediately after saving.
          </p>
        </div>
      </div>

      <div className="grid provider-settings-grid">
        {plaidDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={plaidDraft.environment}
                onChange={event => {
                  const next = event.target.value as PlaidSettingsDraft["environment"];
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    environment: next
                  }));
                }}
              >
                <option value="sandbox">sandbox</option>
                <option value="production">production</option>
              </select>
            </label>
            <label>
              <span>{plaidDraft.environment === "sandbox" ? "Sandbox client ID" : "Production client ID"}</span>
              <input
                type="text"
                value={plaidDraft.environment === "sandbox" ? plaidDraft.sandboxClientId : plaidDraft.productionClientId}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    ...(plaidDraft.environment === "sandbox"
                      ? { sandboxClientId: next }
                      : { productionClientId: next })
                  }));
                }}
                placeholder="Plaid client id"
              />
            </label>
            <label>
              <span>{plaidDraft.environment === "sandbox" ? "Sandbox secret" : "Production secret"}</span>
              <input
                type="password"
                value={plaidDraft.environment === "sandbox" ? plaidDraft.sandboxSecret : plaidDraft.productionSecret}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    ...(plaidDraft.environment === "sandbox" ? { sandboxSecret: next } : { productionSecret: next })
                  }));
                }}
                placeholder="Plaid secret"
              />
            </label>
            <label>
              <span>Country codes</span>
              <input
                type="text"
                value={plaidDraft.countryCodes}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    countryCodes: next
                  }));
                }}
                placeholder="US, CA"
              />
            </label>
            <label>
              <span>Products</span>
              <input
                type="text"
                value={plaidDraft.products}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    products: next
                  }));
                }}
                placeholder="transactions"
              />
            </label>
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                max={730}
                value={plaidDraft.transactionsDaysRequested}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    transactionsDaysRequested: next
                  }));
                }}
              />
            </label>
            <label>
              <span>PFC category version</span>
              <select
                value={plaidDraft.personalFinanceCategoryVersion}
                onChange={event => {
                  const next = event.target.value as PlaidSettingsDraft["personalFinanceCategoryVersion"];
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    personalFinanceCategoryVersion: next
                  }));
                }}
              >
                <option value="v1">v1</option>
                <option value="v2">v2</option>
              </select>
            </label>
            <label>
              <span>Automatic sync concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={plaidDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as PlaidSettingsDraft),
                    automaticSyncConcurrency: next
                  }));
                }}
              />
            </label>
          </>
        ) : null}

        {tellerDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={tellerDraft.environment}
                onChange={event => {
                  const next = event.target.value as TellerSettingsDraft["environment"];
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    environment: next
                  }));
                }}
              >
                <option value="sandbox">sandbox</option>
                <option value="development">development</option>
                <option value="production">production</option>
              </select>
            </label>
            <label>
              <span>Application ID</span>
              <input
                type="text"
                value={
                  tellerDraft.environment === "sandbox"
                    ? tellerDraft.sandboxAppId
                    : tellerDraft.environment === "development"
                      ? tellerDraft.developmentAppId
                      : tellerDraft.productionAppId
                }
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    ...(tellerDraft.environment === "sandbox"
                      ? { sandboxAppId: next }
                      : tellerDraft.environment === "development"
                        ? { developmentAppId: next }
                        : { productionAppId: next })
                  }));
                }}
                placeholder="Teller application id"
              />
            </label>
            {tellerDraft.environment === "sandbox" ? (
              <>
                <label>
                  <span>Sandbox access token</span>
                  <input
                    type="password"
                    value={tellerDraft.sandboxAccessToken}
                    onChange={event => {
                      const next = event.target.value;
                      setDraft(current => ({
                        ...(current as TellerSettingsDraft),
                        sandboxAccessToken: next
                      }));
                    }}
                    placeholder="Optional sandbox access token"
                  />
                </label>
                <label className="provider-settings-textarea">
                  <span>Webhook signing secrets</span>
                  <textarea
                    rows={3}
                    value={tellerDraft.sandboxWebhookSigningSecrets}
                    onChange={event => {
                      const next = event.target.value;
                      setDraft(current => ({
                        ...(current as TellerSettingsDraft),
                        sandboxWebhookSigningSecrets: next
                      }));
                    }}
                    placeholder="One secret per line"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="provider-settings-textarea">
                  <span>Client certificate (PEM)</span>
                  <textarea
                    rows={6}
                    value={
                      tellerDraft.environment === "development"
                        ? tellerDraft.developmentCertificatePem
                        : tellerDraft.productionCertificatePem
                    }
                    onChange={event => {
                      const next = event.target.value;
                      setDraft(current => ({
                        ...(current as TellerSettingsDraft),
                        ...(tellerDraft.environment === "development"
                          ? { developmentCertificatePem: next }
                          : { productionCertificatePem: next })
                      }));
                    }}
                    placeholder="-----BEGIN CERTIFICATE-----"
                  />
                </label>
                <label className="provider-settings-textarea">
                  <span>Client key (PEM)</span>
                  <textarea
                    rows={6}
                    value={
                      tellerDraft.environment === "development"
                        ? tellerDraft.developmentKeyPem
                        : tellerDraft.productionKeyPem
                    }
                    onChange={event => {
                      const next = event.target.value;
                      setDraft(current => ({
                        ...(current as TellerSettingsDraft),
                        ...(tellerDraft.environment === "development"
                          ? { developmentKeyPem: next }
                          : { productionKeyPem: next })
                      }));
                    }}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                  />
                </label>
                <label className="provider-settings-textarea">
                  <span>Webhook signing secrets</span>
                  <textarea
                    rows={3}
                    value={
                      tellerDraft.environment === "development"
                        ? tellerDraft.developmentWebhookSigningSecrets
                        : tellerDraft.productionWebhookSigningSecrets
                    }
                    onChange={event => {
                      const next = event.target.value;
                      setDraft(current => ({
                        ...(current as TellerSettingsDraft),
                        ...(tellerDraft.environment === "development"
                          ? { developmentWebhookSigningSecrets: next }
                          : { productionWebhookSigningSecrets: next })
                      }));
                    }}
                    placeholder="One secret per line"
                  />
                </label>
              </>
            )}
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                value={tellerDraft.transactionsInitialDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    transactionsInitialDays: next
                  }));
                }}
              />
            </label>
            <label>
              <span>Overlap window (days)</span>
              <input
                type="number"
                min={1}
                max={30}
                value={tellerDraft.transactionsOverlapDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    transactionsOverlapDays: next
                  }));
                }}
              />
            </label>
            <label>
              <span>Automatic sync concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={tellerDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    automaticSyncConcurrency: next
                  }));
                }}
              />
            </label>
            <label>
              <span>Webhook sync debounce (seconds)</span>
              <input
                type="number"
                min={0}
                max={3600}
                value={tellerDraft.webhookSyncDebounceSeconds}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    webhookSyncDebounceSeconds: next
                  }));
                }}
              />
            </label>
            <label>
              <span>Webhook tolerance (seconds)</span>
              <input
                type="number"
                min={1}
                max={900}
                value={tellerDraft.webhookToleranceSeconds}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as TellerSettingsDraft),
                    webhookToleranceSeconds: next
                  }));
                }}
              />
            </label>
          </>
        ) : null}

        {simpleFinDraft ? (
          <>
            <label>
              <span>Mode</span>
              <select
                value={simpleFinDraft.mode}
                onChange={event => {
                  const next = event.target.value as SimpleFinSettingsDraft["mode"];
                  setDraft(current => ({
                    ...(current as SimpleFinSettingsDraft),
                    mode: next
                  }));
                }}
              >
                <option value="sandbox">sandbox</option>
                <option value="development">development</option>
                <option value="production">production</option>
              </select>
            </label>
            {simpleFinDraft.mode === "development" ? (
              <label>
                <span>Development server URL</span>
                <input
                  type="url"
                  value={simpleFinDraft.developmentServerUrl}
                  onChange={event => {
                    const next = event.target.value;
                    setDraft(current => ({
                      ...(current as SimpleFinSettingsDraft),
                      developmentServerUrl: next
                    }));
                  }}
                  placeholder="https://simplefin-dev.example.com"
                />
              </label>
            ) : null}
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                max={90}
                value={simpleFinDraft.transactionsInitialDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as SimpleFinSettingsDraft),
                    transactionsInitialDays: next
                  }));
                }}
              />
            </label>
            <label>
              <span>Automatic sync concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={simpleFinDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as SimpleFinSettingsDraft),
                    automaticSyncConcurrency: next
                  }));
                }}
              />
            </label>
          </>
        ) : null}

        {saltEdgeDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={saltEdgeDraft.environment}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    environment: event.target.value as SaltEdgeEnvironment
                  }))
                }
              >
                <option value="sandbox">sandbox</option>
                <option value="test">test</option>
                <option value="production">production</option>
              </select>
            </label>
            <label>
              <span>App ID</span>
              <input
                type="text"
                value={saltEdgeDraft.appId}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    appId: event.target.value
                  }))
                }
                placeholder="Salt Edge App ID"
              />
            </label>
            <label>
              <span>Secret</span>
              <input
                type="password"
                value={saltEdgeDraft.secret}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    secret: event.target.value
                  }))
                }
                placeholder="Salt Edge secret"
              />
            </label>
            <label>
              <span>Consent period (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={saltEdgeDraft.consentDays}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    consentDays: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={saltEdgeDraft.transactionsFetchDays}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    transactionsFetchDays: event.target.value
                  }))
                }
              />
            </label>
            <label>
              <span>Automatic sync concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={saltEdgeDraft.automaticSyncConcurrency}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as SaltEdgeSettingsDraft),
                    automaticSyncConcurrency: event.target.value
                  }))
                }
              />
            </label>
          </>
        ) : null}

        {homeValuesDraft ? (
          <>
            <label>
              <span>Redfin fetch method</span>
              <select
                value={homeValuesDraft.redfinFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as HomeValuesSettingsDraft),
                    redfinFetchMethod: event.target.value as HomeValuesSettingsDraft["redfinFetchMethod"]
                  }))
                }
              >
                <option value="curl">curl</option>
                <option value="wget">wget</option>
                <option value="node_fetch">node fetch</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              <span>Movoto fetch method</span>
              <select
                value={homeValuesDraft.movotoFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as HomeValuesSettingsDraft),
                    movotoFetchMethod: event.target.value as HomeValuesSettingsDraft["movotoFetchMethod"]
                  }))
                }
              >
                <option value="curl">curl</option>
                <option value="wget">wget</option>
                <option value="node_fetch">node fetch</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              <span>Homes.com fetch method</span>
              <select
                value={homeValuesDraft.homesFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as HomeValuesSettingsDraft),
                    homesFetchMethod: event.target.value as HomeValuesSettingsDraft["homesFetchMethod"]
                  }))
                }
              >
                <option value="curl">curl</option>
                <option value="wget">wget</option>
                <option value="node_fetch">node fetch</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              <span>Trulia fetch method</span>
              <select
                value={homeValuesDraft.truliaFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as HomeValuesSettingsDraft),
                    truliaFetchMethod: event.target.value as HomeValuesSettingsDraft["truliaFetchMethod"]
                  }))
                }
              >
                <option value="curl">curl</option>
                <option value="wget">wget</option>
                <option value="node_fetch">node fetch</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              <span>Automatic sync concurrency</span>
              <input
                type="number"
                min={1}
                max={20}
                value={homeValuesDraft.automaticSyncConcurrency}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as HomeValuesSettingsDraft),
                    automaticSyncConcurrency: event.target.value
                  }))
                }
              />
            </label>
          </>
        ) : null}
      </div>

      <div className="button-row provider-settings-actions">
        <button className="primary-button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving..." : "Save settings"}
        </button>
      </div>

      {message ? <p className="success-text">{message}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
