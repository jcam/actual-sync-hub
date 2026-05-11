import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createBelvoService } from "./belvo-service.js";

const belvoTestEnvironment = process.env.BELVO_TEST_ENV === "production" ? "production" : "sandbox";
const liveEnabled =
  process.env.BELVO_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.BELVO_TEST_SECRET_ID) &&
  Boolean(process.env.BELVO_TEST_SECRET_PASSWORD) &&
  Boolean(process.env.BELVO_TEST_LINK_ID);

function createLiveBelvoService(prisma: Awaited<ReturnType<typeof createTestDatabase>>["prisma"]) {
  return createBelvoService({
    prisma,
    providerSettings: {
      get: async () => ({
        environment: belvoTestEnvironment,
        sandbox: {
          secretId: belvoTestEnvironment === "sandbox" ? process.env.BELVO_TEST_SECRET_ID || "" : "",
          secretPassword: belvoTestEnvironment === "sandbox" ? process.env.BELVO_TEST_SECRET_PASSWORD || "" : ""
        },
        production: {
          secretId: belvoTestEnvironment === "production" ? process.env.BELVO_TEST_SECRET_ID || "" : "",
          secretPassword: belvoTestEnvironment === "production" ? process.env.BELVO_TEST_SECRET_PASSWORD || "" : ""
        },
        transactionsInitialDays: 90,
        transactionsOverlapDays: 7,
        automaticSyncConcurrency: 1
      })
    } as never
  });
}

describe.skipIf(!liveEnabled)("belvo service live sandbox", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("imports, refreshes, and syncs a live Belvo sandbox link", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createLiveBelvoService(prisma);
    const imported = await service.connectLink({
      linkId: process.env.BELVO_TEST_LINK_ID || "",
      label: "Codex Belvo Live"
    });

    const importedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: imported.connectionId
      },
      include: {
        accounts: true
      }
    });
    expect(importedConnection.provider).toBe("BELVO");
    expect(importedConnection.accounts.length).toBeGreaterThan(0);

    await service.refreshConnection(importedConnection.id);

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: importedConnection.id
      },
      include: {
        accounts: true
      }
    });
    expect(refreshedConnection.accounts.length).toBeGreaterThan(0);

    const externalAccountId = process.env.BELVO_TEST_ACCOUNT_ID;
    const account =
      (externalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === externalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-belvo-1",
        actualAccountName: "Belvo Live Account",
        assetType: "BANK",
        provider: "BELVO",
        connectionId: refreshedConnection.id,
        connectionAccountId: account!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const syncResult = await service.syncAccountLink(link.id);

    expect(syncResult.imported).toBe(syncResult.transactions.length);
    expect(syncResult.removedImportedIds).toEqual([]);
    expect(syncResult.configPatch?.providerSyncState?.windowEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(syncResult.transactions.every(transaction => Boolean(transaction.importedId))).toBe(true);
  }, 60_000);
});
