import type { SyncHealthDto } from "@actual-sync/shared";
import { parseJsonObject } from "../lib/json.js";

export function parseConnectionMetadata(json: string | null | undefined): { health?: SyncHealthDto | null } & Record<string, unknown> {
  if (!json) {
    return {};
  }

  try {
    const parsed = parseJsonObject(json);
    return parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function getTellerMetadata(metadata: Record<string, unknown>) {
  return typeof metadata.teller === "object" && metadata.teller ? (metadata.teller as Record<string, unknown>) : {};
}

export function getStripeMetadata(metadata: Record<string, unknown>) {
  return typeof metadata.stripe === "object" && metadata.stripe ? (metadata.stripe as Record<string, unknown>) : {};
}
