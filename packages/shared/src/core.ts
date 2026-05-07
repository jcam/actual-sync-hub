export type Provider = "PLAID" | "TELLER" | "SIMPLEFIN" | "HOME_VALUES";
export type ActualBankSyncSource = "simpleFin" | "goCardless" | "pluggyai" | "external";
export type ConnectionStatus = "ACTIVE" | "ERROR" | "DISCONNECTED";
export type SyncFrequency = "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
export type AssetType = "BANK";
export type SyncRunStatus = "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED";
export type AccountLinkStatus = "ACTIVE" | "MIGRATING" | "INACTIVE" | "ARCHIVED";
