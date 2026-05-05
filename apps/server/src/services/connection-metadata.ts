import type { SyncHealthDto } from "@actual-sync/shared";

export function parseConnectionMetadata(json: string | null | undefined): { health?: SyncHealthDto | null } & Record<string, unknown> {
  if (!json) {
    return {};
  }

  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getTellerMetadata(metadata: Record<string, unknown>) {
  return typeof metadata.teller === "object" && metadata.teller ? (metadata.teller as Record<string, unknown>) : {};
}
