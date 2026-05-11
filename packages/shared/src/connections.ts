import type { ConnectionStatus, Provider } from "./core.js";
import type { SyncHealthDto } from "./health.js";

export type HomeValueSource = "REDFIN" | "MOVOTO" | "HOMES_COM" | "TRULIA" | "AVERAGE";
export type VehicleValueSource = "KBB" | "EDMUNDS" | "CARMAX" | "HAGERTY" | "AVERAGE";
export type VehicleCondition = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";

export type HomeValueEstimateStateDto = {
  url?: string | null;
  estimate?: number | null;
  lastFetchedAt?: string | null;
  lastSuccessfulAt?: string | null;
  lastFailedAt?: string | null;
  lastFailureMessage?: string | null;
  usingCachedEstimate?: boolean | null;
  stale?: boolean | null;
};

export type TellerConnectConfigDto = {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  selectAccount: "disabled" | "single" | "multiple";
};

export type TellerReauthConfigDto = {
  enrollmentId: string;
} & TellerConnectConfigDto;

export type MonoReauthConfigDto = {
  accountId: string;
  publicKey: string;
  environment: "sandbox" | "production";
};

export type BelvoWidgetSessionDto = {
  accessToken: string;
};

export type ConnectionReauthSessionDto =
  | {
      provider: "PLAID";
      connectionId: string;
      mode: "plaid_update";
      linkToken: string;
    }
  | {
      provider: "TELLER";
      connectionId: string;
      mode: "teller_repair";
      config: TellerReauthConfigDto;
    }
  | {
      provider: "MONO";
      connectionId: string;
      mode: "mono_reauth";
      config: MonoReauthConfigDto;
    }
  | {
      provider: "BELVO";
      connectionId: string;
      mode: "belvo_widget";
      session: BelvoWidgetSessionDto;
    }
  | {
      provider: "STRIPE";
      connectionId: string;
      mode: "stripe_relink";
      sessionId: string;
      clientSecret: string;
      publishableKey: string;
    }
  | {
      provider: "SIMPLEFIN" | "STRIPE";
      connectionId: string;
      mode: "manual";
      message: string;
    };

export type ConnectionAccountDto = {
  id: string;
  externalAccountId: string;
  name: string;
  officialName?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  currentBalance?: number | null;
  availableBalance?: number | null;
  providerConnectionId?: string | null;
  providerConnectionName?: string | null;
  providerInstitutionName?: string | null;
}

export type HomeValueConnectionDetailsDto = {
  address: string;
  source: HomeValueSource;
  redfinEstimate?: number | null;
  redfinUrl?: string | null;
  movotoEstimate?: number | null;
  movotoUrl?: string | null;
  homesEstimate?: number | null;
  homesUrl?: string | null;
  truliaEstimate?: number | null;
  truliaUrl?: string | null;
  sources?: {
    redfin?: HomeValueEstimateStateDto | null;
    movoto?: HomeValueEstimateStateDto | null;
    homes?: HomeValueEstimateStateDto | null;
    trulia?: HomeValueEstimateStateDto | null;
  } | null;
  calculatedValue?: number | null;
  lastCalculatedAt?: string | null;
};

export type VehicleValueConnectionDetailsDto = {
  vin?: string | null;
  year?: number | null;
  make: string;
  model: string;
  trim?: string | null;
  mileage: number;
  zipCode: string;
  condition: VehicleCondition;
  source: VehicleValueSource;
  kbbValue?: number | null;
  kbbUrl?: string | null;
  edmundsValue?: number | null;
  carmaxValue?: number | null;
  hagertyValue?: number | null;
  hagertyUrl?: string | null;
  sources?: {
    kbb?: HomeValueEstimateStateDto | null;
    edmunds?: HomeValueEstimateStateDto | null;
    carmax?: HomeValueEstimateStateDto | null;
    hagerty?: HomeValueEstimateStateDto | null;
  } | null;
  calculatedValue?: number | null;
  lastCalculatedAt?: string | null;
};

export type ConnectionDto = {
  id: string;
  provider: Provider;
  label: string;
  status: ConnectionStatus;
  institutionName?: string | null;
  institutionId?: string | null;
  providerUserId?: string | null;
  providerAccountsUrl?: string | null;
  lastRefreshedAt?: string | null;
  health?: SyncHealthDto | null;
  homeValues?: HomeValueConnectionDetailsDto | null;
  vehicleValues?: VehicleValueConnectionDetailsDto | null;
  accounts: ConnectionAccountDto[];
}

export type ProviderConnectResult = {
  connectionId: string;
  warning?: string;
};

export type UpsertHomeValueConnectionPayload = {
  label?: string | null;
  address: string;
  source: HomeValueSource;
  redfinEstimate?: number | null;
  redfinUrl?: string | null;
  movotoEstimate?: number | null;
  movotoUrl?: string | null;
  homesEstimate?: number | null;
  homesUrl?: string | null;
  truliaEstimate?: number | null;
  truliaUrl?: string | null;
};

export type UpsertVehicleValueConnectionPayload = {
  label?: string | null;
  vin?: string | null;
  year?: number | null;
  make: string;
  model: string;
  trim?: string | null;
  mileage: number;
  zipCode: string;
  condition: VehicleCondition;
  source: VehicleValueSource;
  kbbValue?: number | null;
  kbbUrl?: string | null;
  edmundsValue?: number | null;
  carmaxValue?: number | null;
  hagertyValue?: number | null;
  hagertyUrl?: string | null;
};
