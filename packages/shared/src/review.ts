import type { AccountLinkStatus } from "./core.js";

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

export interface CommitMigrationPayload {
  importedIds: string[];
}
