import type { LinkConfigDto, Provider, SyncHealthDto } from "@actual-sync/shared";

export function getProviderConnectionsPath(provider: Provider | null | undefined) {
  if (!provider) {
    return "/accounts";
  }

  switch (provider) {
    case "PLAID":
      return "/plaid-connections";
    case "STRIPE":
      return "/stripe-connections";
    case "TELLER":
      return "/teller-connections";
    case "SIMPLEFIN":
      return "/simplefin-connections";
    case "HOME_VALUES":
      return "/home-values-connections";
    case "VEHICLE_VALUES":
      return "/vehicle-values-connections";
    default:
      return "/accounts";
  }
}

export function getProviderConnectionsLabel(provider: Provider | null | undefined) {
  if (!provider) {
    return "Connections";
  }

  switch (provider) {
    case "PLAID":
      return "Plaid Connections";
    case "STRIPE":
      return "Stripe Connections";
    case "TELLER":
      return "Teller.io Connections";
    case "SIMPLEFIN":
      return "SimpleFIN Connections";
    case "HOME_VALUES":
      return "Home Values";
    case "VEHICLE_VALUES":
      return "Vehicle Values";
    default:
      return "Connections";
  }
}

export function getSyncHealthSummary(health: SyncHealthDto) {
  if (health.scope === "BANK_AUTH") {
    return "The linked bank account needs attention through the provider.";
  }

  if (health.scope === "CONNECTION_AUTH") {
    return "This provider connection needs to be repaired.";
  }

  if (health.scope === "ACTUAL_BACKEND") {
    return "Actual import or reconciliation failed.";
  }

  if (health.scope === "SYNC_PIPELINE") {
    return "This sync run failed before import completed.";
  }

  switch (health.state) {
    case "REAUTH_REQUIRED":
      return "Reconnect required.";
    case "ATTENTION_REQUIRED":
      return "Provider attention required.";
    case "ERROR":
      return "Sync error.";
    case "OK":
    default:
      return "Healthy.";
  }
}

export function getConnectionHealthSummary(health: SyncHealthDto) {
  if (health.scope === "BANK_AUTH") {
    return "The upstream bank relationship needs repair through this provider.";
  }

  if (health.scope === "CONNECTION_AUTH") {
    return "This saved provider connection needs to be reconnected.";
  }

  switch (health.state) {
    case "REAUTH_REQUIRED":
      return "Connection credentials need to be refreshed.";
    case "ATTENTION_REQUIRED":
      return "The upstream provider needs attention.";
    case "ERROR":
      return "The provider connection reported an error.";
    case "OK":
    default:
      return "Healthy.";
  }
}

export function getSyncHealthActionLabel(health: SyncHealthDto) {
  if (!health.action) {
    return "Reconnect";
  }

  switch (health.action) {
    case "REAUTH_BANK":
      return "Repair bank connection";
    case "REAUTH_CONNECTION":
      return "Reconnect provider";
    case "CHECK_PROVIDER":
      return "Review provider connection";
    case "MANUAL_RECONNECT":
      return "Reconnect manually";
    case "NONE":
      return "No action required";
    case "RETRY":
      return "Retry sync";
    default:
      return "Reconnect";
  }
}

export function supportsInlineReauth(health: SyncHealthDto, provider: Provider | null | undefined) {
  if (!provider || provider === "SIMPLEFIN" || provider === "HOME_VALUES" || provider === "VEHICLE_VALUES") {
    return false;
  }

  return (
    health.action === "REAUTH_BANK" ||
    health.action === "REAUTH_CONNECTION" ||
    (provider === "STRIPE" && health.action === "MANUAL_RECONNECT")
  );
}

export function getSyncHealthBadge(health: SyncHealthDto) {
  if (!health.scope) {
    return {
      label: "Sync issue",
      tone: "neutral"
    } as const;
  }

  switch (health.scope) {
    case "BANK_AUTH":
      return {
        label: "Bank needs attention",
        tone: "warning"
      } as const;
    case "CONNECTION_AUTH":
      return {
        label: "Provider connection broken",
        tone: "danger"
      } as const;
    case "ACTUAL_BACKEND":
      return {
        label: "Actual sync failed",
        tone: "neutral"
      } as const;
    case "SYNC_PIPELINE":
      return {
        label: "Sync pipeline failed",
        tone: "neutral"
      } as const;
    default:
      return {
        label: "Sync issue",
        tone: "neutral"
      } as const;
  }
}

export function getAutomaticSyncPauseSummary(link: Pick<LinkConfigDto, "automaticSyncBackoffUntil" | "automaticSyncFailureCount" | "health">) {
  if (!link.automaticSyncBackoffUntil) {
    return null;
  }

  const backoffUntil = Date.parse(link.automaticSyncBackoffUntil);
  if (!Number.isFinite(backoffUntil) || backoffUntil <= Date.now()) {
    return null;
  }

  const when = new Date(backoffUntil).toLocaleString();
  const failureCount = link.automaticSyncFailureCount ?? 0;
  const repeatedFailures = failureCount > 1 ? ` after ${failureCount} automatic failures` : "";

  if (link.health?.code === "RATE_LIMIT_EXCEEDED") {
    return `Automatic sync is paused until ${when} because the provider rate-limited recent sync attempts${repeatedFailures}.`;
  }

  return `Automatic sync is paused until ${when}${repeatedFailures}.`;
}
