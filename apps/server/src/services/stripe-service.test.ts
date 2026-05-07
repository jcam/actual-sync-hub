import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { createStripeService } from "./stripe-service.js";

describe("stripeService webhooks", () => {
  it("reports webhooks as unconfigured when no signing secrets are present", async () => {
    const service = createStripeService({
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: "test",
          test: {
            publishableKey: "pk_test_123",
            secretKey: "sk_test_123",
            webhookSigningSecrets: []
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
      } as never
    });

    await expect(service.webhooksConfigured()).resolves.toBe(false);
  });

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

  it("accepts webhook signatures signed with any configured secret", async () => {
    const service = createStripeService({
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: "test",
          test: {
            publishableKey: "pk_test_123",
            secretKey: "sk_test_123",
            webhookSigningSecrets: ["whsec_old", "whsec_new"]
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
      } as never
    });

    const stripe = new Stripe("sk_test_123");
    const payload = JSON.stringify({
      id: "evt_test_multi_secret",
      object: "event",
      type: "financial_connections.account.created",
      created: 1_778_000_000,
      data: {
        object: {
          id: "fca_456",
          object: "financial_connections.account",
          authorization: "fcauth_456"
        }
      }
    });
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_new"
    });

    await expect(service.constructWebhookEvent(payload, header)).resolves.toMatchObject({
      id: "evt_test_multi_secret",
      type: "financial_connections.account.created"
    });
  });
});
