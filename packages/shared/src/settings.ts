import type { Provider } from "./core.js";

export type HomeValuesFetchMethod = "node_fetch" | "curl" | "wget" | "disabled";
export type VehicleValuesFetchMethod = "node_fetch" | "curl" | "wget" | "browser" | "disabled";

export type VehicleValuesProviderSettingsDto = {
  automaticSyncConcurrency: number;
  kbbFetchMethod: VehicleValuesFetchMethod;
  hagertyFetchMethod: VehicleValuesFetchMethod;
};

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

export type StripeFinancialConnectionsPermission =
  | "balances"
  | "transactions"
  | "ownership"
  | "payment_method";

export type StripeFinancialConnectionsPrefetch =
  | "balances"
  | "transactions"
  | "ownership";

export type StripeProviderSettingsDto = {
  environment: "test" | "live";
  test: {
    publishableKey: string;
    secretKey: string;
    webhookSigningSecrets: string[];
  };
  live: {
    publishableKey: string;
    secretKey: string;
    webhookSigningSecrets: string[];
  };
  countryCodes: string[];
  permissions: StripeFinancialConnectionsPermission[];
  prefetch: StripeFinancialConnectionsPrefetch[];
  transactionsInitialDays: number;
  automaticSyncConcurrency: number;
};

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

export type HomeValuesProviderSettingsDto = {
  automaticSyncConcurrency: number;
  redfinFetchMethod: HomeValuesFetchMethod;
  movotoFetchMethod: HomeValuesFetchMethod;
  homesFetchMethod: HomeValuesFetchMethod;
  truliaFetchMethod: HomeValuesFetchMethod;
};

export type ProviderSettingsDto = {
  PLAID: PlaidProviderSettingsDto;
  STRIPE: StripeProviderSettingsDto;
  TELLER: TellerProviderSettingsDto;
  SIMPLEFIN: SimpleFinProviderSettingsDto;
  HOME_VALUES?: HomeValuesProviderSettingsDto;
  VEHICLE_VALUES?: VehicleValuesProviderSettingsDto;
};

export type ProviderSettingsByProviderDto<T extends Provider = Provider> = T extends "PLAID"
  ? PlaidProviderSettingsDto
  : T extends "STRIPE"
    ? StripeProviderSettingsDto
    : T extends "TELLER"
      ? TellerProviderSettingsDto
    : T extends "SIMPLEFIN"
      ? SimpleFinProviderSettingsDto
      : T extends "HOME_VALUES"
        ? HomeValuesProviderSettingsDto
        : VehicleValuesProviderSettingsDto;

export function getActivePlaidEnvironmentSettings(settings: PlaidProviderSettingsDto) {
  return settings[settings.environment];
}

export function getActiveStripeEnvironmentSettings(settings: StripeProviderSettingsDto) {
  return settings[settings.environment];
}

export function getActiveTellerEnvironmentSettings(settings: TellerProviderSettingsDto) {
  return settings[settings.environment];
}

export function getActiveSimpleFinModeSettings(settings: SimpleFinProviderSettingsDto) {
  return settings.mode === "development" ? settings.development : null;
}
