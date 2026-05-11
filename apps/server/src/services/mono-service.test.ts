import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { serializeLinkConfig } from "./link-config.js";
import { createMonoService } from "./mono-service.js";

function requestUrlString(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createMonoProviderSettings() {
  return {
    get: vi.fn().mockResolvedValue({
      environment: "sandbox" as const,
      sandbox: {
        publicKey: "mono_pub_test",
        secretKey: "mono_sec_test",
        webhookSecret: "mono_webhook_secret"
      },
      production: {
        publicKey: "mono_pub_live",
        secretKey: "mono_sec_live",
        webhookSecret: "mono_live_webhook_secret"
      },
      transactionsInitialDays: 90,
      transactionsOverlapDays: 10,
      automaticSyncConcurrency: 1
    })
  };
}

describe("mono service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("exchanges a Mono auth code and persists the discovered account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrlString(input);

      if (url.endsWith("/v2/accounts/auth")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ code: "mono-code-123" }));
        return new Response(JSON.stringify({ data: { id: "mono-acct-1" } }), { status: 200 });
      }

      if (url.endsWith("/v2/accounts/mono-acct-1")) {
        return new Response(
          JSON.stringify({
            data: {
              account: {
                _id: "mono-acct-1",
                name: "Checking",
                accountNumber: "0123456789",
                currency: "NGN",
                balance: 12345,
                type: "depository",
                institution: {
                  name: "Mono Bank",
                  bankCode: "001"
                }
              },
              meta: {
                auth_method: "internet_banking",
                data_status: "AVAILABLE",
                sync_status: "ACTIVE",
                ref: "mono-ref-1"
              }
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never,
      fetchImpl,
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    const result = await service.exchangeCode({
      code: "mono-code-123",
      label: "Mono Household"
    });

    expect(result).toEqual({
      connectionId: expect.any(String)
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: result.connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(connection.provider).toBe("MONO");
    expect(connection.providerItemId).toBe("mono-acct-1");
    expect(connection.label).toBe("Mono Household");
    expect(connection.institutionName).toBe("Mono Bank");
    expect(connection.accounts).toEqual([
      expect.objectContaining({
        externalAccountId: "mono-acct-1",
        name: "Checking",
        officialName: "0123456789",
        mask: "6789",
        currentBalance: 123.45,
        availableBalance: 123.45,
        providerInstitutionId: "001"
      })
    ]);
    expect(connection.metadataJson).toContain("\"environment\":\"sandbox\"");
  });

  it("returns a Mono reauthentication session for a saved connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "MONO",
        providerItemId: "mono-acct-1",
        label: "Mono Household",
        status: "ACTIVE",
        institutionName: "Mono Bank",
        accessTokenCiphertext: "",
        metadataJson: "{}"
      }
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never
    });

    await expect(
      service.createReauthSession!({
        connectionId: connection.id,
        userId: "user-1"
      })
    ).resolves.toEqual({
      provider: "MONO",
      connectionId: connection.id,
      mode: "mono_reauth",
      config: {
        accountId: "mono-acct-1",
        publicKey: "mono_pub_test",
        environment: "sandbox"
      }
    });
  });

  it("verifies Mono webhook secrets against the configured header", async () => {
    const service = createMonoService({
      providerSettings: createMonoProviderSettings() as never
    });

    await expect(service.webhooksConfigured()).resolves.toBe(true);
    await expect(service.verifyWebhookSignature("mono_webhook_secret")).resolves.toBe(true);
    await expect(service.verifyWebhookSignature(["mono_webhook_secret"])).resolves.toBe(true);
    await expect(service.verifyWebhookSignature("wrong-secret")).resolves.toBe(false);
  });

  it("ignores disconnect failures when Mono already reports the account as unlinked", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "MONO",
        providerItemId: "mono-acct-1",
        label: "Mono Household",
        status: "ACTIVE",
        institutionName: "Mono Bank",
        accessTokenCiphertext: "",
        metadataJson: "{}"
      }
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(requestUrlString(input)).toContain("/v2/accounts/mono-acct-1/unlink");
      return new Response(JSON.stringify({ message: "Account unlinked" }), { status: 409 });
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never,
      fetchImpl
    });

    await expect(service.disconnectConnection!(connection.id)).resolves.toBeUndefined();
  });

  it("refreshes an existing Mono connection and persists provider health when reauthorisation is required", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "MONO",
        providerItemId: "mono-acct-1",
        label: "Mono Household",
        status: "ACTIVE",
        institutionName: "Mono Bank",
        accessTokenCiphertext: "",
        metadataJson: "{}"
      }
    });

    await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "mono-acct-1",
        name: "Checking",
        officialName: "0123456789",
        type: "bank"
      }
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrlString(input);
      if (url.endsWith("/v2/accounts/mono-acct-1")) {
        return new Response(
          JSON.stringify({
            data: {
              account: {
                _id: "mono-acct-1",
                name: "Checking",
                accountNumber: "0123456789",
                balance: 77700,
                institution: {
                  name: "Mono Bank",
                  bankCode: "001"
                }
              },
              meta: {
                sync_status: "REAUTHORISATION_REQUIRED",
                auth_method: "internet_banking"
              }
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never,
      fetchImpl,
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    await expect(service.refreshConnection(connection.id)).resolves.toBeUndefined();

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });

    expect(refreshed.status).toBe("ERROR");
    expect(refreshed.metadataJson).toContain("REAUTHORISATION_REQUIRED");
    expect(refreshed.metadataJson).toContain("internet_banking");
  });

  it("syncs Mono transactions and updates the provider window state", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "MONO",
        providerItemId: "mono-acct-1",
        label: "Mono Household",
        status: "ACTIVE",
        institutionName: "Mono Bank",
        accessTokenCiphertext: "",
        metadataJson: "{}"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "mono-acct-1",
        name: "Checking",
        officialName: "0123456789",
        type: "bank"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        provider: "MONO",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: false,
        configJson: serializeLinkConfig({})
      }
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrlString(input);

      if (url.includes("/v2/accounts/mono-acct-1/transactions")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                _id: "txn-debit",
                amount: 5000,
                type: "debit",
                narration: "Coffee Shop",
                category: "dining",
                date: "2026-05-05"
              },
              {
                _id: "txn-credit",
                amount: 125000,
                type: "credit",
                narration: "Salary",
                category: "income",
                created_at: "2026-05-06T00:00:00.000Z"
              }
            ]
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/v2/accounts/mono-acct-1")) {
        return new Response(
          JSON.stringify({
            data: {
              account: {
                _id: "mono-acct-1",
                name: "Checking",
                accountNumber: "0123456789",
                balance: 200000,
                institution: {
                  name: "Mono Bank",
                  bankCode: "001"
                }
              },
              meta: {
                sync_status: "ACTIVE",
                data_status: "AVAILABLE"
              }
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never,
      fetchImpl,
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    const result = await service.syncAccountLink(link.id);

    expect(result.imported).toBe(2);
    expect(result.transactions).toEqual([
      expect.objectContaining({
        importedId: "txn-credit",
        date: "2026-05-06",
        amount: -1250,
        payeeName: "Salary"
      }),
      expect.objectContaining({
        importedId: "txn-debit",
        date: "2026-05-05",
        amount: 50,
        payeeName: "Coffee Shop",
        categoryNames: expect.arrayContaining(["Dining"])
      })
    ]);
    expect(result.configPatch).toEqual({
      providerSyncState: {
        cursor: null,
        windowStartDate: "2026-02-06",
        windowEndDate: "2026-05-06"
      }
    });
  });

  it("marks the connection unhealthy when Mono sync requires reauthorisation", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const connection = await prisma.connection.create({
      data: {
        provider: "MONO",
        providerItemId: "mono-acct-1",
        label: "Mono Household",
        status: "ACTIVE",
        institutionName: "Mono Bank",
        accessTokenCiphertext: "",
        metadataJson: "{}"
      }
    });

    const connectionAccount = await prisma.connectionAccount.create({
      data: {
        connectionId: connection.id,
        externalAccountId: "mono-acct-1",
        name: "Checking",
        officialName: "0123456789",
        type: "bank"
      }
    });

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        provider: "MONO",
        connectionId: connection.id,
        connectionAccountId: connectionAccount.id,
        syncFrequency: "MANUAL",
        isEnabled: false,
        configJson: serializeLinkConfig({})
      }
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrlString(input);
      if (url.endsWith("/v2/accounts/mono-acct-1")) {
        return new Response(
          JSON.stringify({
            data: {
              account: {
                _id: "mono-acct-1",
                name: "Checking",
                accountNumber: "0123456789",
                balance: 200000,
                institution: {
                  name: "Mono Bank",
                  bankCode: "001"
                }
              },
              meta: {
                sync_status: "REAUTHORISATION_REQUIRED"
              }
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });

    const service = createMonoService({
      prisma,
      providerSettings: createMonoProviderSettings() as never,
      fetchImpl
    });

    await expect(service.syncAccountLink(link.id)).rejects.toThrow(/reauthorised/i);

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      }
    });
    expect(refreshed.status).toBe("ERROR");
    expect(refreshed.metadataJson).toContain("REAUTH_REQUIRED");
  });
});
