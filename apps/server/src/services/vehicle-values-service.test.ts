import { afterEach, describe, expect, it, vi } from "vitest";
import type { VehicleValuesFetchMethod } from "@actual-sync/shared";
import { createTestDatabase } from "../test/test-db.js";
import { createVehicleValuesService } from "./vehicle-values-service.js";

const kbbUrl = "https://www.kbb.com/toyota/prius/2021/";
const hagertyUrl = "https://www.hagerty.com/valuation-tools/sample";
const dayMs = 24 * 60 * 60 * 1000;

function buildVehicleValuesProviderSettings(overrides?: {
  kbbFetchMethod?: VehicleValuesFetchMethod;
  hagertyFetchMethod?: VehicleValuesFetchMethod;
}) {
  return {
    getAll: vi.fn().mockResolvedValue({
      VEHICLE_VALUES: {
        automaticSyncConcurrency: 1,
        kbbFetchMethod: overrides?.kbbFetchMethod ?? "node_fetch",
        hagertyFetchMethod: overrides?.hagertyFetchMethod ?? "browser"
      }
    })
  } as never;
}

function buildKbbHtml(options?: {
  currentResaleValue?: number;
  currentTradeInValue?: number;
  trims?: Array<{
    displayName: string;
    fppPrice: number;
    tradeIn: number;
    privateParty: number;
  }>;
}) {
  const trims = options?.trims ?? [
    {
      displayName: "LE Hatchback 4D",
      fppPrice: 17650,
      tradeIn: 13650,
      privateParty: 16300
    },
    {
      displayName: "XLE Hatchback 4D",
      fppPrice: 18550,
      tradeIn: 14150,
      privateParty: 17150
    }
  ];

  return `<html><body><script>window.__APP_STATE__={"depreciation":{"currentResaleValue":${options?.currentResaleValue ?? 16300},"currentTradeInValue":${options?.currentTradeInValue ?? 13650}},"trims":${JSON.stringify(trims)}};</script></body></html>`;
}

