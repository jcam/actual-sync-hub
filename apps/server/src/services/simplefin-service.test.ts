import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createSimpleFinFixtureServer } from "../test/simplefin-fixture.js";
import { createSimpleFinService } from "./simplefin-service.js";

describe("simplefin service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("connects a SimpleFIN setup token and persists discovered accounts", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const setupToken = Buffer.from("https://setup.simplefin.test/token").toString("base64");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("https://alice:secret@bridge.simplefin.test", {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accounts: [
              {
                id: "acct-1",
                name: "Checking",
                balance: "123.45",
                org: {
                  id: "org-1",
                  name: "SimpleFIN Credit Union",
                  domain: "credit-union.example"
                }
              }
            ]
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      );

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    const connectionId = await service.connectSetupToken({
      setupToken,
      label: "Household SimpleFIN"
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(connection.provider).toBe("SIMPLEFIN");
    expect(connection.label).toBe("Household SimpleFIN");
    expect(connection.providerItemId).toBe("https://bridge.simplefin.test|alice");
    expect(connection.accounts).toEqual([
      expect.objectContaining({
        externalAccountId: "acct-1",
        name: "Checking",
        officialName: "Checking",
        currentBalance: 123.45,
        type: "bank"
      })
    ]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://setup.simplefin.test/token",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/accounts?balances-only=1");
  });

  it("syncs SimpleFIN transactions over a 90-day review window", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: [
            {
              id: "acct-1",
              name: "Checking",
              balance: "123.45",
              org: {
                id: "org-1",
                name: "SimpleFIN Credit Union",
                domain: "credit-union.example"
              },
              transactions: [
                {
                  id: "txn-1",
                  amount: "-12.34",
                  payee: "Coffee Shop",
                  description: "Coffee Shop Downtown",
                  posted: 1777804800,
                  extra: {
                    category: "dining"
                  }
                },
                {
                  id: "txn-2",
                  amount: "250.00",
                  payee: "Payroll",
                  description: "Payroll Deposit",
                  transacted_at: 1777891200
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString(
          "https://alice:secret@bridge.simplefin.test"
        )
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
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
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: false
      }
    });

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    const result = await service.syncAccountLink(link.id);

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/accounts?");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("account=acct-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("pending=1");
    expect(result.removedImportedIds).toEqual([]);
    expect(result.transactions).toEqual([
      {
        amount: 250,
        categoryNames: [],
        cleared: false,
        date: "2026-05-04",
        importedId: "txn-2",
        importedPayee: "Payroll",
        notes: "Payroll Deposit",
        payeeName: "Payroll",
        searchText: ["Payroll", "Payroll Deposit"]
      },
      {
        amount: -12.34,
        categoryNames: ["Dining"],
        cleared: true,
        date: "2026-05-03",
        importedId: "txn-1",
        importedPayee: "Coffee Shop",
        notes: "Coffee Shop Downtown",
        payeeName: "Coffee Shop",
        searchText: ["Coffee Shop", "Coffee Shop Downtown"]
      }
    ]);
  });

  it("batches SimpleFIN sync fetches for multiple links on the same connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: [
            {
              id: "acct-1",
              name: "Checking",
              transactions: [
                {
                  id: "txn-1",
                  amount: "-12.34",
                  payee: "Coffee Shop",
                  posted: 1777804800
                }
              ]
            },
            {
              id: "acct-2",
              name: "Savings",
              transactions: [
                {
                  id: "txn-2",
                  amount: "25.00",
                  payee: "Interest",
                  posted: 1777891200
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString(
          "https://alice:secret@bridge.simplefin.test"
        )
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
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: checking.id,
        syncFrequency: "MANUAL",
        isEnabled: false
      }
    });

    const link2 = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-2",
        actualAccountName: "Household Savings",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: savings.id,
        syncFrequency: "MANUAL",
        isEnabled: false,
        configJson: JSON.stringify({
          providerSyncState: {
            windowEndDate: "2026-05-04"
          }
        })
      }
    });

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    const outcomes = await service.syncAccountLinks?.([link1.id, link2.id]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("account=acct-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("account=acct-2");
    expect(outcomes?.get(link1.id)?.result?.transactions).toEqual([
      expect.objectContaining({
        importedId: "txn-1",
        payeeName: "Coffee Shop"
      })
    ]);
    expect(outcomes?.get(link2.id)?.result?.configPatch).toEqual({
      providerSyncState: {
        cursor: null,
        windowStartDate: "2026-04-24",
        windowEndDate: "2026-05-05"
      }
    });
  });

  it("supports a fixture-backed SimpleFIN protocol flow without mocked fetch", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fixture = createSimpleFinFixtureServer();
    const { setupToken } = await fixture.start();
    cleanups.push(async () => {
      await fixture.stop();
    });

    const service = createSimpleFinService({
      prisma,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    const connectionId = await service.connectSetupToken({
      setupToken,
      label: "Fixture SimpleFIN"
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });
    expect(connection.accounts).toHaveLength(1);
    expect(fixture.getAccountRequestCount()).toBeGreaterThanOrEqual(1);

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Fixture Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: connection.accounts[0]!.id,
        syncFrequency: "MANUAL",
        isEnabled: false
      }
    });

    const result = await service.syncAccountLink(link.id);
    expect(result.transactions).toEqual([
      expect.objectContaining({
        importedId: "txn-fixture-1",
        payeeName: "Bookstore",
        categoryNames: ["Shopping"]
      })
    ]);
  });

  it("marks a SimpleFIN connection as disconnected and disables its links", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Fixture SimpleFIN",
        providerItemId: "fixture-provider",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString("https://demo-user:demo-pass@fixture"),
        status: "ACTIVE"
      }
    });

    await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Fixture Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        syncFrequency: "DAILY",
        isEnabled: true
      }
    });

    const service = createSimpleFinService({
      prisma,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      }
    });

    await service.disconnectConnection(connection.id);

    const updatedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const updatedLinks = await prisma.accountLink.findMany({
      where: {
        connectionId: connection.id
      }
    });

    expect(updatedConnection.status).toBe("DISCONNECTED");
    expect(updatedLinks.every(link => link.isEnabled === false)).toBe(true);
  });

  it("classifies invalid SimpleFIN access tokens as manual reconnect failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Fixture SimpleFIN",
        providerItemId: "fixture-provider",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString("https://demo-user:demo-pass@fixture"),
        status: "ACTIVE",
        metadataJson: JSON.stringify({})
      }
    });

    const fetchImpl = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      }
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "INVALID_ACCESS_TOKEN",
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "MANUAL_RECONNECT"
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
      action: "MANUAL_RECONNECT",
      code: "INVALID_ACCESS_TOKEN"
    });
  });

  it("classifies upstream SimpleFIN attention errors as bank attention failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Household SimpleFIN",
        providerItemId: "https://bridge.simplefin.test|alice",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString(
          "https://alice:secret@bridge.simplefin.test"
        ),
        metadataJson: JSON.stringify({})
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
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
        actualAccountName: "Household Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errlist: [{ message: "Account needs attention" }]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    await expect(service.syncAccountLink(link.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "ACCOUNT_NEEDS_ATTENTION",
      healthState: "ATTENTION_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "CHECK_PROVIDER"
    });

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    const metadata = JSON.parse(refreshed.metadataJson || "{}");

    expect(refreshed.status).toBe("ERROR");
    expect(metadata.health).toMatchObject({
      state: "ATTENTION_REQUIRED",
      scope: "BANK_AUTH",
      action: "CHECK_PROVIDER",
      code: "ACCOUNT_NEEDS_ATTENTION"
    });
  });

  it("classifies SimpleFIN rate limits as retryable sync pipeline failures", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Fixture SimpleFIN",
        providerItemId: "fixture-provider",
        accessTokenCiphertext: (await import("../lib/crypto.js")).encryptString("https://demo-user:demo-pass@fixture"),
        status: "ACTIVE",
        metadataJson: JSON.stringify({})
      }
    });

    const fetchImpl = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      }
    });

    await expect(service.refreshConnection(connection.id)).rejects.toMatchObject({
      name: "ProviderOperationError",
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  });

  it("reuses a cached SimpleFIN fixture when available", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accounts: [
            {
              id: "acct-1",
              name: "Checking",
              balance: "123.45",
              org: {
                id: "org-1",
                name: "SimpleFIN Credit Union",
                domain: "credit-union.example"
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );

    const fixtureCache = {
      isEnabled: () => true,
      getSimpleFin: vi.fn().mockResolvedValue({
        accessKey: "https://alice:secret@bridge.simplefin.test",
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      setSimpleFin: vi.fn(),
      clearSimpleFin: vi.fn(),
      getTeller: vi.fn(),
      setTeller: vi.fn(),
      clearTeller: vi.fn()
    };

    const service = createSimpleFinService({
      prisma,
      fetchImpl,
      fixtureCache,
      config: {
        defaultLookbackDays: 90,
        overlapDays: 10
      },
      now: () => new Date("2026-05-05T00:00:00.000Z")
    });

    const connectionId = await service.reuseCachedConnection("Cached SimpleFIN");
    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      }
    });

    expect(connection.label).toBe("Cached SimpleFIN");
    expect(fixtureCache.getSimpleFin).toHaveBeenCalledOnce();
  });
});
