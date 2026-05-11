import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBelvoService } from "./belvo-service.js";

const belvoMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  linksDetail: vi.fn(),
  linksDelete: vi.fn(),
  accountsRetrieve: vi.fn(),
  transactionsRetrieve: vi.fn(),
  constructorCalls: [] as Array<{
    secretId: string;
    secretPassword: string;
    url: string | null | undefined;
  }>
}));

vi.mock("belvo", () => ({
  default: class MockBelvoClient {
    links = {
      detail: belvoMocks.linksDetail,
      delete: belvoMocks.linksDelete
    };

    accounts = {
      retrieve: belvoMocks.accountsRetrieve
    };

    transactions = {
      retrieve: belvoMocks.transactionsRetrieve
    };

    constructor(secretId: string, secretPassword: string, url?: string | null) {
      belvoMocks.constructorCalls.push({
        secretId,
        secretPassword,
        url
      });
    }

    connect = belvoMocks.connect;
  }
}));

function createProviderSettingsMock(
  overrides: Partial<{
    environment: "sandbox" | "production";
    sandbox: {
      secretId: string;
      secretPassword: string;
    };
    production: {
      secretId: string;
      secretPassword: string;
    };
    transactionsInitialDays: number;
    transactionsOverlapDays: number;
    automaticSyncConcurrency: number;
  }> = {}
) {
  return {
    get: vi.fn().mockResolvedValue({
      environment: overrides.environment ?? "sandbox",
      sandbox: {
        secretId: overrides.sandbox?.secretId ?? "secret-id",
        secretPassword: overrides.sandbox?.secretPassword ?? "secret-password"
      },
      production: {
        secretId: overrides.production?.secretId ?? "",
        secretPassword: overrides.production?.secretPassword ?? ""
      },
      transactionsInitialDays: overrides.transactionsInitialDays ?? 30,
      transactionsOverlapDays: overrides.transactionsOverlapDays ?? 5,
      automaticSyncConcurrency: overrides.automaticSyncConcurrency ?? 2
    })
  };
}

function createPrismaMock() {
  return {
    connection: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn()
    },
    connectionAccount: {
      deleteMany: vi.fn(),
      createMany: vi.fn()
    },
    accountLink: {
      findUniqueOrThrow: vi.fn()
    }
  };
}

