import type { AccountLinkStatus } from "./core.js";

export type MigrationPreviewExistingTransactionDto = {
  id: string;
  date: string;
  amount: number;
  importedId?: string | null;
  importedPayee?: string | null;
  notes?: string | null;
  cleared?: boolean | null;
}

export type MigrationPreviewAction = "add" | "update" | "ignore";

export type MigrationPreviewItemDto = {
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

export type MigrationPreviewDto = {
  snapshotId: string;
  actualAccountId: string;
  actualAccountName: string;
  linkId: string;
  status: AccountLinkStatus;
  items: MigrationPreviewItemDto[];
}

export type CommitMigrationPayload = {
  snapshotId: string;
  importedIds: string[];
}
