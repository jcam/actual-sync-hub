export type SyncHealthState = "OK" | "ERROR" | "REAUTH_REQUIRED" | "ATTENTION_REQUIRED";
export type SyncHealthScope = "CONNECTION_AUTH" | "BANK_AUTH" | "SYNC_PIPELINE" | "ACTUAL_BACKEND";
export type SyncHealthAction = "REAUTH_CONNECTION" | "REAUTH_BANK" | "MANUAL_RECONNECT" | "RETRY" | "CHECK_PROVIDER" | "NONE";

export interface SyncHealthDto {
  state: SyncHealthState;
  scope?: SyncHealthScope | null;
  action?: SyncHealthAction | null;
  code?: string | null;
  message?: string | null;
  updatedAt?: string | null;
}
