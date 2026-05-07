import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createStripeService } from "./stripe-service.js";

describe("stripeService webhooks", () => {
  it("verifies and constructs Stripe webhook events with configured signing secrets", async () => {
    const providerSettings = {
      get: vi.fn().mockResolvedValue({
        environment: "test",
        test: {
          publishableKey: "pk_test_123",
          secretKey: "sk_test_123",
          webhookSigningSecrets: ["whsec_test_123"]
        },
        live: {
          publishableKey: "",
          secretKey: "",
          webhookSigningSecrets: []
        },
        countryCodes: ["US"],
        permissions: ["balances", "transactions"],
        prefetch: ["balances", "transactions"],
        transactionsInitialDays: 90,
        automaticSyncConcurrency: 2
      })
    };

    const service = createStripeService({
      providerSettings: providerSettings as never
    });

    const stripe = new Stripe("sk_test_123");
    const payload = JSON.stringify({
      id: "evt_test_webhook",
      object: "event",
      type: "financial_connections.account.deactivated",
      created: 1_778_000_000,
      data: {
        object: {
          id: "fca_123",
          object: "financial_connections.account",
          authorization: "fcauth_123"
        }
      }
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_test_123"
    });

    await expect(service.webhooksConfigured()).resolves.toBe(true);
    await expect(service.constructWebhookEvent(payload, header)).resolves.toMatchObject({
      id: "evt_test_webhook",
      type: "financial_connections.account.deactivated"
    });
    await expect(service.constructWebhookEvent(payload, "t=123,v1=deadbeef")).resolves.toBeNull();
  });
});
