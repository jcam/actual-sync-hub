import type { ConnectionReauthSessionDto, Provider } from "@actual-sync/shared";
import type { LinkConfigData } from "./link-config.js";

export type ProviderSyncTransaction = {
  date: string;
  amount: number;
  payeeName: string;
  importedPayee?: string;
  notes?: string;
  importedId: string;
  cleared: boolean;
  categoryNames?: string[];
  searchText?: string[];
}

export type ProviderBalanceSnapshot = {
  asOfDate: string;
  currentValue: number;
  availableValue?: number | null;
  stableId: string;
  payeeName: string;
  importedPayee?: string;
  notes?: string;
  searchText?: string[];
}

export type ProviderSyncResult = {
  imported: number;
  transactions: ProviderSyncTransaction[];
  removedImportedIds: string[];
  balanceSnapshot?: ProviderBalanceSnapshot | null;
  configPatch?: Partial<LinkConfigData>;
}

export type ProviderSyncOutcome = {
  result?: ProviderSyncResult;
  error?: unknown;
}

export type ProviderAdapter = {
  provider: Provider;
  isConfigured(): boolean;
  createReauthSession?(args: { connectionId: string; userId: string }): Promise<ConnectionReauthSessionDto>;
  disconnectConnection?(connectionId: string): Promise<void>;
  refreshConnection(connectionId: string): Promise<void>;
  syncAccountLink(linkId: string): Promise<ProviderSyncResult>;
  syncAccountLinks?(linkIds: string[]): Promise<Map<string, ProviderSyncOutcome>>;
}