describe.sequential("vehicle values service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates a vehicle value connection and emits a valuation snapshot on sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createVehicleValuesService({ prisma });
    const { connectionId } = await service.createConnection({
      label: "Family SUV",
      vin: "1HGCM82633A123456",
      year: 2022,
      make: "Honda",
      model: "CR-V",
      trim: "EX-L",
      mileage: 24500,
      zipCode: "02143",
      condition: "GOOD",
      source: "AVERAGE",
      kbbValue: 26500,
      edmundsValue: 25900,
      carmaxValue: 25200
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.provider).toBe("VEHICLE_VALUES");
    expect(connection.accounts[0]?.currentBalance).toBe(25866.67);

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-vehicle-1",
        actualAccountName: "Car",
        assetType: "BANK",
        provider: "VEHICLE_VALUES",
        connectionId: connection.id,
        connectionAccountId: connection.accounts[0]!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const result = await service.syncAccountLink(link.id);

    expect(result.transactions).toHaveLength(0);
    expect(result.removedImportedIds).toEqual([]);
    expect(result.balanceSnapshot).toMatchObject({
      currentValue: 25866.67,
      payeeName: "Vehicle Value Adjustment",
      importedPayee: "2022 Honda CR-V EX-L",
      stableId: `vehicle-value:${connection.accounts[0]!.externalAccountId}`
    });
    expect(result.balanceSnapshot?.notes).toContain("Selected source: Average");
    expect(result.balanceSnapshot?.notes).toContain("Kelley Blue Book value: $26500.00");
    expect(result.balanceSnapshot?.notes).toContain("CarMax value: $25200.00");
  });

  it("fetches a KBB estimate from a vehicle page URL", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createVehicleValuesService({
      prisma,
      providerSettings: buildVehicleValuesProviderSettings({
        kbbFetchMethod: "curl"
      }),
      execFileImpl: async file => {
        expect(file).toBe("curl");
        return {
          stdout: `${buildKbbHtml()}\n__STATUS__:200`,
          stderr: ""
        };
      }
    });

    const { connectionId } = await service.createConnection({
      label: "Hybrid",
      year: 2021,
      make: "Toyota",
      model: "Prius",
      trim: "XLE",
      mileage: 32000,
      zipCode: "10001",
      condition: "GOOD",
      source: "KBB",
      kbbUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(17150);
    expect(connection.metadataJson).toContain(`"kbbUrl":"${kbbUrl}"`);
    expect(connection.metadataJson).toContain("\"kbbValue\":17150");
  });

  it("fetches a Hagerty estimate from browser text", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createVehicleValuesService({
      prisma,
      browserFetchImpl: async url => {
        expect(url).toBe(hagertyUrl);
        return {
          status: 200,
          body: "<html><body>#3 Good condition $57,000</body></html>",
          text: "1995 Nissan Skyline #3 Good condition $57,000 +12.5%"
        };
      }
    });

    const { connectionId } = await service.createConnection({
      label: "Collector",
      year: 1995,
      make: "Nissan",
      model: "Skyline",
      mileage: 78000,
      zipCode: "10001",
      condition: "GOOD",
      source: "HAGERTY",
      hagertyUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(57000);
    expect(connection.metadataJson).toContain(`"hagertyUrl":"${hagertyUrl}"`);
    expect(connection.metadataJson).toContain("\"hagertyValue\":57000");
  });

  it("fails selected-source creation when the KBB fetch fails and no cached value exists", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createVehicleValuesService({
      prisma,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("upstream failed", { status: 503 })),
      providerSettings: buildVehicleValuesProviderSettings({
        kbbFetchMethod: "node_fetch"
      })
    });

    await expect(
      service.createConnection({
        label: "Failed hybrid",
        year: 2021,
        make: "Toyota",
        model: "Prius",
        mileage: 32000,
        zipCode: "10001",
        condition: "GOOD",
        source: "KBB",
        kbbUrl
      })
    ).rejects.toThrow("status 503");
  });

  it("keeps a cached KBB estimate during scheduled sync failures and marks it stale", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    let currentTime = new Date("2026-05-01T12:00:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      expect(url).toBe(kbbUrl);
      if (currentTime.getTime() > Date.parse("2026-05-10T12:00:00.000Z")) {
        return new Response("upstream failed", { status: 503 });
      }
      return new Response(buildKbbHtml({ currentResaleValue: 16000 }), { status: 200 });
    });

    const service = createVehicleValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildVehicleValuesProviderSettings({
        kbbFetchMethod: "node_fetch"
      }),
      now: () => currentTime
    });

    const { connectionId } = await service.createConnection({
      label: "Average vehicle",
      year: 2021,
      make: "Toyota",
      model: "Prius",
      mileage: 32000,
      zipCode: "10001",
      condition: "GOOD",
      source: "AVERAGE",
      kbbUrl,
      edmundsValue: 14000
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });
    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-vehicle-2",
        actualAccountName: "Vehicle",
        assetType: "BANK",
        provider: "VEHICLE_VALUES",
        connectionId: connection.id,
        connectionAccountId: connection.accounts[0]!.id,
        syncFrequency: "WEEKLY",
        syncDayOfWeek: 1,
        syncHour: 6,
        isEnabled: true
      }
    });

    currentTime = new Date(currentTime.getTime() + 15 * dayMs);

    const result = await service.syncAccountLink(link.id);

    expect(result.balanceSnapshot?.currentValue).toBe(15000);
    expect(result.balanceSnapshot?.notes).toContain("Kelley Blue Book fetch warning:");

    const updated = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId }
    });
    const metadata = JSON.parse(updated.metadataJson ?? "{}");
    expect(metadata.vehicleValues.sources.kbb.estimate).toBe(16000);
    expect(metadata.vehicleValues.sources.kbb.usingCachedEstimate).toBe(true);
    expect(metadata.vehicleValues.sources.kbb.stale).toBe(true);
    expect(metadata.vehicleValues.sources.kbb.lastFailureMessage).toContain("status 503");
    expect(metadata.vehicleValues.edmundsValue).toBe(14000);
  });

  it("uses cached URL-backed values during manual sync without refetching", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(buildKbbHtml({ currentResaleValue: 18000 }), { status: 200 }));

    const service = createVehicleValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildVehicleValuesProviderSettings({
        kbbFetchMethod: "node_fetch"
      })
    });

    const { connectionId } = await service.createConnection({
      label: "Manual cached vehicle",
      year: 2021,
      make: "Toyota",
      model: "Prius",
      mileage: 32000,
      zipCode: "10001",
      condition: "GOOD",
      source: "KBB",
      kbbUrl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });
    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-vehicle-3",
        actualAccountName: "Manual vehicle",
        assetType: "BANK",
        provider: "VEHICLE_VALUES",
        connectionId: connection.id,
        connectionAccountId: connection.accounts[0]!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const result = await service.syncAccountLink(link.id);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.balanceSnapshot?.currentValue).toBe(18000);
  });

  it("fails selected-source creation when vehicle fetching is disabled", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createVehicleValuesService({
      prisma,
      providerSettings: buildVehicleValuesProviderSettings({
        kbbFetchMethod: "disabled"
      })
    });

    await expect(
      service.createConnection({
        label: "Disabled vehicle",
        year: 2021,
        make: "Toyota",
        model: "Prius",
        mileage: 32000,
        zipCode: "10001",
        condition: "GOOD",
        source: "KBB",
        kbbUrl
      })
    ).rejects.toThrow("Vehicle Values fetching is disabled in provider settings.");
  });
});
