import { afterEach, describe, expect, it } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";
import { createSimpleFinService } from "./simplefin-service.js";

const liveEnabled =
  process.env.SIMPLEFIN_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.SIMPLEFIN_TEST_ACCESS_KEY);

function getSimpleFinProviderItemId(accessKey: string) {
  const match = accessKey.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (!match) {
    throw new Error("Invalid SIMPLEFIN_TEST_ACCESS_KEY");
  }

  return `${match[1]}${match[4]}|${match[2]}`;
}

describe.skipIf(!liveEnabled)("simplefin service live", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("refreshes a live SimpleFIN connection and syncs one account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createSimpleFinService({
      prisma,
      fetchImpl: fetch,
      providerSettings: {
        get: async () => ({
          mode: "production",
          development: {
            serverUrl: ""
          },
          transactionsInitialDays: 45,
          automaticSyncConcurrency: 2
        })
      } as never
    });

    const accessKey = process.env.SIMPLEFIN_TEST_ACCESS_KEY || "";
    const connection = await prisma.connection.create({
      data: {
        provider: "SIMPLEFIN",
        label: "Live SimpleFIN",
        providerItemId: getSimpleFinProviderItemId(accessKey),
        accessTokenCiphertext: encryptString(accessKey)
      }
    });

    await service.refreshConnection(connection.id);

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: connection.id
      },
      include: {
        accounts: true
      }
    });
    expect(refreshedConnection.accounts.length).toBeGreaterThan(0);

    const externalAccountId = process.env.SIMPLEFIN_TEST_ACCOUNT_ID;
    const account =
      (externalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === externalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-simplefin-1",
        actualAccountName: "SimpleFIN Live Account",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        connectionId: refreshedConnection.id,
        connectionAccountId: account!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const syncResult = await service.syncAccountLink(link.id);

    expect(syncResult.imported).toBe(syncResult.transactions.length);
    expect(syncResult.transactions.every(transaction => Boolean(transaction.importedId))).toBe(true);
  }, 30_000);
});
