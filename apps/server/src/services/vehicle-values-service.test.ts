import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createVehicleValuesService } from "./vehicle-values-service.js";

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
});
