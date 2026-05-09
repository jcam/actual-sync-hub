import type {
  AccountLinkStatus,
  ActualBankSyncStatus,
  ActualBankSyncSource,
  AssetType,
  ConnectionStatus,
  Provider,
  SyncFrequency
} from "./core.js";
import type { SyncHealthDto } from "./health.js";

export type ProviderSyncStateDto = {
  cursor?: string | null;
  windowStartDate?: string | null;
  windowEndDate?: string | null;
}

export type CategoryMappingDto = {
  sourceCategory: string;
  actualCategoryId: string;
}

export type LinkConfigDto = {
  linkId?: string | null;
  status: AccountLinkStatus;
  actualAccountId: string;
  actualAccountName: string;
  assetType: AssetType;
  provider?: Provider | null;
  connectionId?: string | null;
  connectionAccountId?: string | null;
  syncFrequency: SyncFrequency;
  syncHour?: number | null;
  syncDayOfWeek?: number | null;
  isEnabled: boolean;
  lastSyncedAt?: string | null;
  migrationStartedAt?: string | null;
  migrationCompletedAt?: string | null;
  supersededAt?: string | null;
  replacedByLinkId?: string | null;
  health?: SyncHealthDto | null;
  providerSyncState?: ProviderSyncStateDto | null;
  automaticSyncBackoffUntil?: string | null;
  automaticSyncFailureCount?: number | null;
  categoryMappings: CategoryMappingDto[];
  seenCategoryNames: string[];
}

export type ActualCategoryDto = {
  id: string;
  name: string;
}

export type ConnectionAccountOptionDto = {
  connectionId: string;
  connectionLabel: string;
  connectionStatus: ConnectionStatus;
  connectionHealth?: SyncHealthDto | null;
  connectionAccountId: string;
  externalAccountId: string;
  provider: Provider;
  institutionName?: string | null;
  accountName: string;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  providerConnectionId?: string | null;
  providerConnectionName?: string | null;
  providerInstitutionName?: string | null;
}

export type ActualAccountDto = {
  id: string;
  name: string;
  balance: number;
  offbudget?: boolean;
  closed?: boolean;
  link: LinkConfigDto;
  options: ConnectionAccountOptionDto[];
  actualCategories: ActualCategoryDto[];
}

export type ActualBankSyncLinkDto = {
  actualAccountId: string;
  actualAccountName: string;
  actualOfficialName?: string | null;
  accountSyncSource: ActualBankSyncSource;
  externalAccountId: string;
  actualBankId?: string | null;
  actualBankName?: string | null;
  actualBankExternalId?: string | null;
  mask?: string | null;
  balanceCurrent?: number | null;
  balanceAvailable?: number | null;
  balanceLimit?: number | null;
  closed?: boolean;
  offbudget?: boolean;
  lastSyncedAt?: string | null;
  bankSyncStatus?: ActualBankSyncStatus | null;
  currentLinkId?: string | null;
  currentLinkProvider?: Provider | null;
  currentLinkStatus?: AccountLinkStatus | null;
}

export type ActualExternalSyncStatusDto = {
  configured: boolean;
  state: "ok" | "syncing" | "error" | "reauth_required" | "not_configured";
  message?: string | null;
  lastSync?: string | null;
  canSync: boolean;
  needsReauth: boolean;
}

export type ActualExternalSyncResultDto = {
  errors: Array<{
    accountId: string;
    message: string;
    type?: "SyncError";
    category?: string;
    code?: string;
    internal?: string;
  }>;
  newTransactions: string[];
  matchedTransactions: string[];
  updatedAccounts: string[];
}

export type ExternalSyncBridgeSyncResponseDto = {
  error_code?: string;
  error_type?: string;
  message?: string | null;
  lastSync?: string | null;
  newTransactions: string[];
  matchedTransactions: string[];
  updatedAccounts: string[];
}

export type UpdateAccountLinkPayload = {
  actualAccountName: string;
  assetType: AssetType;
  provider?: Provider | null;
  connectionId?: string | null;
  connectionAccountId?: string | null;
  syncFrequency: SyncFrequency;
  syncHour?: number | null;
  syncDayOfWeek?: number | null;
  isEnabled: boolean;
  categoryMappings: CategoryMappingDto[];
}
