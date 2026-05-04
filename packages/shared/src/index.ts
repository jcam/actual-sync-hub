export type Provider = "PLAID";
export type ConnectionStatus = "ACTIVE" | "ERROR" | "DISCONNECTED";
export type SyncFrequency = "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
export type AssetType = "BANK";
export type SyncRunStatus = "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";
export type AccountLinkStatus = "ACTIVE" | "MIGRATING" | "INACTIVE" | "ARCHIVED";

export interface SessionDto {
  authenticated: boolean;
  username?: string;
}

export interface RuntimeInfoDto {
  instanceLabel: string;
  liveSandboxMode: boolean;
  plaid: {
    enabled: boolean;
    environment: "sandbox" | "production";
    sandboxToolsEnabled: boolean;
  };
  actual: {
    serverUrl: string;
    budgetSyncIdConfigured: boolean;
  };
}

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
  accounts: ConnectionAccountDto[];
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
  categoryMappings: CategoryMappingDto[];
  seenCategoryNames: string[];
}

export interface CategoryMappingDto {
  sourceCategory: string;
  actualCategoryId: string;
}

export interface ActualCategoryDto {
  id: string;
  name: string;
}

export interface ConnectionAccountOptionDto {
  connectionId: string;
  connectionLabel: string;
  connectionStatus: ConnectionStatus;
  connectionAccountId: string;
  externalAccountId: string;
  provider: Provider;
  institutionName?: string | null;
  accountName: string;
  mask?: string | null;
  type: string;
  subtype?: string | null;
}

export interface MigrationPreviewExistingTransactionDto {
  id: string;
  date: string;
  amount: number;
  importedId?: string | null;
  importedPayee?: string | null;
  notes?: string | null;
  cleared?: boolean | null;
}

export type MigrationPreviewAction = "add" | "update" | "ignore";

export interface MigrationPreviewItemDto {
  importedId: string;
  date: string;
  amount: number;
  payeeName: string;
  importedPayee?: string | null;
  cleared: boolean;
  categoryNames: string[];
  action: MigrationPreviewAction;
  existing?: MigrationPreviewExistingTransactionDto | null;
}

export interface MigrationPreviewDto {
  actualAccountId: string;
  actualAccountName: string;
  linkId: string;
  status: AccountLinkStatus;
  items: MigrationPreviewItemDto[];
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

export interface SyncRunDto {
  id: string;
  accountLinkId?: string | null;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  summary?: string | null;
  error?: string | null;
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

export interface CommitMigrationPayload {
  importedIds: string[];
}
