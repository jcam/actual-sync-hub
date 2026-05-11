import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createProviderSettingsService } from "./provider-settings-service.js";

describe("createProviderSettingsService", () => {
  it("returns defaults when no rows are stored", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      const service = createProviderSettingsService({
        prisma
      });

      await expect(service.get("PLAID")).resolves.toEqual(expect.objectContaining({
        environment: "sandbox",
        countryCodes: ["US"],
        automaticSyncConcurrency: 2
      }));
      await expect(service.get("BELVO")).resolves.toEqual(expect.objectContaining({
        environment: "sandbox",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 7,
        automaticSyncConcurrency: 2
      }));
    } finally {
      await cleanup();
    }
  });

  it("falls back to defaults when stored settings are invalid JSON", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      await prisma.providerSetting.create({
        data: {
          provider: "HOME_VALUES",
          settingsJson: "{not-json"
        }
      });

      const service = createProviderSettingsService({
        prisma
      });

      await expect(service.get("HOME_VALUES")).resolves.toEqual({
        automaticSyncConcurrency: 1,
        redfinFetchMethod: "curl",
        movotoFetchMethod: "curl",
        homesFetchMethod: "wget",
        truliaFetchMethod: "wget"
      });
    } finally {
      await cleanup();
    }
  });

  it("reconciles Stripe back to test when live keys are missing but test keys exist", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      await prisma.providerSetting.create({
        data: {
          provider: "STRIPE",
          settingsJson: JSON.stringify({
            environment: "live",
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
        }
      });

      const service = createProviderSettingsService({
        prisma
      });

      await expect(service.get("STRIPE")).resolves.toEqual(expect.objectContaining({
        environment: "test"
      }));
    } finally {
      await cleanup();
    }
  });

  it("parses and returns all providers while falling back for invalid rows", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      await prisma.providerSetting.createMany({
        data: [
          {
            provider: "PLAID",
            settingsJson: JSON.stringify({
              environment: "production",
              sandbox: {
                clientId: "sandbox-client",
                secret: "sandbox-secret"
              },
              production: {
                clientId: "prod-client",
                secret: "prod-secret"
              },
              countryCodes: ["US", "CA"],
              products: ["transactions"],
              transactionsDaysRequested: 180,
              personalFinanceCategoryVersion: "v2",
              automaticSyncConcurrency: 3
            })
          },
          {
            provider: "SIMPLEFIN",
            settingsJson: "null"
          }
        ]
      });

      const service = createProviderSettingsService({
        prisma
      });
      const settings = await service.getAll();

      expect(settings.PLAID.environment).toBe("production");
      expect(settings.PLAID.countryCodes).toEqual(["US", "CA"]);
      expect(settings.SIMPLEFIN).toEqual({
        mode: "sandbox",
        development: {
          serverUrl: ""
        },
        transactionsInitialDays: 45,
        automaticSyncConcurrency: 2
      });
    } finally {
      await cleanup();
    }
  });

  it("persists normalized Stripe settings on update", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      const service = createProviderSettingsService({
        prisma
      });

      const updated = await service.update("STRIPE", {
        environment: "live",
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
        prefetch: ["balances"],
        transactionsInitialDays: 90,
        automaticSyncConcurrency: 2
      });

      expect(updated.environment).toBe("test");

      const stored = await prisma.providerSetting.findUniqueOrThrow({
        where: {
          provider: "STRIPE"
        }
      });

      expect(JSON.parse(stored.settingsJson)).toEqual(expect.objectContaining({
        environment: "test"
      }));
    } finally {
      await cleanup();
    }
  });
});
