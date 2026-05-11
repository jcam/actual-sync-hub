import { describe, expect, it } from "vitest";
import { supportsInlineReauth } from "./provider-ui";

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
