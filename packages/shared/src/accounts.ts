import type {
  AccountLinkStatus,
  ActualBankSyncSource,
  AssetType,
  ConnectionStatus,
  Provider,
  SyncFrequency
} from "./core.js";
import type { SyncHealthDto } from "./health.js";

export interface ProviderSyncStateDto {
  cursor?: string | null;
  windowStartDate?: string | null;
  windowEndDate?: string | null;
}

export interface CategoryMappingDto {
  sourceCategory: string;
  actualCategoryId: string;
}

export interface LinkConfigDto {
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

export interface ActualCategoryDto {
  id: string;
  name: string;
}

export interface ConnectionAccountOptionDto {
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
}

export interface ActualAccountDto {
  id: string;
  name: string;
  balance: number;
  offbudget?: boolean;
  closed?: boolean;
  link: LinkConfigDto;
  options: ConnectionAccountOptionDto[];
  actualCategories: ActualCategoryDto[];
}

export interface ActualBankSyncLinkDto {
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
  currentLinkId?: string | null;
  currentLinkProvider?: Provider | null;
  currentLinkStatus?: AccountLinkStatus | null;
}

export interface UpdateAccountLinkPayload {
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
