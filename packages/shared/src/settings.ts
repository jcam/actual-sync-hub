import type { Provider } from "./core.js";

export type HomeValuesFetchMethod = "node_fetch" | "curl" | "wget" | "disabled";

export type PlaidProviderSettingsDto = {
  environment: "sandbox" | "production";
  sandbox: {
    clientId: string;
    secret: string;
  };
  production: {
    clientId: string;
    secret: string;
  };
  countryCodes: string[];
  products: string[];
  transactionsDaysRequested: number;
  personalFinanceCategoryVersion: "v1" | "v2";
  automaticSyncConcurrency: number;
}

export type TellerProviderSettingsDto = {
  environment: "sandbox" | "development" | "production";
  sandbox: {
    appId: string;
    sandboxAccessToken: string;
    webhookSigningSecrets?: string[];
  };
  development: {
    appId: string;
    certificatePem: string;
    keyPem: string;
    webhookSigningSecrets: string[];
  };
  production: {
    appId: string;
    certificatePem: string;
    keyPem: string;
    webhookSigningSecrets: string[];
  };
  transactionsInitialDays: number;
  transactionsOverlapDays: number;
  automaticSyncConcurrency: number;
  webhookSyncDebounceSeconds: number;
  webhookToleranceSeconds: number;
}

export type SimpleFinProviderSettingsDto = {
  mode: "sandbox" | "development" | "production";
  development: {
    serverUrl: string;
  };
  transactionsInitialDays: number;
  automaticSyncConcurrency: number;
}

export type SaltEdgeEnvironment = "sandbox" | "test" | "production";

export type SaltEdgeProviderSettingsDto = {
  environment: SaltEdgeEnvironment;
  appId: string;
  secret: string;
  consentDays: number;
  transactionsFetchDays: number;
  automaticSyncConcurrency: number;
};

export type HomeValuesProviderSettingsDto = {
  automaticSyncConcurrency: number;
  redfinFetchMethod: HomeValuesFetchMethod;
  movotoFetchMethod: HomeValuesFetchMethod;
  homesFetchMethod: HomeValuesFetchMethod;
  truliaFetchMethod: HomeValuesFetchMethod;
};

export type ProviderSettingsDto = {
  PLAID: PlaidProviderSettingsDto;
  TELLER: TellerProviderSettingsDto;
  SIMPLEFIN: SimpleFinProviderSettingsDto;
  SALT_EDGE: SaltEdgeProviderSettingsDto;
  HOME_VALUES?: HomeValuesProviderSettingsDto;
};

export type ProviderSettingsByProviderDto<T extends Provider = Provider> = T extends "PLAID"
  ? PlaidProviderSettingsDto
  : T extends "TELLER"
    ? TellerProviderSettingsDto
    : T extends "SIMPLEFIN"
      ? SimpleFinProviderSettingsDto
      : T extends "SALT_EDGE"
        ? SaltEdgeProviderSettingsDto
      : HomeValuesProviderSettingsDto;

export function getActivePlaidEnvironmentSettings(settings: PlaidProviderSettingsDto) {
  return settings[settings.environment];
}

export function getActiveTellerEnvironmentSettings(settings: TellerProviderSettingsDto) {
  return settings[settings.environment];
}

export function getActiveSimpleFinModeSettings(settings: SimpleFinProviderSettingsDto) {
  return settings.mode === "development" ? settings.development : null;
}

export function getSaltEdgeIncludeSandboxes(settings: Pick<SaltEdgeProviderSettingsDto, "environment">) {
  return settings.environment === "sandbox";
}
