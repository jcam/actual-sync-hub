import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAutomaticSyncPauseSummary,
  getConnectionHealthSummary,
  getProviderConnectionsLabel,
  getProviderConnectionsPath,
  getSyncHealthActionLabel,
  getSyncHealthBadge,
  getSyncHealthSummary,
  supportsInlineReauth
} from "./provider-ui";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));
});

describe("supportsInlineReauth", () => {
  it("allows Stripe inline relink for manual reconnect health actions", () => {
    expect(
      supportsInlineReauth(
        {
          state: "REAUTH_REQUIRED",
          scope: "BANK_AUTH",
          action: "MANUAL_RECONNECT",
          code: "ACCOUNT_RELINK_REQUIRED",
          message: "Stripe account needs to be reauthenticated.",
          updatedAt: "2026-05-08T00:00:00.000Z"
        },
        "STRIPE"
      )
    ).toBe(true);
  });

  it("still suppresses providers without inline reauth support", () => {
    expect(
      supportsInlineReauth(
        {
          state: "REAUTH_REQUIRED",
          scope: "BANK_AUTH",
          action: "MANUAL_RECONNECT",
          code: "REQUIRES_SETUP_TOKEN",
          message: "SimpleFIN requires a new setup token.",
          updatedAt: "2026-05-08T00:00:00.000Z"
        },
        "SIMPLEFIN"
      )
    ).toBe(false);
  });
});

describe("provider-ui helpers", () => {
  it("maps provider routes and labels with sensible fallbacks", () => {
    expect(getProviderConnectionsPath("PLAID")).toBe("/plaid-connections");
    expect(getProviderConnectionsPath("BELVO")).toBe("/belvo-connections");
    expect(getProviderConnectionsPath(undefined)).toBe("/accounts");
    expect(getProviderConnectionsLabel("BELVO")).toBe("Belvo Connections");
    expect(getProviderConnectionsLabel("TELLER")).toBe("Teller.io Connections");
    expect(getProviderConnectionsLabel(null)).toBe("Connections");
  });

  it("summarizes sync health and connection health by scope", () => {
    expect(getSyncHealthSummary({
      state: "ERROR",
      scope: "ACTUAL_BACKEND",
      action: "RETRY",
      code: "ACTUAL_IMPORT_FAILED",
      message: "Actual failed",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("Actual import or reconciliation failed.");
    expect(getSyncHealthSummary({
      state: "ATTENTION_REQUIRED",
      scope: null,
      action: "CHECK_PROVIDER",
      code: null,
      message: "Needs review",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("Provider attention required.");

    expect(getConnectionHealthSummary({
      state: "REAUTH_REQUIRED",
      scope: "CONNECTION_AUTH",
      action: "REAUTH_CONNECTION",
      code: "BROKEN_CONNECTION",
      message: "Reconnect",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("This saved provider connection needs to be reconnected.");
    expect(getConnectionHealthSummary({
      state: "ERROR",
      scope: null,
      action: "RETRY",
      code: null,
      message: "Error",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("The provider connection reported an error.");
  });

  it("maps action labels and badge tones", () => {
    expect(getSyncHealthActionLabel({
      state: "REAUTH_REQUIRED",
      scope: "BANK_AUTH",
      action: "REAUTH_BANK",
      code: "ITEM_LOGIN_REQUIRED",
      message: "Reconnect bank",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("Repair bank connection");
    expect(getSyncHealthActionLabel({
      state: "ERROR",
      scope: null,
      action: null,
      code: null,
      message: "Fallback",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toBe("Reconnect");

    expect(getSyncHealthBadge({
      state: "REAUTH_REQUIRED",
      scope: "CONNECTION_AUTH",
      action: "REAUTH_CONNECTION",
      code: "BROKEN_CONNECTION",
      message: "Reconnect",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toEqual({
      label: "Provider connection broken",
      tone: "danger"
    });
    expect(getSyncHealthBadge({
      state: "ERROR",
      scope: null,
      action: "RETRY",
      code: null,
      message: "Unknown issue",
      updatedAt: "2026-05-11T12:00:00.000Z"
    })).toEqual({
      label: "Sync issue",
      tone: "neutral"
    });
  });

  it("describes automatic sync pauses, including rate-limit backoff", () => {
    expect(getAutomaticSyncPauseSummary({
      automaticSyncBackoffUntil: "2026-05-11T13:00:00.000Z",
      automaticSyncFailureCount: 3,
      health: {
        state: "ERROR",
        scope: "SYNC_PIPELINE",
        action: "RETRY",
        code: "RATE_LIMIT_EXCEEDED",
        message: "Rate limited",
        updatedAt: "2026-05-11T12:00:00.000Z"
      }
    })).toContain("because the provider rate-limited recent sync attempts after 3 automatic failures.");

    expect(getAutomaticSyncPauseSummary({
      automaticSyncBackoffUntil: "2026-05-11T11:00:00.000Z",
      automaticSyncFailureCount: 1,
      health: null
    })).toBeNull();
  });
});
