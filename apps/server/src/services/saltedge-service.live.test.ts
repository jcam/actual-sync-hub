import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createSaltEdgeService } from "./saltedge-service.js";

const credentialsEnabled =
  process.env.SALT_EDGE_TEST_RUN_LIVE === "1" &&
  Boolean(process.env.SALT_EDGE_TEST_APP_ID) &&
  Boolean(process.env.SALT_EDGE_TEST_SECRET);
const connectionEnabled = credentialsEnabled && Boolean(process.env.SALT_EDGE_TEST_CONNECTION_ID);

type SaltEdgeLiveConnectionResponse = {
  data: {
    id: string;
    next_refresh_possible_at?: string | null;
  };
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLiveConnection(connectionId: string) {
  const response = await fetch(`https://www.saltedge.com/api/v6/connections/${connectionId}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "App-id": process.env.SALT_EDGE_TEST_APP_ID || "",
      Secret: process.env.SALT_EDGE_TEST_SECRET || ""
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch live Salt Edge connection ${connectionId}: ${response.status}`);
  }

  return (await response.json()) as SaltEdgeLiveConnectionResponse;
}

async function waitForRefreshWindow(connectionId: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = await getLiveConnection(connectionId);
    const nextRefreshPossibleAt = payload.data.next_refresh_possible_at;
    if (!nextRefreshPossibleAt) {
      return;
    }

    const waitMs = Date.parse(nextRefreshPossibleAt) - Date.now();
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      return;
    }

    await sleep(waitMs + 1_000);
  }
}

function createLiveSaltEdgeService(prisma: Awaited<ReturnType<typeof createTestDatabase>>["prisma"]) {
  const environment =
    process.env.SALT_EDGE_TEST_ENVIRONMENT === "sandbox" ||
    process.env.SALT_EDGE_TEST_ENVIRONMENT === "test" ||
    process.env.SALT_EDGE_TEST_ENVIRONMENT === "production"
      ? process.env.SALT_EDGE_TEST_ENVIRONMENT
      : "sandbox";
  return createSaltEdgeService({
    prisma,
    fetchImpl: fetch,
    providerSettings: {
      get: async () => ({
        environment,
        appId: process.env.SALT_EDGE_TEST_APP_ID || "",
        secret: process.env.SALT_EDGE_TEST_SECRET || "",
        consentDays: 90,
        transactionsFetchDays: 90,
        automaticSyncConcurrency: 2
      })
    } as never
  });
}

describe.skipIf(!credentialsEnabled)("saltedge service live", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates a live Salt Edge connect session", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createLiveSaltEdgeService(prisma);
    const session = await service.createConnectSession({
      userId: "saltedge-live-test-user",
      label: "Codex Salt Edge Live Test"
    });

    expect(session.customerId).toMatch(/\S/);
    expect(session.connectUrl).toContain("saltedge.com");
    expect(Number.isFinite(Date.parse(session.expiresAt))).toBe(true);
  }, 30_000);

  it.skipIf(!connectionEnabled)("finalizes, refreshes, reauths, and syncs a live Salt Edge connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createLiveSaltEdgeService(prisma);
    const finalized = await service.finalizeConnection({
      connectionId: process.env.SALT_EDGE_TEST_CONNECTION_ID || "",
      connectionSecret: process.env.SALT_EDGE_TEST_CONNECTION_SECRET || undefined,
      customerId: process.env.SALT_EDGE_TEST_CUSTOMER_ID || undefined,
      label: "Codex Salt Edge Live"
    });

    const hydratedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: finalized.connectionId
      },
      include: {
        accounts: true
      }
    });

    expect(hydratedConnection.provider).toBe("SALT_EDGE");
    expect(hydratedConnection.accounts.length).toBeGreaterThan(0);

    await waitForRefreshWindow(process.env.SALT_EDGE_TEST_CONNECTION_ID || "");
    await service.refreshConnection(hydratedConnection.id);

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: hydratedConnection.id
      },
      include: {
        accounts: true
      }
    });
    expect(refreshedConnection.accounts.length).toBeGreaterThan(0);

    const reauth = await service.createReauthSession!({
      connectionId: refreshedConnection.id,
      userId: "saltedge-live-test-user"
    });
    expect(reauth.mode).toBe("saltedge_connect");
    if (reauth.mode !== "saltedge_connect") {
      throw new Error(`Expected Salt Edge reconnect session, got ${reauth.mode}`);
    }
    expect(reauth.connectUrl).toContain("saltedge.com");

    const externalAccountId = process.env.SALT_EDGE_TEST_ACCOUNT_ID;
    const account =
      (externalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === externalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-saltedge-1",
        actualAccountName: "Salt Edge Live Account",
        assetType: "BANK",
        provider: "SALT_EDGE",
        connectionId: refreshedConnection.id,
        connectionAccountId: account!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const syncResult = await service.syncAccountLink(link.id);

    expect(syncResult.imported).toBe(syncResult.transactions.length);
    expect(syncResult.transactions.every(transaction => Boolean(transaction.importedId))).toBe(true);
  }, 180_000);
});
