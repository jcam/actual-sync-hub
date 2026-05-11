import type { SyncHealthAction, SyncHealthDto, SyncHealthScope, SyncHealthState } from "@actual-sync/shared";

export class ProviderOperationError extends Error {
  readonly code: string | undefined;
  readonly healthState: SyncHealthState;
  readonly healthScope: SyncHealthScope;
  readonly healthAction: SyncHealthAction;

  constructor(
    message: string,
    options?: {
      code?: string;
      healthState?: SyncHealthState;
      healthScope?: SyncHealthScope;
      healthAction?: SyncHealthAction;
    }
  ) {
    super(message);
    this.name = "ProviderOperationError";
    this.code = options?.code;
    this.healthState = options?.healthState ?? "ERROR";
    this.healthScope = options?.healthScope ?? "CONNECTION_AUTH";
    this.healthAction = options?.healthAction ?? "RETRY";
  }
}

export function toSyncHealth(
  error: unknown,
  defaults?: {
    state?: SyncHealthState;
    scope?: SyncHealthScope;
    action?: SyncHealthAction;
    code?: string | null;
  }
): SyncHealthDto {
  if (error instanceof ProviderOperationError) {
    return {
      state: error.healthState,
      scope: error.healthScope,
      action: error.healthAction,
      code: error.code ?? null,
      message: error.message,
      updatedAt: new Date().toISOString()
    };
  }

  if (error instanceof Error) {
    return {
      state: defaults?.state ?? "ERROR",
      scope: defaults?.scope ?? "SYNC_PIPELINE",
      action: defaults?.action ?? "RETRY",
      code: defaults?.code ?? null,
      message: error.message,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    state: defaults?.state ?? "ERROR",
    scope: defaults?.scope ?? "SYNC_PIPELINE",
    action: defaults?.action ?? "RETRY",
    code: defaults?.code ?? null,
    message: String(error),
    updatedAt: new Date().toISOString()
  };
}

export function clearSyncHealth(): null {
  return null;
}

export function isBlockingSyncHealth(health: SyncHealthDto | null | undefined) {
  return health?.state === "REAUTH_REQUIRED" || health?.state === "ATTENTION_REQUIRED";
}

export function isRateLimitedSyncError(error: unknown) {
  if (error instanceof ProviderOperationError) {
    return error.code === "RATE_LIMIT_EXCEEDED";
  }

  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    return normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("too many requests");
  }

  return false;
}
