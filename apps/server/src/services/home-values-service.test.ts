import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createHomeValuesService } from "./home-values-service.js";

describe.sequential("home values service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates a home value connection and emits a synthetic valuation transaction", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createHomeValuesService({ prisma });

    const { connectionId } = await service.createConnection({
      label: "Primary residence",
      address: "123 Main St, Springfield, IL",
      source: "AVERAGE",
      redfinEstimate: 650000,
      redfinUrl: "https://www.redfin.com/example",
      zillowEstimate: 630000,
      zillowUrl: "https://www.zillow.com/example"
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(connection.provider).toBe("HOME_VALUES");
    expect(connection.accounts).toHaveLength(1);
    expect(connection.accounts[0]?.currentBalance).toBe(640000);

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-home-1",
        actualAccountName: "Home",
        assetType: "BANK",
        provider: "HOME_VALUES",
        connectionId: connection.id,
        connectionAccountId: connection.accounts[0]!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const result = await service.syncAccountLink(link.id);

    expect(result.removedImportedIds).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      amount: 640000,
      payeeName: "Primary residence",
      importedPayee: "123 Main St, Springfield, IL",
      importedId: `home-value:${connection.accounts[0]!.externalAccountId}`,
      cleared: true
    });
    expect(result.transactions[0]?.notes).toContain("Selected source: AVERAGE");
    expect(result.transactions[0]?.notes).toContain("Redfin estimate: $650000.00");
    expect(result.transactions[0]?.notes).toContain("Zillow estimate: $630000.00");
  });

  it("updates a home value connection and recalculates the stored account balance", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createHomeValuesService({ prisma });
    const { connectionId } = await service.createConnection({
      label: "Rental",
      address: "45 Lake Rd, Madison, WI",
      source: "REDFIN",
      redfinEstimate: 400000
    });

    await service.updateConnection(connectionId, {
      label: "Rental house",
      address: "45 Lake Rd, Madison, WI",
      source: "ZILLOW",
      zillowEstimate: 415500,
      zillowUrl: "https://www.zillow.com/example"
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(connection.label).toBe("Rental house");
    expect(connection.accounts[0]?.currentBalance).toBe(415500);

    await service.refreshConnection(connectionId);

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(refreshed.accounts[0]?.currentBalance).toBe(415500);
  });
});
