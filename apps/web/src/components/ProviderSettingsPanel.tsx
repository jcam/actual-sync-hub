import { useEffect, useState } from "react";
import { type Provider, type ProviderSettingsByProviderDto } from "@actual-sync/shared";
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

type StripeSettingsDraft = {
  environment: "test" | "live";
  testPublishableKey: string;
  testSecretKey: string;
  testWebhookSigningSecrets: string;
  livePublishableKey: string;
  liveSecretKey: string;
  liveWebhookSigningSecrets: string;
  countryCodes: string;
  permissions: string;
  prefetch: string;
  transactionsInitialDays: string;
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

type MonoSettingsDraft = {
  environment: "sandbox" | "production";
  sandboxPublicKey: string;
  sandboxSecretKey: string;
  sandboxWebhookSecret: string;
  productionPublicKey: string;
  productionSecretKey: string;
  productionWebhookSecret: string;
  transactionsInitialDays: string;
  transactionsOverlapDays: string;
  automaticSyncConcurrency: string;
};

type SimpleFinSettingsDraft = {
  mode: "sandbox" | "development" | "production";
  developmentServerUrl: string;
  transactionsInitialDays: string;
  automaticSyncConcurrency: string;
};

type BelvoSettingsDraft = {
  environment: "sandbox" | "production";
  sandboxSecretId: string;
  sandboxSecretPassword: string;
  sandboxWebhookAuthorization: string;
  productionSecretId: string;
  productionSecretPassword: string;
  productionWebhookAuthorization: string;
  transactionsInitialDays: string;
  transactionsOverlapDays: string;
  automaticSyncConcurrency: string;
};

type HomeValuesSettingsDraft = {
  automaticSyncConcurrency: string;
  redfinFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  movotoFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  homesFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
  truliaFetchMethod: "node_fetch" | "curl" | "wget" | "disabled";
};

type VehicleValuesSettingsDraft = {
  automaticSyncConcurrency: string;
  kbbFetchMethod: "node_fetch" | "curl" | "wget" | "browser" | "disabled";
  hagertyFetchMethod: "node_fetch" | "curl" | "wget" | "browser" | "disabled";
};

type ProviderSettingsDraft =
  | PlaidSettingsDraft
  | StripeSettingsDraft
  | TellerSettingsDraft
  | MonoSettingsDraft
  | SimpleFinSettingsDraft
  | BelvoSettingsDraft
  | HomeValuesSettingsDraft
  | VehicleValuesSettingsDraft;

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
    case "STRIPE": {
      const stripeDraft = draft as StripeSettingsDraft;
      const publishableKey =
        stripeDraft.environment === "test" ? stripeDraft.testPublishableKey : stripeDraft.livePublishableKey;
      const secretKey = stripeDraft.environment === "test" ? stripeDraft.testSecretKey : stripeDraft.liveSecretKey;
      if (!publishableKey.trim()) {
        return "Publishable key is required.";
      }
      if (!secretKey.trim()) {
        return "Secret key is required.";
      }
      if (splitCsvField(stripeDraft.countryCodes).length === 0) {
        return "Country codes must include at least one value.";
      }
      if (splitLineOrCsvField(stripeDraft.permissions).length === 0) {
        return "Permissions must include at least one value.";
      }
      return (
        requireIntegerInRange("Initial transaction window", stripeDraft.transactionsInitialDays, 1, 180) ??
        requireIntegerInRange("Automatic sync concurrency", stripeDraft.automaticSyncConcurrency, 1, 20)
      );
    }
    case "MONO": {
      const monoDraft = draft as MonoSettingsDraft;
      const publicKey =
        monoDraft.environment === "sandbox" ? monoDraft.sandboxPublicKey : monoDraft.productionPublicKey;
      const secretKey =
        monoDraft.environment === "sandbox" ? monoDraft.sandboxSecretKey : monoDraft.productionSecretKey;
      if (!publicKey.trim()) {
        return "Public key is required.";
      }
      if (!secretKey.trim()) {
        return "Secret key is required.";
      }
      return (
        requireIntegerInRange("Initial transaction window", monoDraft.transactionsInitialDays, 1, 3650) ??
        requireIntegerInRange("Overlap window", monoDraft.transactionsOverlapDays, 1, 30) ??
        requireIntegerInRange("Automatic sync concurrency", monoDraft.automaticSyncConcurrency, 1, 20)
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
    case "BELVO": {
      const belvoDraft = draft as BelvoSettingsDraft;
      const secretId = belvoDraft.environment === "sandbox" ? belvoDraft.sandboxSecretId : belvoDraft.productionSecretId;
      const secretPassword =
        belvoDraft.environment === "sandbox" ? belvoDraft.sandboxSecretPassword : belvoDraft.productionSecretPassword;
      if (!secretId.trim()) {
        return "Secret ID is required.";
      }
      if (!secretPassword.trim()) {
        return "Secret password is required.";
      }
      return (
        requireIntegerInRange("Initial transaction window", belvoDraft.transactionsInitialDays, 1, 3650) ??
        requireIntegerInRange("Overlap window", belvoDraft.transactionsOverlapDays, 1, 90) ??
        requireIntegerInRange("Automatic sync concurrency", belvoDraft.automaticSyncConcurrency, 1, 20)
      );
    }
    case "HOME_VALUES": {
      const homeValuesDraft = draft as HomeValuesSettingsDraft;
      return requireIntegerInRange("Automatic sync concurrency", homeValuesDraft.automaticSyncConcurrency, 1, 20);
    }
    case "VEHICLE_VALUES": {
      const vehicleValuesDraft = draft as VehicleValuesSettingsDraft;
      return requireIntegerInRange("Automatic sync concurrency", vehicleValuesDraft.automaticSyncConcurrency, 1, 20);
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
    case "STRIPE": {
      const stripeSettings = settings as ProviderSettingsByProviderDto<"STRIPE">;
      return {
        environment: stripeSettings.environment ?? "test",
        testPublishableKey: stripeSettings.test?.publishableKey ?? "",
        testSecretKey: stripeSettings.test?.secretKey ?? "",
        testWebhookSigningSecrets: (stripeSettings.test?.webhookSigningSecrets ?? []).join("\n"),
        livePublishableKey: stripeSettings.live?.publishableKey ?? "",
        liveSecretKey: stripeSettings.live?.secretKey ?? "",
        liveWebhookSigningSecrets: (stripeSettings.live?.webhookSigningSecrets ?? []).join("\n"),
        countryCodes: (stripeSettings.countryCodes ?? []).join(", "),
        permissions: (stripeSettings.permissions ?? []).join(", "),
        prefetch: (stripeSettings.prefetch ?? []).join(", "),
        transactionsInitialDays: String(stripeSettings.transactionsInitialDays),
        automaticSyncConcurrency: String(stripeSettings.automaticSyncConcurrency)
      } satisfies StripeSettingsDraft;
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
    case "MONO": {
      const monoSettings = settings as ProviderSettingsByProviderDto<"MONO">;
      return {
        environment: monoSettings.environment ?? "sandbox",
        sandboxPublicKey: monoSettings.sandbox?.publicKey ?? "",
        sandboxSecretKey: monoSettings.sandbox?.secretKey ?? "",
        sandboxWebhookSecret: monoSettings.sandbox?.webhookSecret ?? "",
        productionPublicKey: monoSettings.production?.publicKey ?? "",
        productionSecretKey: monoSettings.production?.secretKey ?? "",
        productionWebhookSecret: monoSettings.production?.webhookSecret ?? "",
        transactionsInitialDays: String(monoSettings.transactionsInitialDays),
        transactionsOverlapDays: String(monoSettings.transactionsOverlapDays),
        automaticSyncConcurrency: String(monoSettings.automaticSyncConcurrency)
      } satisfies MonoSettingsDraft;
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
    case "VEHICLE_VALUES": {
      const vehicleValuesSettings = settings as ProviderSettingsByProviderDto<"VEHICLE_VALUES">;
      return {
        automaticSyncConcurrency: String(vehicleValuesSettings.automaticSyncConcurrency),
        kbbFetchMethod: vehicleValuesSettings.kbbFetchMethod,
        hagertyFetchMethod: vehicleValuesSettings.hagertyFetchMethod
      } satisfies VehicleValuesSettingsDraft;
    }
    case "BELVO": {
      const belvoSettings = settings as ProviderSettingsByProviderDto<"BELVO">;
      return {
        environment: belvoSettings.environment ?? "sandbox",
        sandboxSecretId: belvoSettings.sandbox?.secretId ?? "",
        sandboxSecretPassword: belvoSettings.sandbox?.secretPassword ?? "",
        sandboxWebhookAuthorization: belvoSettings.sandbox?.webhookAuthorization ?? "",
        productionSecretId: belvoSettings.production?.secretId ?? "",
        productionSecretPassword: belvoSettings.production?.secretPassword ?? "",
        productionWebhookAuthorization: belvoSettings.production?.webhookAuthorization ?? "",
        transactionsInitialDays: String(belvoSettings.transactionsInitialDays),
        transactionsOverlapDays: String(belvoSettings.transactionsOverlapDays),
        automaticSyncConcurrency: String(belvoSettings.automaticSyncConcurrency)
      } satisfies BelvoSettingsDraft;
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
    case "STRIPE": {
      const stripeDraft = draft as StripeSettingsDraft;
      return {
        environment: stripeDraft.environment,
        test: {
          publishableKey: stripeDraft.testPublishableKey.trim(),
          secretKey: stripeDraft.testSecretKey,
          webhookSigningSecrets: splitLineOrCsvField(stripeDraft.testWebhookSigningSecrets)
        },
        live: {
          publishableKey: stripeDraft.livePublishableKey.trim(),
          secretKey: stripeDraft.liveSecretKey,
          webhookSigningSecrets: splitLineOrCsvField(stripeDraft.liveWebhookSigningSecrets)
        },
        countryCodes: splitCsvField(stripeDraft.countryCodes).map(code => code.toUpperCase()),
        permissions: splitLineOrCsvField(stripeDraft.permissions) as ProviderSettingsByProviderDto<"STRIPE">["permissions"],
        prefetch: splitLineOrCsvField(stripeDraft.prefetch) as ProviderSettingsByProviderDto<"STRIPE">["prefetch"],
        transactionsInitialDays: Number(stripeDraft.transactionsInitialDays),
        automaticSyncConcurrency: Number(stripeDraft.automaticSyncConcurrency)
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
    case "MONO": {
      const monoDraft = draft as MonoSettingsDraft;
      return {
        environment: monoDraft.environment,
        sandbox: {
          publicKey: monoDraft.sandboxPublicKey.trim(),
          secretKey: monoDraft.sandboxSecretKey,
          webhookSecret: monoDraft.sandboxWebhookSecret
        },
        production: {
          publicKey: monoDraft.productionPublicKey.trim(),
          secretKey: monoDraft.productionSecretKey,
          webhookSecret: monoDraft.productionWebhookSecret
        },
        transactionsInitialDays: Number(monoDraft.transactionsInitialDays),
        transactionsOverlapDays: Number(monoDraft.transactionsOverlapDays),
        automaticSyncConcurrency: Number(monoDraft.automaticSyncConcurrency)
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
    case "BELVO": {
      const belvoDraft = draft as BelvoSettingsDraft;
      return {
        environment: belvoDraft.environment,
        sandbox: {
          secretId: belvoDraft.sandboxSecretId.trim(),
          secretPassword: belvoDraft.sandboxSecretPassword,
          webhookAuthorization: belvoDraft.sandboxWebhookAuthorization.trim()
        },
        production: {
          secretId: belvoDraft.productionSecretId.trim(),
          secretPassword: belvoDraft.productionSecretPassword,
          webhookAuthorization: belvoDraft.productionWebhookAuthorization.trim()
        },
        transactionsInitialDays: Number(belvoDraft.transactionsInitialDays),
        transactionsOverlapDays: Number(belvoDraft.transactionsOverlapDays),
        automaticSyncConcurrency: Number(belvoDraft.automaticSyncConcurrency)
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
    case "VEHICLE_VALUES": {
      const vehicleValuesDraft = draft as VehicleValuesSettingsDraft;
      return {
        automaticSyncConcurrency: Number(vehicleValuesDraft.automaticSyncConcurrency),
        kbbFetchMethod: vehicleValuesDraft.kbbFetchMethod,
        hagertyFetchMethod: vehicleValuesDraft.hagertyFetchMethod
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
      setMessage(`${label} settings saved.`);
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
  const stripeDraft = provider === "STRIPE" ? (draft as StripeSettingsDraft) : null;
  const tellerDraft = provider === "TELLER" ? (draft as TellerSettingsDraft) : null;
  const monoDraft = provider === "MONO" ? (draft as MonoSettingsDraft) : null;
  const simpleFinDraft = provider === "SIMPLEFIN" ? (draft as SimpleFinSettingsDraft) : null;
  const belvoDraft = provider === "BELVO" ? (draft as BelvoSettingsDraft) : null;
  const homeValuesDraft = provider === "HOME_VALUES" ? (draft as HomeValuesSettingsDraft) : null;
  const vehicleValuesDraft = provider === "VEHICLE_VALUES" ? (draft as VehicleValuesSettingsDraft) : null;

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

        {stripeDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={stripeDraft.environment}
                onChange={event => {
                  const next = event.target.value as StripeSettingsDraft["environment"];
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    environment: next
                  }));
                }}
              >
                <option value="test">test</option>
                <option value="live">live</option>
              </select>
            </label>
            <label>
              <span>{stripeDraft.environment === "test" ? "Test publishable key" : "Live publishable key"}</span>
              <input
                type="text"
                value={stripeDraft.environment === "test" ? stripeDraft.testPublishableKey : stripeDraft.livePublishableKey}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    ...(stripeDraft.environment === "test"
                      ? { testPublishableKey: next }
                      : { livePublishableKey: next })
                  }));
                }}
                placeholder="pk_test_..."
              />
            </label>
            <label>
              <span>{stripeDraft.environment === "test" ? "Test secret key" : "Live secret key"}</span>
              <input
                type="password"
                value={stripeDraft.environment === "test" ? stripeDraft.testSecretKey : stripeDraft.liveSecretKey}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    ...(stripeDraft.environment === "test" ? { testSecretKey: next } : { liveSecretKey: next })
                  }));
                }}
                placeholder="sk_test_..."
              />
            </label>
            <label className="provider-settings-textarea">
              <span>{stripeDraft.environment === "test" ? "Test webhook signing secrets" : "Live webhook signing secrets"}</span>
              <textarea
                rows={3}
                value={
                  stripeDraft.environment === "test"
                    ? stripeDraft.testWebhookSigningSecrets
                    : stripeDraft.liveWebhookSigningSecrets
                }
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    ...(stripeDraft.environment === "test"
                      ? { testWebhookSigningSecrets: next }
                      : { liveWebhookSigningSecrets: next })
                  }));
                }}
                placeholder="One secret per line"
              />
            </label>
            <label>
              <span>Country codes</span>
              <input
                type="text"
                value={stripeDraft.countryCodes}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    countryCodes: next
                  }));
                }}
                placeholder="US"
              />
            </label>
            <label>
              <span>Permissions</span>
              <input
                type="text"
                value={stripeDraft.permissions}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    permissions: next
                  }));
                }}
                placeholder="balances, transactions"
              />
            </label>
            <label>
              <span>Prefetch</span>
              <input
                type="text"
                value={stripeDraft.prefetch}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
                    prefetch: next
                  }));
                }}
                placeholder="balances, transactions"
              />
            </label>
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                max={180}
                value={stripeDraft.transactionsInitialDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
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
                value={stripeDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as StripeSettingsDraft),
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

        {monoDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={monoDraft.environment}
                onChange={event => {
                  const next = event.target.value as MonoSettingsDraft["environment"];
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
                    environment: next
                  }));
                }}
              >
                <option value="sandbox">sandbox</option>
                <option value="production">production</option>
              </select>
            </label>
            <label>
              <span>{monoDraft.environment === "sandbox" ? "Sandbox public key" : "Production public key"}</span>
              <input
                type="text"
                value={monoDraft.environment === "sandbox" ? monoDraft.sandboxPublicKey : monoDraft.productionPublicKey}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
                    ...(monoDraft.environment === "sandbox" ? { sandboxPublicKey: next } : { productionPublicKey: next })
                  }));
                }}
                placeholder="mono_pub_..."
              />
            </label>
            <label>
              <span>{monoDraft.environment === "sandbox" ? "Sandbox secret key" : "Production secret key"}</span>
              <input
                type="password"
                value={monoDraft.environment === "sandbox" ? monoDraft.sandboxSecretKey : monoDraft.productionSecretKey}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
                    ...(monoDraft.environment === "sandbox" ? { sandboxSecretKey: next } : { productionSecretKey: next })
                  }));
                }}
                placeholder="mono_sec_..."
              />
            </label>
            <label>
              <span>{monoDraft.environment === "sandbox" ? "Sandbox webhook secret" : "Production webhook secret"}</span>
              <input
                type="password"
                value={
                  monoDraft.environment === "sandbox" ? monoDraft.sandboxWebhookSecret : monoDraft.productionWebhookSecret
                }
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
                    ...(monoDraft.environment === "sandbox"
                      ? { sandboxWebhookSecret: next }
                      : { productionWebhookSecret: next })
                  }));
                }}
                placeholder="mono_webhook_secret"
              />
            </label>
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                value={monoDraft.transactionsInitialDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
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
                value={monoDraft.transactionsOverlapDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
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
                value={monoDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as MonoSettingsDraft),
                    automaticSyncConcurrency: next
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

        {belvoDraft ? (
          <>
            <label>
              <span>Environment</span>
              <select
                value={belvoDraft.environment}
                onChange={event => {
                  const next = event.target.value as BelvoSettingsDraft["environment"];
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
                    environment: next
                  }));
                }}
              >
                <option value="sandbox">sandbox</option>
                <option value="production">production</option>
              </select>
            </label>
            <label>
              <span>{belvoDraft.environment === "sandbox" ? "Sandbox secret ID" : "Production secret ID"}</span>
              <input
                type="text"
                value={belvoDraft.environment === "sandbox" ? belvoDraft.sandboxSecretId : belvoDraft.productionSecretId}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
                    ...(belvoDraft.environment === "sandbox" ? { sandboxSecretId: next } : { productionSecretId: next })
                  }));
                }}
                placeholder="Belvo secret id"
              />
            </label>
            <label>
              <span>{belvoDraft.environment === "sandbox" ? "Sandbox secret password" : "Production secret password"}</span>
              <input
                type="password"
                value={
                  belvoDraft.environment === "sandbox"
                    ? belvoDraft.sandboxSecretPassword
                    : belvoDraft.productionSecretPassword
                }
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
                    ...(belvoDraft.environment === "sandbox"
                      ? { sandboxSecretPassword: next }
                      : { productionSecretPassword: next })
                  }));
                }}
                placeholder="Belvo secret password"
              />
            </label>
            <label>
              <span>{belvoDraft.environment === "sandbox" ? "Sandbox webhook Authorization" : "Production webhook Authorization"}</span>
              <input
                type="text"
                value={
                  belvoDraft.environment === "sandbox"
                    ? belvoDraft.sandboxWebhookAuthorization
                    : belvoDraft.productionWebhookAuthorization
                }
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
                    ...(belvoDraft.environment === "sandbox"
                      ? { sandboxWebhookAuthorization: next }
                      : { productionWebhookAuthorization: next })
                  }));
                }}
                placeholder="Bearer your-belvo-webhook-token"
              />
            </label>
            <label>
              <span>Initial transaction window (days)</span>
              <input
                type="number"
                min={1}
                value={belvoDraft.transactionsInitialDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
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
                max={90}
                value={belvoDraft.transactionsOverlapDays}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
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
                value={belvoDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as BelvoSettingsDraft),
                    automaticSyncConcurrency: next
                  }));
                }}
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

        {vehicleValuesDraft ? (
          <>
            <label>
              <span>KBB fetch method</span>
              <select
                value={vehicleValuesDraft.kbbFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as VehicleValuesSettingsDraft),
                    kbbFetchMethod: event.target.value as VehicleValuesSettingsDraft["kbbFetchMethod"]
                  }))
                }
              >
                <option value="curl">curl</option>
                <option value="wget">wget</option>
                <option value="node_fetch">node fetch</option>
                <option value="browser">browser</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              <span>Hagerty fetch method</span>
              <select
                value={vehicleValuesDraft.hagertyFetchMethod}
                onChange={event =>
                  setDraft(current => ({
                    ...(current as VehicleValuesSettingsDraft),
                    hagertyFetchMethod: event.target.value as VehicleValuesSettingsDraft["hagertyFetchMethod"]
                  }))
                }
              >
                <option value="browser">browser</option>
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
                value={vehicleValuesDraft.automaticSyncConcurrency}
                onChange={event => {
                  const next = event.target.value;
                  setDraft(current => ({
                    ...(current as VehicleValuesSettingsDraft),
                    automaticSyncConcurrency: next
                  }));
                }}
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
