import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppService } from "./app-service.js";
import { ProviderOperationError } from "./sync-health.js";
import { createTestDatabase } from "../test/test-db.js";

describe.sequential("app service automatic sync", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("uses provider batch sync when scheduled links share a SimpleFIN connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "bank"
      }
    });

    const savings = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-2",
        name: "Savings",
        type: "bank"
      }
    });

    const link1 = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: checking.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const link2 = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-2",
        actualAccountName: "Savings",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: savings.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const syncAccountLinks = vi.fn().mockResolvedValue(
      new Map([
        [
          link1.id,
          {
            result: {
              imported: 0,
              transactions: [],
              removedImportedIds: []
            }
          }
        ],
        [
          link2.id,
          {
            result: {
              imported: 0,
              transactions: [],
              removedImportedIds: []
            }
          }
        ]
      ])
    );
    const syncAccountLink = vi.fn();

    const service = createAppService({
      prisma,
      providerSettingsService: {
        getAll: vi.fn().mockResolvedValue({
          PLAID: {
            environment: "sandbox",
            sandbox: {
              clientId: "",
              secret: ""
            },
            production: {
              clientId: "",
              secret: ""
            },
            countryCodes: ["US"],
            products: ["transactions"],
            transactionsDaysRequested: 365,
            personalFinanceCategoryVersion: "v2",
            automaticSyncConcurrency: 2
          },
          TELLER: {
            environment: "sandbox",
            sandbox: {
              appId: "",
              sandboxAccessToken: "",
              webhookSigningSecrets: []
            },
            development: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            production: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            transactionsInitialDays: 90,
            transactionsOverlapDays: 10,
            automaticSyncConcurrency: 1,
            webhookSyncDebounceSeconds: 30,
            webhookToleranceSeconds: 180
          },
          SIMPLEFIN: {
            mode: "sandbox",
            development: {
              serverUrl: ""
            },
            transactionsInitialDays: 45,
            automaticSyncConcurrency: 1
          },
          SALT_EDGE: {
            environment: "test",
            appId: "",
            secret: "",
            consentDays: 90,
            transactionsFetchDays: 90,
            automaticSyncConcurrency: 2
          }
        })
      } as never,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 0,
          updated: 0,
          removed: 0,
          renamedPayees: 0
        }),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink,
        syncAccountLinks
      } as never
    });

    await service.runScheduledLinkSyncs([link1.id, link2.id]);

    expect(syncAccountLinks).toHaveBeenCalledTimes(1);
    expect(syncAccountLinks.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([link1.id, link2.id]));
    expect(syncAccountLink).not.toHaveBeenCalled();

    const updatedLinks = await prisma.accountLink.findMany({
      where: {
        id: {
          in: [link1.id, link2.id]
        }
      }
    });
    expect(updatedLinks.every(link => link.lastSyncedAt)).toBe(true);
  });

  it("skips automatic sync for links blocked on reauth or attention health", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "bank"
      }
    });

    const savings = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-2",
        name: "Savings",
        type: "bank"
      }
    });

    const blockedLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: checking.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({
          health: {
            state: "REAUTH_REQUIRED",
            scope: "BANK_AUTH",
            action: "REAUTH_BANK",
            message: "Bank credentials need repair."
          }
        })
      }
    });

    const eligibleLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-2",
        actualAccountName: "Savings",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: savings.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const syncAccountLinks = vi.fn();
    const syncAccountLink = vi.fn().mockResolvedValue({
      imported: 0,
      transactions: [],
      removedImportedIds: []
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 0,
          updated: 0,
          removed: 0,
          renamedPayees: 0
        }),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink,
        syncAccountLinks
      } as never
    });

    await service.runScheduledLinkSyncs([blockedLink.id, eligibleLink.id]);

    expect(syncAccountLinks).not.toHaveBeenCalled();
    expect(syncAccountLink).toHaveBeenCalledWith(eligibleLink.id);

    const runs = await prisma.syncRun.findMany({
      orderBy: {
        startedAt: "asc"
      }
    });
    expect(runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountLinkId: blockedLink.id,
          status: "SKIPPED",
          summary: expect.stringContaining("Skipped automatic sync")
        }),
        expect.objectContaining({
          accountLinkId: eligibleLink.id,
          status: "SUCCESS"
        })
      ])
    );
  });

  it("backs off automatic sync retries after a failed background sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "bank"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: checking.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const syncAccountLink = vi.fn().mockRejectedValue(new Error("Temporary provider outage"));
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink
      } as never,
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    await service.runScheduledLinkSyncs([link.id]);

    expect(syncAccountLink).toHaveBeenCalledTimes(1);

    const updatedLink = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: link.id
      }
    });
    const updatedConfig = JSON.parse(updatedLink.configJson || "{}");
    expect(updatedConfig.automaticSyncFailureCount).toBe(1);
    expect(updatedConfig.automaticSyncBackoffUntil).toBe("2026-05-05T00:05:00.000Z");

    const retryService = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink
      } as never,
      now: () => new Date("2026-05-05T00:01:00.000Z")
    });

    await retryService.runScheduledLinkSyncs([link.id]);

    expect(syncAccountLink).toHaveBeenCalledTimes(1);
  });

  it("uses a more aggressive automatic backoff for rate-limited provider failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "bank"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: checking.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const syncAccountLink = vi
      .fn()
      .mockRejectedValue(new ProviderOperationError("429 Too Many Requests", {
        code: "RATE_LIMIT_EXCEEDED",
        healthState: "ERROR",
        healthScope: "SYNC_PIPELINE",
        healthAction: "RETRY"
      }));
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink
      } as never,
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    await service.runScheduledLinkSyncs([link.id]);

    const updatedLink = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: link.id
      }
    });
    const updatedConfig = JSON.parse(updatedLink.configJson || "{}");
    expect(updatedConfig.automaticSyncBackoffUntil).toBe("2026-05-05T00:20:00.000Z");
    expect(updatedConfig.automaticSyncFailureCount).toBe(1);
  });

  it("serializes concurrent automatic sync work per provider when the concurrency limit is one", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection1 = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Connection 1",
        providerItemId: "conn-1",
        accessTokenCiphertext: "cipher"
      }
    });
    const connection2 = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Connection 2",
        providerItemId: "conn-2",
        accessTokenCiphertext: "cipher"
      }
    });

    const account1 = await prisma.connectionAccount.create({
      data: {
        connectionId: connection1.id,
        externalAccountId: "acct-1",
        name: "Checking 1",
        type: "bank"
      }
    });
    const account2 = await prisma.connectionAccount.create({
      data: {
        connectionId: connection2.id,
        externalAccountId: "acct-2",
        name: "Checking 2",
        type: "bank"
      }
    });

    const link1 = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking 1",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection1.id,
        connectionAccountId: account1.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });
    const link2 = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-2",
        actualAccountName: "Checking 2",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection2.id,
        connectionAccountId: account2.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const syncAccountLink = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => {
        resolvers.push(() => {
          inFlight -= 1;
          resolve();
        });
      });
      return {
        imported: 0,
        transactions: [],
        removedImportedIds: []
      };
    });

    const service = createAppService({
      prisma,
      providerSettingsService: {
        getAll: vi.fn().mockResolvedValue({
          PLAID: {
            environment: "sandbox",
            sandbox: {
              clientId: "",
              secret: ""
            },
            production: {
              clientId: "",
              secret: ""
            },
            countryCodes: ["US"],
            products: ["transactions"],
            transactionsDaysRequested: 365,
            personalFinanceCategoryVersion: "v2",
            automaticSyncConcurrency: 2
          },
          TELLER: {
            environment: "sandbox",
            sandbox: {
              appId: "",
              sandboxAccessToken: "",
              webhookSigningSecrets: []
            },
            development: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            production: {
              appId: "",
              certificatePem: "",
              keyPem: "",
              webhookSigningSecrets: []
            },
            transactionsInitialDays: 90,
            transactionsOverlapDays: 10,
            automaticSyncConcurrency: 1,
            webhookSyncDebounceSeconds: 30,
            webhookToleranceSeconds: 180
          },
          SIMPLEFIN: {
            mode: "sandbox",
            development: {
              serverUrl: ""
            },
            transactionsInitialDays: 45,
            automaticSyncConcurrency: 1
          },
          SALT_EDGE: {
            environment: "test",
            appId: "",
            secret: "",
            consentDays: 90,
            transactionsFetchDays: 90,
            automaticSyncConcurrency: 2
          }
        })
      } as never,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 0,
          updated: 0,
          removed: 0,
          renamedPayees: 0
        }),
        previewImportTransactions: vi.fn()
      } as never,
      simplefinService: {
        provider: "SIMPLEFIN",
        isConfigured: vi.fn().mockReturnValue(true),
        refreshConnection: vi.fn(),
        syncAccountLink
      } as never,
      runtime: {
        instanceLabel: "Test",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5006",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });

    const firstRun = service.runScheduledLinkSyncs([link1.id]);
    await vi.waitFor(() => {
      expect(syncAccountLink).toHaveBeenCalledTimes(1);
    });

    const secondRun = service.runScheduledLinkSyncs([link2.id]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(syncAccountLink).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    resolvers.shift()?.();
    await vi.waitFor(() => {
      expect(syncAccountLink).toHaveBeenCalledTimes(2);
    });
    expect(maxInFlight).toBe(1);

    resolvers.shift()?.();
    await Promise.all([firstRun, secondRun]);
  });
});
