import type { ConnectionReauthSessionDto, Provider } from "@actual-sync/shared";
import type { LinkConfigData } from "./link-config.js";

export interface ProviderSyncTransaction {
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

export interface ProviderSyncResult {
  imported: number;
  transactions: ProviderSyncTransaction[];
  removedImportedIds: string[];
  configPatch?: Partial<LinkConfigData>;
}

export interface ProviderSyncOutcome {
  result?: ProviderSyncResult;
  error?: unknown;
}

export interface ProviderAdapter {
  provider: Provider;
  isConfigured(): boolean;
  createReauthSession?(args: { connectionId: string; userId: string }): Promise<ConnectionReauthSessionDto>;
  refreshConnection(connectionId: string): Promise<void>;
  syncAccountLink(linkId: string): Promise<ProviderSyncResult>;
  syncAccountLinks?(linkIds: string[]): Promise<Map<string, ProviderSyncOutcome>>;
}
