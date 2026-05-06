import type { SyncRunStatus } from "./core.js";

export type SyncRunDto = {
  id: string;
  accountLinkId?: string | null;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt?: string | null;
  summary?: string | null;
  error?: string | null;
}