describe("createBelvoService", () => {
  beforeEach(() => {
    vi.useRealTimers();
    belvoMocks.connect.mockReset();
    belvoMocks.linksDetail.mockReset();
    belvoMocks.linksDelete.mockReset();
    belvoMocks.accountsRetrieve.mockReset();
    belvoMocks.transactionsRetrieve.mockReset();
    belvoMocks.constructorCalls.length = 0;
  });

  it("reports manual reauth sessions and advertises Belvo as manually configured", async () => {
    const service = createBelvoService({
      prisma: createPrismaMock() as never,
      providerSettings: createProviderSettingsMock() as never
    });

    expect(service.provider).toBe("BELVO");
    expect(service.isConfigured()).toBe(false);
    await expect(service.createReauthSession!({
      connectionId: "conn_belvo_manual",
      userId: "user_belvo_manual"
    })).resolves.toEqual({
      provider: "BELVO",
      connectionId: "conn_belvo_manual",
      mode: "manual",
      message: "Belvo reconnection currently requires re-linking or completing the provider challenge outside this app."
    });
  });

  it("imports an existing Belvo link and stores its accounts", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.connection.upsert.mockResolvedValue({
      id: "conn_belvo_1"
    });
    belvoMocks.linksDetail.mockResolvedValue({
      id: "link-1",
      institution: "erebor-bank",
      external_id: "Belvo Household",
      status: "valid",
      access_mode: "recurrent"
    });
    belvoMocks.accountsRetrieve.mockResolvedValue([
      {
        id: "acct-1",
        institution: "Erebor Bank",
        name: "Checking",
        number: "1234567890",
        category: "CHECKING_ACCOUNT",
        type: "STANDARD",
        subtype: "CHECKING",
        balance: {
          current: 1450.32,
          available: 1400.11
        }
      }
    ]);

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.connectLink({
      linkId: "link-1",
      label: "My Belvo Link"
    })).resolves.toEqual({
      connectionId: "conn_belvo_1"
    });

    expect(belvoMocks.connect).toHaveBeenCalledTimes(1);
    expect(prisma.connection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        provider_providerItemId: {
          provider: "BELVO",
          providerItemId: "link-1"
        }
      }
    }));
    expect(prisma.connectionAccount.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          connectionId: "conn_belvo_1",
          externalAccountId: "acct-1",
          name: "Checking",
          currentBalance: 1450.32,
          availableBalance: 1400.11,
          type: "CHECKING_ACCOUNT",
          subtype: "CHECKING",
          mask: "7890"
        })
      ]
    });
  });

  it("uses production credentials and normalizes sparse Belvo account metadata", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock({
      environment: "production",
      sandbox: {
        secretId: "",
        secretPassword: ""
      },
      production: {
        secretId: "prod-secret-id",
        secretPassword: "prod-secret-password"
      }
    });
    prisma.connection.upsert.mockResolvedValue({
      id: "conn_belvo_prod_1"
    });
    belvoMocks.linksDetail.mockResolvedValue({
      id: "link-prod-12345678",
      institution: null,
      external_id: " ",
      status: null,
      access_mode: null
    });
    belvoMocks.accountsRetrieve.mockResolvedValue([
      {
        id: "acct-prod-1",
        institution: " ",
        name: " ",
        public_identification_name: "Savings Alias",
        number: "12",
        type: "SAVINGS",
        subtype: " ",
        balance: {}
      }
    ]);

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.connectLink({
      linkId: "link-prod-12345678"
    })).resolves.toEqual({
      connectionId: "conn_belvo_prod_1"
    });

    expect(belvoMocks.constructorCalls).toEqual([
      {
        secretId: "prod-secret-id",
        secretPassword: "prod-secret-password",
        url: "https://api.belvo.com"
      }
    ]);
    expect(prisma.connection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        label: "Belvo link-pro",
        institutionName: null,
        institutionId: null
      }),
      create: expect.objectContaining({
        label: "Belvo link-pro",
        institutionName: null,
        institutionId: null
      })
    }));
    expect(prisma.connectionAccount.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          externalAccountId: "acct-prod-1",
          name: "Savings Alias",
          officialName: "Savings Alias",
          mask: null,
          type: "SAVINGS",
          subtype: "SAVINGS",
          currentBalance: null,
          availableBalance: null,
          providerInstitutionId: null
        })
      ]
    });
  });

  it("falls back to the Belvo external id for connection labels and skips empty account inserts", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.connection.upsert.mockResolvedValue({
      id: "conn_belvo_empty_1"
    });
    belvoMocks.linksDetail.mockResolvedValue({
      id: "link-empty-1",
      institution: "erebor-bank",
      external_id: "Belvo External Label",
      status: "valid",
      access_mode: "single"
    });
    belvoMocks.accountsRetrieve.mockResolvedValue([]);

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.connectLink({
      linkId: "link-empty-1"
    })).resolves.toEqual({
      connectionId: "conn_belvo_empty_1"
    });

    expect(prisma.connection.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        label: "Belvo External Label"
      }),
      create: expect.objectContaining({
        label: "Belvo External Label"
      })
    }));
    expect(prisma.connectionAccount.createMany).not.toHaveBeenCalled();
  });

  it("rejects Belvo operations when credentials are missing", async () => {
    const service = createBelvoService({
      prisma: createPrismaMock() as never,
      providerSettings: createProviderSettingsMock({
        sandbox: {
          secretId: " ",
          secretPassword: ""
        }
      }) as never
    });

    await expect(service.connectLink({
      linkId: "link-missing-creds"
    })).rejects.toThrow("Belvo is not configured");
    expect(belvoMocks.constructorCalls).toEqual([]);
  });

  it("maps Belvo transaction direction into signed Actual amounts", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.accountLink.findUniqueOrThrow.mockResolvedValue({
      id: "link-local-1",
      configJson: null,
      connection: {
        id: "conn_belvo_1",
        provider: "BELVO",
        providerItemId: "link-1"
      },
      connectionAccount: {
        externalAccountId: "acct-1"
      }
    });
    prisma.connection.update.mockResolvedValue({});
    belvoMocks.transactionsRetrieve.mockResolvedValue([
      {
        id: "txn-out-1",
        amount: 25.45,
        type: "OUTFLOW",
        status: "PROCESSED",
        description: "Coffee Shop",
        merchant_name: "Coffee Shop",
        category: "FOOD_AND_DRINK",
        accounting_date: "2026-05-10"
      },
      {
        id: "txn-in-1",
        amount: 1250,
        type: "INFLOW",
        status: "PENDING",
        description: "Payroll",
        reference: "Monthly salary",
        category: "INCOME",
        accounting_date: "2026-05-11"
      }
    ]);

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    const result = await service.syncAccountLink("link-local-1");

    expect(result.imported).toBe(2);
    expect(result.transactions).toEqual([
      expect.objectContaining({
        importedId: "txn-out-1",
        amount: -25.45,
        cleared: true,
        payeeName: "Coffee Shop"
      }),
      expect.objectContaining({
        importedId: "txn-in-1",
        amount: 1250,
        cleared: false,
        payeeName: "Payroll"
      })
    ]);
    expect(result.configPatch?.providerSyncState?.windowEndDate).toBe("2026-05-11");
  });

  it("uses the previous sync window and normalizes sparse Belvo transactions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));

    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.accountLink.findUniqueOrThrow.mockResolvedValue({
      id: "link-local-windowed",
      configJson: JSON.stringify({
        providerSyncState: {
          windowEndDate: "2026-05-08"
        }
      }),
      connection: {
        id: "conn_belvo_windowed",
        provider: "BELVO",
        providerItemId: "link-windowed-1"
      },
      connectionAccount: {
        externalAccountId: "acct-windowed-1"
      }
    });
    prisma.connection.update.mockResolvedValue({});
    belvoMocks.transactionsRetrieve.mockResolvedValue([
      {
        id: "txn-value-date",
        amount: 42,
        type: "INFLOW",
        status: "PROCESSED",
        merchant_name: " Merchant Only ",
        value_date: "2026-05-09",
        category: "FOOD"
      },
      {
        id: "txn-collected-at",
        amount: 17,
        type: "OUTFLOW",
        status: "PENDING",
        description: " ATM ",
        reference: " Ref123 ",
        collected_at: "2026-05-10T15:00:00.000Z",
        category: "CASH",
        subcategory: "ATM"
      },
      {
        id: "txn-invalid-amount",
        amount: Number.NaN,
        type: "INFLOW",
        accounting_date: "2026-05-10"
      },
      {
        id: "txn-invalid-date",
        amount: 8,
        type: "INFLOW",
        merchant_name: "No Date"
      }
    ]);

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    const result = await service.syncAccountLink("link-local-windowed");

    expect(belvoMocks.transactionsRetrieve).toHaveBeenCalledWith("link-windowed-1", "2026-05-04", {
      account: "acct-windowed-1",
      dateTo: "2026-05-11",
      saveData: false
    });
    expect(result).toMatchObject({
      imported: 2,
      removedImportedIds: [],
      configPatch: {
        providerSyncState: {
          windowStartDate: "2026-05-04",
          windowEndDate: "2026-05-11"
        }
      }
    });
    expect(result.transactions).toEqual([
      expect.objectContaining({
        importedId: "txn-value-date",
        date: "2026-05-09",
        amount: 42,
        payeeName: "Merchant Only",
        importedPayee: "Merchant Only",
        cleared: true
      }),
      expect.objectContaining({
        importedId: "txn-collected-at",
        date: "2026-05-10",
        amount: -17,
        payeeName: "ATM",
        importedPayee: "ATM",
        cleared: false
      })
    ]);
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "conn_belvo_windowed"
      },
      data: expect.objectContaining({
        status: "ACTIVE"
      })
    }));
  });

  it("surfaces rate limits during transaction sync and stores retryable sync health", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00.000Z"));

    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.accountLink.findUniqueOrThrow.mockResolvedValue({
      id: "link-local-rate-limit",
      configJson: null,
      connection: {
        id: "conn_belvo_rate_limit",
        provider: "BELVO",
        providerItemId: "link-rate-limit-1"
      },
      connectionAccount: {
        externalAccountId: "acct-rate-limit-1"
      }
    });
    prisma.connection.update.mockResolvedValue({});
    belvoMocks.transactionsRetrieve.mockRejectedValue({
      detail: [
        {
          request: "Too many requests"
        }
      ]
    });

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.syncAccountLink("link-local-rate-limit")).rejects.toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      healthAction: "RETRY",
      healthScope: "SYNC_PIPELINE",
      healthState: "ERROR",
      message: "Too many requests"
    });
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ERROR",
        metadataJson: expect.stringContaining("\"code\":\"RATE_LIMIT_EXCEEDED\"")
      })
    }));
  });

  it("classifies Belvo token-required challenges as manual reconnect errors", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.connection.findUniqueOrThrow.mockResolvedValue({
      id: "conn_belvo_1",
      provider: "BELVO",
      providerItemId: "link-1"
    });
    prisma.connection.update.mockResolvedValue({});
    belvoMocks.linksDetail.mockResolvedValue({
      id: "link-1",
      institution: "erebor-bank",
      status: "token_required"
    });
    belvoMocks.accountsRetrieve.mockRejectedValue({
      statusCode: 428,
      detail: [
        {
          message: "Token required"
        }
      ]
    });

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.refreshConnection("conn_belvo_1")).rejects.toMatchObject({
      healthAction: "MANUAL_RECONNECT",
      healthScope: "BANK_AUTH",
      healthState: "REAUTH_REQUIRED"
    });
    expect(prisma.connection.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ERROR"
      })
    }));
  });

  it("disconnects Belvo links, ignoring already-removed upstream links", async () => {
    const prisma = createPrismaMock();
    const providerSettings = createProviderSettingsMock();
    prisma.connection.findUniqueOrThrow.mockResolvedValue({
      id: "conn_belvo_disconnect",
      provider: "BELVO",
      providerItemId: "link-disconnect-1"
    });
    belvoMocks.linksDelete.mockRejectedValueOnce({
      statusCode: 404,
      detail: {
        detail: "Link not found"
      }
    });

    const service = createBelvoService({
      prisma: prisma as never,
      providerSettings: providerSettings as never
    });

    await expect(service.disconnectConnection!("conn_belvo_disconnect")).resolves.toBeUndefined();
    expect(belvoMocks.linksDelete).toHaveBeenCalledWith("link-disconnect-1");
  });

  it("handles non-Belvo and incomplete connections during disconnect and sync", async () => {
    const disconnectPrisma = createPrismaMock();
    disconnectPrisma.connection.findUniqueOrThrow
      .mockResolvedValueOnce({
        id: "conn_wrong_provider",
        provider: "PLAID",
        providerItemId: "item-1"
      })
      .mockResolvedValueOnce({
        id: "conn_missing_item",
        provider: "BELVO",
        providerItemId: null
      })
      .mockResolvedValueOnce({
        id: "conn_auth_failure",
        provider: "BELVO",
        providerItemId: "link-auth-failure"
      });
    belvoMocks.linksDelete.mockRejectedValueOnce({
      statusCode: 401,
      detail: {
        detail: "Forbidden"
      }
    });

    const syncPrisma = createPrismaMock();
    syncPrisma.accountLink.findUniqueOrThrow.mockResolvedValue({
      id: "link-missing-connection-details",
      configJson: null,
      connection: null,
      connectionAccount: null
    });

    const disconnectService = createBelvoService({
      prisma: disconnectPrisma as never,
      providerSettings: createProviderSettingsMock() as never
    });
    const syncService = createBelvoService({
      prisma: syncPrisma as never,
      providerSettings: createProviderSettingsMock() as never
    });

    await expect(disconnectService.disconnectConnection!("conn_wrong_provider")).rejects.toThrow("Connection is not a Belvo link");
    await expect(disconnectService.disconnectConnection!("conn_missing_item")).resolves.toBeUndefined();
    await expect(disconnectService.disconnectConnection!("conn_auth_failure")).rejects.toMatchObject({
      code: "BELVO_AUTH_FAILED",
      healthAction: "RETRY",
      healthScope: "CONNECTION_AUTH",
      healthState: "ERROR",
      message: "Forbidden"
    });
    await expect(syncService.syncAccountLink("link-missing-connection-details")).rejects.toThrow(
      "Belvo link is missing connection details"
    );

    expect(belvoMocks.linksDelete).toHaveBeenCalledTimes(1);
  });
});
