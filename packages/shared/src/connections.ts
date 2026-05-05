import type { ConnectionStatus, Provider } from "./core.js";
import type { SyncHealthDto } from "./health.js";

export interface TellerConnectConfigDto {
  applicationId: string;
  environment: "sandbox" | "development" | "production";
  products: string[];
  selectAccount: "disabled" | "single" | "multiple";
}

export interface TellerReauthConfigDto extends TellerConnectConfigDto {
  enrollmentId: string;
}

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
      provider: "SIMPLEFIN";
      connectionId: string;
      mode: "manual";
      message: string;
    };

export interface ConnectionAccountDto {
  id: string;
  externalAccountId: string;
  name: string;
  officialName?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  currentBalance?: number | null;
  availableBalance?: number | null;
}

export interface ConnectionDto {
  id: string;
  provider: Provider;
  label: string;
  status: ConnectionStatus;
  institutionName?: string | null;
  institutionId?: string | null;
  lastRefreshedAt?: string | null;
  health?: SyncHealthDto | null;
  accounts: ConnectionAccountDto[];
}
