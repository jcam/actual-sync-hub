import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppService } from "./app-service.js";
import { createTestDatabase } from "../test/test-db.js";

describe.sequential("app service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("clears the saved Plaid cursor when the provider mapping changes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const firstAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const secondAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Savings",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: firstAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({ plaidCursor: "cursor-1" })
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn()
      } as never,
      plaidService: {
        syncAccountLink: vi.fn()
      } as never
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: secondAccount.id,
      syncFrequency: "DAILY",
      isEnabled: true,
      categoryMappings: []
    });

    const link = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });

    expect(JSON.parse(link.configJson || "{}")).toEqual({
      health: null,
      categoryMappings: [],
      seenCategoryNames: []
    });
  });

  it("surfaces existing Actual bank-sync links alongside current local link state", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-current",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-current",
        name: "Checking",
        type: "depository"
      }
    });

    const currentLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listBankSyncLinks: vi.fn().mockResolvedValue([
          {
            actualAccountId: "actual-1",
            actualAccountName: "Checking",
            actualOfficialName: "Main Checking",
            accountSyncSource: "simpleFin",
            externalAccountId: "sf-account-1",
            actualBankId: "bank-row-1",
            actualBankName: "SimpleFIN Credit Union",
            actualBankExternalId: "credit-union.example",
            mask: "1111",
            balanceCurrent: 321.45,
            balanceAvailable: 300.12,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: "2026-05-05"
          },
          {
            actualAccountId: "actual-2",
            actualAccountName: "Savings",
            actualOfficialName: null,
            accountSyncSource: "goCardless",
            externalAccountId: "gc-account-2",
            actualBankId: null,
            actualBankName: null,
            actualBankExternalId: null,
            mask: null,
            balanceCurrent: null,
            balanceAvailable: null,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: null
          }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        previewImportTransactions: vi.fn()
      } as never
    });

    const links = await service.listActualBankSyncLinks();

    expect(links).toEqual([
      {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        actualOfficialName: "Main Checking",
        accountSyncSource: "simpleFin",
        externalAccountId: "sf-account-1",
        actualBankId: "bank-row-1",
        actualBankName: "SimpleFIN Credit Union",
        actualBankExternalId: "credit-union.example",
        mask: "1111",
        balanceCurrent: 321.45,
        balanceAvailable: 300.12,
        balanceLimit: null,
        closed: false,
        offbudget: false,
        lastSyncedAt: "2026-05-05",
        currentLinkId: currentLink.id,
        currentLinkProvider: "TELLER",
        currentLinkStatus: "ACTIVE"
      },
      {
        actualAccountId: "actual-2",
        actualAccountName: "Savings",
        actualOfficialName: null,
        accountSyncSource: "goCardless",
        externalAccountId: "gc-account-2",
        actualBankId: null,
        actualBankName: null,
        actualBankExternalId: null,
        mask: null,
        balanceCurrent: null,
        balanceAvailable: null,
        balanceLimit: null,
        closed: false,
        offbudget: false,
        lastSyncedAt: null,
        currentLinkId: null,
        currentLinkProvider: null,
        currentLinkStatus: null
      }
    ]);
  });

  it("disables a tracked local link when Actual unlinks the native external account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Primary SimpleFIN",
        providerItemId: "simplefin-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: JSON.stringify({
          actualExternalLinked: true
        })
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        getCapabilities: vi.fn().mockResolvedValue({
          externalSyncWritebackEnabled: true
        }),
        listAccounts: vi.fn().mockResolvedValue([
          {
            id: "actual-1",
            name: "Checking",
            balance: 0,
            offbudget: false,
            closed: false
          }
        ]),
        listCategories: vi.fn().mockResolvedValue([]),
        listBankSyncLinks: vi.fn().mockResolvedValue([])
      } as never,
      runtime: {
        instanceLabel: "test",
        liveSandboxMode: false,
        actualServerUrl: "http://actual.local",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });

    const accounts = await service.listActualAccounts();

    expect(accounts).toEqual([
      expect.objectContaining({
        id: "actual-1",
        link: expect.objectContaining({
          isEnabled: false,
          health: expect.objectContaining({
            state: "ATTENTION_REQUIRED",
            code: "ACTUAL_UNLINKED"
          })
        })
      })
    ]);

    const persisted = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1"
      }
    });
    const config = JSON.parse(persisted.configJson || "{}");

    expect(persisted.isEnabled).toBe(false);
    expect(config.actualExternalLinked).toBeUndefined();
    expect(config.health).toMatchObject({
      state: "ATTENTION_REQUIRED",
      code: "ACTUAL_UNLINKED"
    });
  });

  it("surfaces persisted Teller user ids in connection listings", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: "cipher",
        metadataJson: JSON.stringify({
          teller: {
            enrollmentId: "enr-123",
            userId: "usr-123"
          }
        })
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listBankSyncLinks: vi.fn().mockResolvedValue([])
      } as never
    });

    await expect(service.listConnections()).resolves.toEqual([
      expect.objectContaining({
        provider: "TELLER",
        providerUserId: "usr-123"
      })
    ]);
  });

  it("reports unified provider readiness details in runtime info", async () => {
    const service = createAppService({
      actualService: {
        getCapabilities: vi.fn().mockResolvedValue({
          externalSyncWritebackEnabled: false
        })
      } as never,
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
            transactionsDaysRequested: 30,
            personalFinanceCategoryVersion: "v2",
            automaticSyncConcurrency: 2
          },
          TELLER: {
            environment: "development",
            sandbox: {
              appId: "",
              sandboxAccessToken: ""
            },
            development: {
              appId: "app_test_123",
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
            transactionsInitialDays: 30,
            transactionsOverlapDays: 3,
            automaticSyncConcurrency: 1,
            webhookSyncDebounceSeconds: 30
          },
          SIMPLEFIN: {
            mode: "sandbox",
            development: {
              serverUrl: ""
            },
            transactionsInitialDays: 45,
            automaticSyncConcurrency: 2
          }
        })
      } as never,
      runtime: {
        instanceLabel: "Dev Sandbox",
        liveSandboxMode: true,
        actualServerUrl: "http://127.0.0.1:5007",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });

    const runtime = await service.getRuntimeInfo();

    expect(runtime.providers).toEqual([
      expect.objectContaining({
        provider: "PLAID",
        ready: false,
        issues: ["Enter a Plaid client ID and secret to enable Plaid connections."]
      }),
      expect.objectContaining({
        provider: "TELLER",
        ready: false,
        issues: ["Enter Teller client certificate and key PEM values to enable non-sandbox Teller connections."]
      }),
      expect.objectContaining({
        provider: "SIMPLEFIN",
        ready: true
      })
    ]);
  });

  it("disconnects a provider connection and disables its active links", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher",
        metadataJson: JSON.stringify({
          plaid: {
            linkedAt: "2026-05-05T00:00:00.000Z"
          }
        })
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const disconnectConnection = vi.fn().mockResolvedValue(undefined);
    const disconnectedAt = new Date("2026-05-06T12:00:00.000Z");

    const service = createAppService({
      prisma,
      plaidService: {
        disconnectConnection
      } as never,
      now: () => disconnectedAt
    });

    await service.disconnectConnection(connection.id);

    const updatedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const updatedLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        connectionId: connection.id
      }
    });
    const metadata = JSON.parse(updatedConnection.metadataJson || "{}") as {
      health?: { action?: string; code?: string };
      plaid?: { disconnectedAt?: string };
    };

    expect(disconnectConnection).toHaveBeenCalledWith(connection.id);
    expect(updatedConnection.status).toBe("DISCONNECTED");
    expect(metadata.health).toMatchObject({
      action: "REAUTH_CONNECTION",
      code: "DISCONNECTED"
    });
    expect(metadata.plaid?.disconnectedAt).toBe(disconnectedAt.toISOString());
    expect(updatedLink.isEnabled).toBe(false);
  });

  it("writes external-sync metadata through Actual when the feature gate is enabled", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary Plaid",
        institutionName: "First Platypus Bank",
        institutionId: "platypus-bank",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-checking",
        name: "Checking",
        officialName: "Household Checking",
        mask: "1234",
        type: "depository",
        currentBalance: 1500.25,
        availableBalance: 1400
      }
    });

    const linkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);
    const unlinkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        linkExternalSyncAccount,
        unlinkExternalSyncAccount
      } as never,
      runtime: {
        instanceLabel: "Dev Sandbox",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5007",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: connectionAccount.id,
      syncFrequency: "MANUAL",
      isEnabled: true,
      categoryMappings: []
    });

    expect(linkExternalSyncAccount).toHaveBeenCalledWith("actual-1", {
      syncSource: "external",
      providerAccountId: "ext-checking",
      institutionName: "First Platypus Bank",
      institutionExternalId: "platypus-bank",
      mask: "1234",
      officialName: "Household Checking",
      balanceCurrent: 150025,
      balanceAvailable: 140000,
      balanceLimit: null,
      lastSync: null
    });
    expect(unlinkExternalSyncAccount).not.toHaveBeenCalled();
  });

  it("writes external-sync metadata even when the local link is disabled", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Plaid Household",
        institutionId: "platypus-bank",
        institutionName: "First Platypus Bank",
        providerItemId: "item-123",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-checking",
        name: "Checking",
        officialName: "Household Checking",
        mask: "1234",
        type: "depository",
        currentBalance: 1500.25,
        availableBalance: 1400
      }
    });

    const linkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);

    const service = createAppService({
      prisma,
      actualService: {
        getCapabilities: vi.fn().mockResolvedValue({
          externalSyncWritebackEnabled: true
        }),
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        linkExternalSyncAccount,
        unlinkExternalSyncAccount: vi.fn().mockResolvedValue(undefined)
      } as never,
      runtime: {
        instanceLabel: "Dev Sandbox",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5007",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      }
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: connectionAccount.id,
      syncFrequency: "MANUAL",
      isEnabled: false,
      categoryMappings: []
    });

    expect(linkExternalSyncAccount).toHaveBeenCalledWith("actual-1", {
      syncSource: "external",
      providerAccountId: "ext-checking",
      institutionName: "First Platypus Bank",
      institutionExternalId: "platypus-bank",
      mask: "1234",
      officialName: "Household Checking",
      balanceCurrent: 150025,
      balanceAvailable: 140000,
      balanceLimit: null,
      lastSync: null
    });
  });

  it("imports matching existing Actual SimpleFIN links into local account links", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.org|user",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "sf-checking",
        name: "Checking",
        type: "bank"
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "sf-savings",
        name: "Savings",
        type: "bank"
      }
    });

    const otherConnection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Other provider",
        providerItemId: "item-other",
        accessTokenCiphertext: "cipher"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-existing",
        actualAccountName: "Already linked elsewhere",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: otherConnection.id,
        connectionAccountId: null,
        syncFrequency: "MANUAL",
        isEnabled: false
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listBankSyncLinks: vi.fn().mockResolvedValue([
          {
            actualAccountId: "actual-checking",
            actualAccountName: "Household Checking",
            actualOfficialName: "Household Checking",
            accountSyncSource: "simpleFin",
            externalAccountId: "sf-checking",
            actualBankId: "bank-row-1",
            actualBankName: "SimpleFIN CU",
            actualBankExternalId: "simplefin.example",
            mask: null,
            balanceCurrent: 123.45,
            balanceAvailable: null,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: "2026-05-05"
          },
          {
            actualAccountId: "actual-missing",
            actualAccountName: "No matching provider account",
            actualOfficialName: null,
            accountSyncSource: "simpleFin",
            externalAccountId: "sf-missing",
            actualBankId: "bank-row-2",
            actualBankName: "SimpleFIN CU",
            actualBankExternalId: "simplefin.example",
            mask: null,
            balanceCurrent: 0,
            balanceAvailable: null,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: null
          },
          {
            actualAccountId: "actual-existing",
            actualAccountName: "Already linked elsewhere",
            actualOfficialName: null,
            accountSyncSource: "simpleFin",
            externalAccountId: "sf-checking",
            actualBankId: "bank-row-3",
            actualBankName: "SimpleFIN CU",
            actualBankExternalId: "simplefin.example",
            mask: null,
            balanceCurrent: 0,
            balanceAvailable: null,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: null
          }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn(),
        previewImportTransactions: vi.fn()
      } as never
    });

    const summary = await service.importExistingSimpleFinLinks(connection.id);

    expect(summary).toEqual({
      imported: 1,
      updated: 0,
      skipped: 1,
      unmatched: 1
    });

    const importedLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-checking",
        provider: "SIMPLEFIN"
      }
    });
    expect(importedLink.connectionId).toBe(connection.id);
    expect(importedLink.connectionAccountId).toBe(checking.id);
    expect(importedLink.syncFrequency).toBe("MANUAL");
    expect(importedLink.isEnabled).toBe(false);
  });

  it("clears the saved Teller sync window when the provider mapping changes", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const firstAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-1",
        name: "Checking",
        type: "depository"
      }
    });

    const secondAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-2",
        name: "Savings",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        connectionAccountId: firstAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({ tellerLastSyncEndDate: "2026-05-01" })
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn()
      } as never,
      tellerService: {
        syncAccountLink: vi.fn()
      } as never
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "TELLER",
      connectionId: connection.id,
      connectionAccountId: secondAccount.id,
      syncFrequency: "DAILY",
      isEnabled: true,
      categoryMappings: []
    });

    const link = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });

    expect(JSON.parse(link.configJson || "{}")).toEqual({
      health: null,
      categoryMappings: [],
      seenCategoryNames: []
    });
  });

  it("disables Teller links when an enrollment is disconnected", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-1",
        accessTokenCiphertext: "cipher",
        metadataJson: JSON.stringify({
          teller: {
            environment: "sandbox"
          }
        })
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const service = createAppService({
      prisma
    });

    await service.handleTellerWebhook({
      id: "wh-1",
      type: "enrollment.disconnected",
      timestamp: "2026-05-05T00:00:00Z",
      payload: {
        enrollment_id: "enr-1",
        reason: "disconnected.credentials_invalid"
      }
    });

    const updatedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const updatedLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        connectionId: connection.id
      }
    });

    expect(updatedConnection.status).toBe("DISCONNECTED");
    expect(updatedConnection.metadataJson).toContain("disconnected.credentials_invalid");
    expect(updatedLink.isEnabled).toBe(false);
  });

  it("runs scheduled Teller links when a transactions webhook arrives", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-2",
        accessTokenCiphertext: "cipher"
      }
    });

    await prisma.accountLink.createMany({
      data: [
        {
          actualAccountId: "actual-1",
          actualAccountName: "Scheduled Account",
          assetType: "BANK",
          provider: "TELLER",
          connectionId: connection.id,
          syncFrequency: "DAILY",
          isEnabled: true
        },
        {
          actualAccountId: "actual-2",
          actualAccountName: "Manual Account",
          assetType: "BANK",
          provider: "TELLER",
          connectionId: connection.id,
          syncFrequency: "MANUAL",
          isEnabled: true
        }
      ]
    });

    const service = createAppService({
      prisma,
      tellerService: {
        provider: "TELLER",
        isConfigured: vi.fn().mockReturnValue(true),
        getConnectConfig: vi.fn(),
        enrollConnection: vi.fn(),
        seedSandboxConnection: vi.fn(),
        webhooksConfigured: vi.fn().mockReturnValue(true),
        verifyWebhookSignature: vi.fn().mockReturnValue(true),
        syncAccountLink: vi.fn()
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
    const runScheduledLinkSyncs = vi.spyOn(service, "runScheduledLinkSyncs").mockResolvedValue(undefined);

    await service.handleTellerWebhook({
      id: "wh-2",
      type: "transactions.processed",
      timestamp: "2026-05-05T00:00:00Z",
      payload: {
        enrollment_id: "enr-2",
        transactions: []
      }
    });

    expect(runScheduledLinkSyncs).toHaveBeenCalledTimes(1);
    expect(runScheduledLinkSyncs).toHaveBeenCalledWith([expect.any(String)]);
  });

  it("debounces repeated Teller transactions webhooks for the same connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-2",
        accessTokenCiphertext: "cipher"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Scheduled Account",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const service = createAppService({
      prisma,
      tellerService: {
        provider: "TELLER",
        isConfigured: vi.fn().mockReturnValue(true),
        getConnectConfig: vi.fn(),
        enrollConnection: vi.fn(),
        seedSandboxConnection: vi.fn(),
        webhooksConfigured: vi.fn().mockReturnValue(true),
        verifyWebhookSignature: vi.fn().mockReturnValue(true),
        syncAccountLink: vi.fn()
      } as never,
      runtime: {
        instanceLabel: "Test",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5006",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      },
      now: () => new Date("2026-05-05T00:00:10.000Z")
    });
    const runScheduledLinkSyncs = vi.spyOn(service, "runScheduledLinkSyncs").mockResolvedValue(undefined);

    await prisma.connection.update({
      where: {
        id: connection.id
      },
      data: {
        metadataJson: JSON.stringify({
          teller: {
            lastWebhookSyncStartedAt: "2026-05-05T00:00:00.000Z"
          }
        })
      }
    });

    await service.handleTellerWebhook({
      id: "wh-3",
      type: "transactions.processed",
      timestamp: "2026-05-05T00:00:10Z",
      payload: {
        enrollment_id: "enr-2",
        transactions: []
      }
    });

    expect(runScheduledLinkSyncs).not.toHaveBeenCalled();

    const updatedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const metadata = JSON.parse(updatedConnection.metadataJson || "{}");
    expect(metadata.teller.lastWebhookSkipReason).toBe("debounced");
  });

  it("creates a migrating replacement link when a synced provider link is switched", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const firstAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const secondAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Savings",
        type: "depository"
      }
    });

    const originalLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: firstAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        lastSyncedAt: new Date("2026-05-03T12:00:00.000Z"),
        configJson: JSON.stringify({ plaidCursor: "cursor-1" })
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: originalLink.id,
        importedId: "old-1",
        primarySourceCategory: "Groceries",
        appliedCategoryId: null,
        observedCategoryId: null
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn()
      } as never,
      plaidService: {
        syncAccountLink: vi.fn()
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z")
    });

    await service.upsertAccountLink("actual-1", {
      actualAccountName: "Household Checking",
      assetType: "BANK",
      provider: "PLAID",
      connectionId: connection.id,
      connectionAccountId: secondAccount.id,
      syncFrequency: "DAILY",
      isEnabled: true,
      categoryMappings: []
    });

    const links = await prisma.accountLink.findMany({
      where: {
        actualAccountId: "actual-1"
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      id: originalLink.id,
      status: "INACTIVE",
      isEnabled: false
    });
    expect(links[1]).toMatchObject({
      status: "MIGRATING",
      connectionAccountId: secondAccount.id,
      isEnabled: true
    });
    expect(links[0]?.replacedByLinkId).toBe(links[1]?.id);
  });

  it("records a successful sync run and updates the stored cursor", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });
    const syncedTransactions = [
      {
        date: "2026-05-03",
        amount: -12.34,
        payeeName: "Coffee Shop",
        importedPayee: "COFFEE SHOP",
        importedId: "plaid-1",
        cleared: true,
        categoryNames: ["Food And Drink"],
        searchText: ["Coffee Shop"]
      }
    ];
    const now = new Date("2026-05-04T12:00:00.000Z");
    const linkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);
    const unlinkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-food", name: "Food" }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions,
        linkExternalSyncAccount,
        unlinkExternalSyncAccount
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: syncedTransactions,
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-2"
            }
          }
        })
      } as never,
      runtime: {
        instanceLabel: "Dev Sandbox",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5007",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      },
      now: () => now
    });

    await service.runAccountSync("actual-1");

    const link = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: {
          in: ["ACTIVE", "MIGRATING"]
        }
      }
    });
    const runs = await prisma.syncRun.findMany();
    const importedTransactions = await prisma.importedTransaction.findMany();

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [
      {
        amount: -12.34,
        category_names: ["Food And Drink"],
        cleared: true,
        date: "2026-05-03",
        imported_id: "plaid-1",
        imported_payee: "COFFEE SHOP",
        notes: undefined,
        payee_name: "Coffee Shop",
        resolved_category_id: "cat-food",
        transfer_actual_account_id: undefined
      }
    ], [], []);
    expect(link.lastSyncedAt?.toISOString()).toBe(now.toISOString());
    expect(link.configJson).toContain("\"cursor\":\"cursor-2\"");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("SUCCESS");
    expect(runs[0]?.summary).toBe("Imported 1 transactions, updated 0, removed 0.");
    expect(importedTransactions).toHaveLength(1);
    expect(importedTransactions[0]).toMatchObject({
      importedId: "plaid-1",
      primarySourceCategory: "Food And Drink",
      appliedCategoryId: "cat-food",
      observedCategoryId: "cat-food"
    });
  });

  it("writes lastSync through external writeback metadata updates", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        institutionId: "platypus-bank",
        institutionName: "First Platypus Bank",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        officialName: "Plaid checking",
        mask: "1234",
        type: "depository",
        currentBalance: 500,
        availableBalance: 442
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const now = new Date("2026-05-04T12:00:00.000Z");
    const linkExternalSyncAccount = vi.fn().mockResolvedValue(undefined);
    const service = createAppService({
      prisma,
      actualService: {
        getCapabilities: vi.fn().mockResolvedValue({
          externalSyncWritebackEnabled: true
        }),
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listBankSyncLinks: vi.fn().mockResolvedValue([
          {
            actualAccountId: "actual-1",
            actualAccountName: "Household Checking",
            actualOfficialName: "Plaid checking",
            accountSyncSource: "external",
            externalAccountId: "ext-1",
            actualBankId: null,
            actualBankName: "First Platypus Bank",
            actualBankExternalId: "platypus-bank",
            mask: "1234",
            balanceCurrent: 400,
            balanceAvailable: 300,
            balanceLimit: null,
            closed: false,
            offbudget: false,
            lastSyncedAt: "1715000000000"
          }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 0,
          updated: 0,
          removed: 0,
          renamedPayees: 0,
          addedIds: [],
          updatedIds: []
        }),
        linkExternalSyncAccount,
        unlinkExternalSyncAccount: vi.fn().mockResolvedValue(undefined)
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 0,
          transactions: [],
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-2"
            }
          }
        })
      } as never,
      runtime: {
        instanceLabel: "Dev Sandbox",
        liveSandboxMode: false,
        actualServerUrl: "http://127.0.0.1:5007",
        actualBudgetSyncIdConfigured: true,
        automaticSyncBackoffBaseMinutes: 5,
        automaticSyncBackoffMaxMinutes: 60
      },
      now: () => now
    });

    await service.runAccountSync("actual-1");

    expect(linkExternalSyncAccount).toHaveBeenCalledWith("actual-1", {
      syncSource: "external",
      providerAccountId: "ext-1",
      institutionName: "First Platypus Bank",
      institutionExternalId: "platypus-bank",
      mask: "1234",
      officialName: "Plaid checking",
      balanceCurrent: 50000,
      balanceAvailable: 44200,
      balanceLimit: null,
      lastSync: String(now.getTime())
    });
  });

  it("promotes a migrating link after the first sync using Actual import reconciliation", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-2",
        name: "Replacement Checking",
        type: "depository"
      }
    });

    await prisma.accountLink.create({
      data: {
        status: "MIGRATING",
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        migrationStartedAt: new Date("2026-05-04T11:00:00.000Z")
      }
    });

    const importTransactions = vi.fn().mockResolvedValue({
      added: ["txn-new"],
      updated: ["txn-existing"],
      errors: []
    });
    const reconcileTransactions = vi.fn();
    const syncTime = new Date("2026-05-04T12:00:00.000Z");

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-food", name: "Food" }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([
          {
            id: "txn-existing",
            imported_id: "plaid-1",
            date: "2026-05-03",
            amount: -12.34,
            category: "cat-food"
          }
        ]),
        importTransactions,
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-03",
              amount: -12.34,
              payeeName: "Coffee Shop",
              importedPayee: "COFFEE SHOP",
              importedId: "plaid-1",
              cleared: true,
              categoryNames: ["Food And Drink"],
              searchText: ["Coffee Shop"]
            }
          ],
          removedImportedIds: ["plaid-1"],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-migrated"
            }
          }
        })
      } as never,
      now: () => syncTime
    });

    await service.runAccountSync("actual-1");

    expect(importTransactions).toHaveBeenCalledWith("actual-1", [
      expect.objectContaining({
        imported_id: "plaid-1",
        category: "cat-food"
      })
    ]);
    expect(reconcileTransactions).not.toHaveBeenCalled();

    const currentLink = await prisma.accountLink.findFirstOrThrow({
      where: {
        actualAccountId: "actual-1",
        status: "ACTIVE"
      }
    });
    const syncRuns = await prisma.syncRun.findMany({
      orderBy: {
        startedAt: "desc"
      }
    });
    const ledgerRows = await prisma.importedTransaction.findMany();

    expect(currentLink.migrationCompletedAt?.toISOString()).toBe(syncTime.toISOString());
    expect(currentLink.lastSyncedAt?.toISOString()).toBe(syncTime.toISOString());
    expect(currentLink.configJson).toContain("\"cursor\":\"cursor-migrated\"");
    expect(syncRuns[0]?.summary).toBe("Migration sync imported 1 transactions, updated 1, removed 0.");
    expect(ledgerRows[0]).toMatchObject({
      importedId: "plaid-1",
      appliedCategoryId: "cat-food",
      observedCategoryId: "cat-food"
    });
  });

  it("passes a transfer target hint when a Plaid transfer appears to match another mapped account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const checking = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-checking",
        name: "Checking",
        officialName: "Main Checking",
        mask: "1111",
        type: "depository"
      }
    });

    const savings = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-savings",
        name: "Savings",
        officialName: "Rainy Day Savings",
        mask: "2222",
        type: "depository"
      }
    });

    await prisma.accountLink.createMany({
      data: [
        {
          actualAccountId: "actual-checking",
          actualAccountName: "Household Checking",
          assetType: "BANK",
          provider: "PLAID",
          connectionId: connection.id,
          connectionAccountId: checking.id,
          syncFrequency: "DAILY",
          isEnabled: true
        },
        {
          actualAccountId: "actual-savings",
          actualAccountName: "Emergency Savings",
          assetType: "BANK",
          provider: "PLAID",
          connectionId: connection.id,
          connectionAccountId: savings.id,
          syncFrequency: "DAILY",
          isEnabled: true
        }
      ]
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-03",
              amount: -50,
              payeeName: "Transfer to Rainy Day Savings",
              importedPayee: "Transfer to Rainy Day Savings",
              importedId: "plaid-transfer-1",
              cleared: true,
              categoryNames: ["Transfer Out"],
              searchText: ["Rainy Day Savings"]
            }
          ],
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-2"
            }
          }
        })
      } as never
    });

    await service.runAccountSync("actual-checking");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-checking", [
      expect.objectContaining({
        category_names: ["Transfer Out"],
        imported_id: "plaid-transfer-1",
        resolved_category_id: undefined,
        transfer_actual_account_id: "actual-savings"
      })
    ], [], []);
  });

  it("learns a category mapping from recent Actual recategorizations without storing full transactions", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true,
        configJson: JSON.stringify({
          categoryMappings: [],
          seenCategoryNames: ["Groceries"]
        })
      }
    });

    await prisma.importedTransaction.createMany({
      data: [
        {
          accountLinkId: link.id,
          importedId: "old-1",
          transactionDate: "2026-05-01",
          primarySourceCategory: "Groceries",
          appliedCategoryId: null,
          observedCategoryId: null
        },
        {
          accountLinkId: link.id,
          importedId: "old-2",
          transactionDate: "2026-05-02",
          primarySourceCategory: "Groceries",
          appliedCategoryId: null,
          observedCategoryId: null
        }
      ]
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 1,
      updated: 0,
      removed: 0,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-groceries", name: "Groceries" }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([
          {
            id: "txn-1",
            imported_id: "old-1",
            date: "2026-05-01",
            amount: -12.5,
            category: "cat-groceries"
          },
          {
            id: "txn-2",
            imported_id: "old-2",
            date: "2026-05-02",
            amount: -20,
            category: "cat-groceries"
          }
        ]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-04",
              amount: -9.99,
              payeeName: "Corner Market",
              importedPayee: "CORNER MARKET",
              importedId: "new-1",
              cleared: true,
              categoryNames: ["Groceries", "Food And Drink"],
              searchText: ["Corner Market"]
            }
          ],
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-3"
            }
          }
        })
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z")
    });

    await service.runAccountSync("actual-1");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [
      expect.objectContaining({
        imported_id: "new-1",
        resolved_category_id: "cat-groceries"
      })
    ], [], []);

    const refreshedLink = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: link.id
      }
    });
    expect(JSON.parse(refreshedLink.configJson || "{}").categoryMappings).toEqual([
      {
        sourceCategory: "Groceries",
        actualCategoryId: "cat-groceries"
      }
    ]);
  });

  it("prunes stale imported-transaction ledger rows during sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: link.id,
        importedId: "old-stale",
        primarySourceCategory: "Groceries",
        appliedCategoryId: "cat-groceries",
        observedCategoryId: "cat-groceries",
        lastSeenAt: new Date("2025-10-01T00:00:00.000Z")
      }
    });

    const currentTime = new Date("2026-05-04T12:00:00.000Z");
    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([
          { id: "cat-groceries", name: "Groceries" }
        ]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockResolvedValue({
          added: 1,
          updated: 0,
          removed: 0,
          renamedPayees: 0
        })
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-04",
              amount: -9.99,
              payeeName: "Corner Market",
              importedPayee: "CORNER MARKET",
              importedId: "new-1",
              cleared: true,
              categoryNames: ["Groceries"],
              searchText: ["Corner Market"]
            }
          ],
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-4"
            }
          }
        })
      } as never,
      now: () => currentTime
    });

    await service.runAccountSync("actual-1");

    const ledgerRows = await prisma.importedTransaction.findMany({
      orderBy: {
        importedId: "asc"
      }
    });

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.importedId).toBe("new-1");
  });

  it("removes deleted Plaid transactions by imported id and clears their ledger rows", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    await prisma.importedTransaction.create({
      data: {
        accountLinkId: link.id,
        importedId: "gone-1",
        primarySourceCategory: "Groceries",
        appliedCategoryId: "cat-groceries",
        observedCategoryId: "cat-groceries"
      }
    });

    const reconcileTransactions = vi.fn().mockResolvedValue({
      added: 0,
      updated: 0,
      removed: 1,
      renamedPayees: 0
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 0,
          transactions: [],
          removedImportedIds: ["gone-1"],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-5"
            }
          }
        })
      } as never
    });

    await service.runAccountSync("actual-1");

    expect(reconcileTransactions).toHaveBeenCalledWith("actual-1", [], ["gone-1"], []);
    expect(await prisma.importedTransaction.count()).toBe(0);
  });

  it("persists Actual backend failures on the account link instead of treating them as reauth problems", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "PLAID",
        label: "Primary",
        providerItemId: "item-1",
        accessTokenCiphertext: "cipher"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "PLAID",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const service = createAppService({
      prisma,
      actualService: {
        listAccounts: vi.fn(),
        listCategories: vi.fn().mockResolvedValue([]),
        listTransactionsByDateRange: vi.fn().mockResolvedValue([]),
        importTransactions: vi.fn(),
        reconcileTransactions: vi.fn().mockRejectedValue(new Error("Actual import failed"))
      } as never,
      plaidService: {
        syncAccountLink: vi.fn().mockResolvedValue({
          imported: 1,
          transactions: [
            {
              date: "2026-05-04",
              amount: -9.99,
              payeeName: "Corner Market",
              importedPayee: "CORNER MARKET",
              importedId: "new-1",
              cleared: true,
              categoryNames: [],
              searchText: ["Corner Market"]
            }
          ],
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: "cursor-6"
            }
          }
        })
      } as never
    });

    await expect(service.runAccountSync("actual-1")).rejects.toThrow("Actual import failed");

    const refreshedLink = await prisma.accountLink.findUniqueOrThrow({
      where: {
        id: link.id
      }
    });
    const config = JSON.parse(refreshedLink.configJson || "{}");
    const runs = await prisma.syncRun.findMany();

    expect(config.health).toMatchObject({
      state: "ERROR",
      scope: "ACTUAL_BACKEND",
      action: "RETRY",
      message: "Actual import failed"
    });
    expect(runs[0]).toMatchObject({
      status: "FAILED",
      error: "Actual import failed"
    });
  });

});
