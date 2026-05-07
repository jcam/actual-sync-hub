import { afterEach, describe, expect, it } from "vitest";
import { encryptString } from "../lib/crypto.js";
import { createTestDatabase } from "../test/test-db.js";
import { createTellerService } from "./teller-service.js";

const liveEnabled =
  process.env.TELLER_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.TELLER_TEST_APP_ID) &&
  Boolean(process.env.TELLER_TEST_SANDBOX_ACCESS_TOKEN);

describe.skipIf(!liveEnabled)("teller service live sandbox", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("refreshes a live Teller sandbox connection and syncs one account", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createTellerService({
      prisma,
      providerSettings: {
        get: async () => ({
          environment: "sandbox",
          sandbox: {
            appId: process.env.TELLER_TEST_APP_ID || "",
            sandboxAccessToken: process.env.TELLER_TEST_SANDBOX_ACCESS_TOKEN || "",
            webhookSigningSecrets: []
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
          webhookSyncDebounceSeconds: 30,
          webhookToleranceSeconds: 180
        })
      } as never
    });

    const connection = await prisma.connection.create({
      data: {
        provider: "TELLER",
        label: "Live Teller sandbox",
        providerItemId: "live-sandbox-enrollment",
        accessTokenCiphertext: encryptString(process.env.TELLER_TEST_SANDBOX_ACCESS_TOKEN || "")
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

    const externalAccountId = process.env.TELLER_TEST_ACCOUNT_ID;
    const account =
      (externalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === externalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-teller-1",
        actualAccountName: "Teller Live Account",
        assetType: "BANK",
        provider: "TELLER",
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
