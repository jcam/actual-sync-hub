import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";
import { createTellerService } from './teller-service.js';
import type { TellerConfig } from './teller-service.js';

describe.sequential("teller service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("syncs Teller transactions with an overlapping date window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));

    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token")
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true,
        configJson: JSON.stringify({
          providerSyncState: {
            windowEndDate: "2026-05-01"
          }
        })
      }
    });

    const request = vi.fn().mockResolvedValue([
      {
        id: "txn-1",
        account_id: "acct-ext-1",
        date: "2026-05-03",
        amount: "-12.34",
        description: "Coffee Shop",
        status: "posted",
        type: "card_payment",
        details: {
          category: "dining",
          counterparty: {
            name: "Coffee Shop"
          }
        }
      },
      {
        id: "txn-2",
        account_id: "acct-ext-1",
        date: "2026-05-04",
        amount: "250.00",
        description: "Transfer to Savings",
        status: "pending",
        type: "transfer",
        details: {
          category: "general",
          counterparty: {
            name: "My Savings"
          }
        }
      }
    ]);

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    const result = await service.syncAccountLink(link.id);

    expect(request).toHaveBeenCalledOnce();
    const path = request.mock.calls[0]?.[0]?.path as string;
    const url = new URL(`https://api.teller.test${path}`);
    expect(url.pathname).toBe("/accounts/acct-ext-1/transactions");
    expect(url.searchParams.get("start_date")).toBe("2026-04-21");
    expect(url.searchParams.get("end_date")).toBe("2026-05-04");
    expect(url.searchParams.get("count")).toBe("500");

    expect(result.configPatch).toEqual({
      providerSyncState: {
        cursor: null,
        windowStartDate: "2026-04-21",
        windowEndDate: "2026-05-04"
      }
    });
    expect(result.removedImportedIds).toEqual([]);
    expect(result.transactions).toEqual([
      {
        amount: -12.34,
        categoryNames: ["Dining"],
        cleared: true,
        date: "2026-05-03",
        importedId: "txn-1",
        importedPayee: "Coffee Shop",
        notes: undefined,
        payeeName: "Coffee Shop",
        searchText: ["Coffee Shop", "card_payment"]
      },
      {
        amount: 250,
        categoryNames: ["TRANSFER", "General"],
        cleared: false,
        date: "2026-05-04",
        importedId: "txn-2",
        importedPayee: "Transfer to Savings",
        notes: "Transfer to Savings",
        payeeName: "My Savings",
        searchText: ["Transfer to Savings", "My Savings", "transfer"]
      }
    ]);
  });

  it("verifies Teller webhook signatures against configured secrets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T00:00:00.000Z"));

    const signedTimestamp = String(Math.floor(new Date("2026-05-05T00:00:00.000Z").getTime() / 1000));
    const rawBody = JSON.stringify({
      id: "wh-1",
      type: "webhook.test",
      timestamp: "2026-05-05T00:00:00Z",
      payload: {}
    });
    const signature = (await import("node:crypto"))
      .createHmac("sha256", "secret-1")
      .update(`${signedTimestamp}.${rawBody}`)
      .digest("hex");

    const service = createTellerService({
      providerSettings: {
        get: vi.fn().mockResolvedValue({
          environment: "sandbox",
          sandbox: {
            appId: "teller-app-id",
            sandboxAccessToken: "",
            webhookSigningSecrets: ["secret-1"]
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
          webhookSyncDebounceSeconds: 30
        })
      } as never,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: ["secret-1"],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request: vi.fn()
    });

    await expect(service.webhooksConfigured()).resolves.toBe(true);
    await expect(service.verifyWebhookSignature(rawBody, `t=${signedTimestamp},v1=${signature}`)).resolves.toBe(true);
    await expect(service.verifyWebhookSignature(rawBody, `t=${signedTimestamp},v1=deadbeef`)).resolves.toBe(false);
  });

  it("classifies Teller token failures as provider connection reauth failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token"),
        metadataJson: JSON.stringify({})
      }
    });

    const request = vi.fn().mockRejectedValue(new Error("authentication token expired"));

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "REAUTH_CONNECTION"
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const metadata = JSON.parse(refreshed.metadataJson || "{}");

    expect(refreshed.status).toBe("ERROR");
    expect(metadata.health).toMatchObject({
      state: "REAUTH_REQUIRED",
      scope: "CONNECTION_AUTH",
      action: "REAUTH_CONNECTION"
    });
  });

  it("classifies Teller MFA failures as bank reauth failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token"),
        metadataJson: JSON.stringify({})
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "acct-ext-1",
        name: "Checking",
        type: "depository"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Sandbox Checking",
        assetType: "BANK",
        provider: "TELLER",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const request = vi.fn().mockRejectedValue(new Error("mfa challenge required"));

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    await expect(service.syncAccountLink(link.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      healthState: "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "REAUTH_BANK"
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const metadata = JSON.parse(refreshed.metadataJson || "{}");

    expect(refreshed.status).toBe("ERROR");
    expect(metadata.health).toMatchObject({
      state: "REAUTH_REQUIRED",
      scope: "BANK_AUTH",
      action: "REAUTH_BANK"
    });
  });

  it("classifies Teller rate limits as retryable sync pipeline failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token"),
        metadataJson: JSON.stringify({})
      }
    });

    const request = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  });

  it("revokes Teller enrollment access when disconnecting a connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token")
      }
    });

    const request = vi.fn().mockResolvedValue(null);

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    await expect(service.disconnectConnection?.(connection.id)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({
      accessToken: "teller-token",
      path: "/accounts",
      method: "DELETE"
    });
  });

  it("treats already-invalid Teller enrollments as disconnected during cleanup", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Primary Teller",
        providerItemId: "enr-123",
        accessTokenCiphertext: encryptString("teller-token")
      }
    });

    const request = vi.fn().mockRejectedValue(new Error("authentication token expired"));

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    await expect(service.disconnectConnection?.(connection.id)).resolves.toBeUndefined();
  });

  it("reuses a cached Teller fixture when available", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const request = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "acct-1",
          enrollment_id: "enr-123",
          institution: {
            id: "security_cu",
            name: "Security Credit Union"
          },
          name: "Checking",
          type: "depository",
          subtype: "checking",
          last_four: "1234",
          links: {
            balances: "/accounts/acct-1/balances"
          }
        }
      ])
      .mockResolvedValueOnce({
        ledger: "1500.00",
        available: "1500.00"
      });

    const fixtureCache = {
      isEnabled: () => true,
      getSimpleFin: vi.fn(),
      setSimpleFin: vi.fn(),
      clearSimpleFin: vi.fn(),
      getTeller: vi.fn().mockResolvedValue({
        accessToken: "cached-token",
        enrollmentId: "enr-123",
        institutionName: "Security Credit Union",
        userId: "usr-123",
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      setTeller: vi.fn(),
      clearTeller: vi.fn()
    };

    const service = createTellerService({
      prisma,
      fixtureCache,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request
    });

    const result = await service.reuseCachedConnection("Cached Teller");
    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: result.connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(connection.label).toBe("Cached Teller");
    expect(connection.accounts).toHaveLength(1);
    expect(fixtureCache.getTeller).toHaveBeenCalledOnce();
  });

  it("requires a sandbox access token before seeding a Teller sandbox connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createTellerService({
      prisma,
      config: {
        appId: "teller-app-id",
        environment: "sandbox",
        certificateFile: "",
        keyFile: "",
        sandboxAccessToken: "",
        transactionsInitialDays: 90,
        transactionsOverlapDays: 10,
        webhookSigningSecrets: [],
        webhookToleranceSeconds: 180
      } satisfies TellerConfig,
      request: vi.fn()
    });

    await expect(service.seedSandboxConnection("Sandbox Teller")).rejects.toThrow(
      "Teller sandbox access token is required to seed a sandbox connection"
    );
  });
});
