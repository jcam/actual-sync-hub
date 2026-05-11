import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeValuesFetchMethod } from "@actual-sync/shared";
import { createTestDatabase } from "../test/test-db.js";
import { createHomeValuesService } from "./home-values-service.js";

const redfinUrl = "https://www.redfin.com/MA/Somerville/77-Columbus-Ave-02143/home/11475799";
const movotoUrl = "https://www.movoto.com/somerville-ma/77-columbus-ave-somerville-ma-02143/pid_testmovoto/";
const homesUrl = "https://www.homes.com/property/77-columbus-ave-somerville-ma/testhomes/";
const truliaUrl = "https://www.trulia.com/home/77-columbus-ave-somerville-ma-02143-testtrulia";
const dayMs = 24 * 60 * 60 * 1000;

function buildHomeValuesProviderSettings(overrides?: {
  redfinFetchMethod?: HomeValuesFetchMethod;
  movotoFetchMethod?: HomeValuesFetchMethod;
  homesFetchMethod?: HomeValuesFetchMethod;
  truliaFetchMethod?: HomeValuesFetchMethod;
}) {
  return {
    getAll: vi.fn().mockResolvedValue({
      HOME_VALUES: {
        automaticSyncConcurrency: 1,
        redfinFetchMethod: overrides?.redfinFetchMethod ?? "node_fetch",
        movotoFetchMethod: overrides?.movotoFetchMethod ?? "node_fetch",
        homesFetchMethod: overrides?.homesFetchMethod ?? "node_fetch",
        truliaFetchMethod: overrides?.truliaFetchMethod ?? "node_fetch"
      }
    })
  } as never;
}

function buildRedfinHtml(predictedValue: number) {
  return `<script>{"avmInfo":{"displayLevel":1,"propertyId":11475799,"predictedValue":${predictedValue}}}</script>`;
}

function buildMovotoHtml(predictedValue: number) {
  return `<div>Estimated value <strong>$${predictedValue.toLocaleString("en-US")}</strong></div>`;
}

function buildHomesHtml(lowerValue: number, upperValue: number) {
  return `<div>$${lowerValue.toLocaleString("en-US")}–$${upperValue.toLocaleString("en-US")}</div>`;
}

function buildTruliaHtml(predictedValue: number) {
  return `<meta name="description" content="77 Columbus Ave, Somerville, MA 02143 is a 1,944 sqft home. The current Trulia Estimate for 77 Columbus Ave is $${predictedValue.toLocaleString("en-US")}."/>`;
}

describe.sequential("home values service", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates a home value connection and emits a cached valuation snapshot on manual sync", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === redfinUrl) {
        return new Response(buildRedfinHtml(650000), { status: 200 });
      }
      if (url === movotoUrl) {
        return new Response(buildMovotoHtml(630000), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    const { connectionId } = await service.createConnection({
      label: "Primary residence",
      address: "123 Main St, Springfield, IL",
      source: "AVERAGE",
      redfinUrl,
      movotoUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.provider).toBe("HOME_VALUES");
    expect(connection.accounts[0]?.currentBalance).toBe(640000);
    expect(connection.homeValuesRedfinLastFetchedAt).toBeTruthy();
    expect(connection.homeValuesMovotoLastFetchedAt).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

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
    expect(result.transactions).toHaveLength(0);
    expect(result.balanceSnapshot).toMatchObject({
      currentValue: 640000,
      payeeName: "Home Value Adjustment",
      importedPayee: "123 Main St, Springfield, IL",
      stableId: `home-value:${connection.accounts[0]!.externalAccountId}`
    });
    expect(result.balanceSnapshot?.notes).toContain("Selected source: Average");
    expect(result.balanceSnapshot?.notes).toContain("Redfin estimate: $650000.00");
    expect(result.balanceSnapshot?.notes).toContain("Movoto estimate: $630000.00");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("updates a home value connection and recalculates the stored account balance from Redfin", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(buildRedfinHtml(400000), { status: 200 }))
      .mockResolvedValueOnce(new Response(buildRedfinHtml(410000), { status: 200 }));
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });
    const { connectionId } = await service.createConnection({
      label: "Rental",
      address: "45 Lake Rd, Madison, WI",
      source: "REDFIN",
      redfinUrl
    });

    await service.updateConnection(connectionId, {
      label: "Rental house",
      address: "45 Lake Rd, Madison, WI",
      source: "REDFIN",
      redfinUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.label).toBe("Rental house");
    expect(connection.accounts[0]?.currentBalance).toBe(410000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts property URLs without a scheme and normalizes them before fetching", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(buildRedfinHtml(400000), { status: 200 }));
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    const { connectionId } = await service.createConnection({
      label: "Rental",
      address: "45 Lake Rd, Madison, WI",
      source: "REDFIN",
      redfinUrl: "www.redfin.com/MA/Somerville/77-Columbus-Ave-02143/home/11475799"
    });

    expect(fetchImpl).toHaveBeenCalledWith(redfinUrl, expect.anything());

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId }
    });
    const metadata = JSON.parse(connection.metadataJson ?? "{}");
    expect(metadata.homeValues.redfinUrl).toBe(redfinUrl);
  });

  it("fails with a clear message when the selected source URL is missing", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createHomeValuesService({
      prisma,
      providerSettings: buildHomeValuesProviderSettings()
    });

    await expect(
      service.createConnection({
        label: "Rental",
        address: "45 Lake Rd, Madison, WI",
        source: "REDFIN"
      })
    ).rejects.toThrow("Redfin URL is required when Redfin is the selected source.");
  });

  it("refreshes a home value connection by re-fetching the latest Redfin estimate", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(buildRedfinHtml(834514.57), { status: 200 }))
      .mockResolvedValueOnce(new Response(buildRedfinHtml(840100), { status: 200 }));
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });
    const { connectionId } = await service.createConnection({
      label: "Home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "REDFIN",
      redfinUrl
    });

    await service.refreshConnection(connectionId);

    const refreshed = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(refreshed.accounts[0]?.currentBalance).toBe(840100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries once on transient upstream failures and succeeds on the second attempt", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(new Response(buildRedfinHtml(842000), { status: 200 }));
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    const { connectionId } = await service.createConnection({
      label: "Retry home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "REDFIN",
      redfinUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(842000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry bot-style responses like 429", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("blocked", { status: 429 }));
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    await expect(
      service.createConnection({
        label: "Blocked home",
        address: "77 Columbus Ave, Somerville, MA 02143",
        source: "REDFIN",
        redfinUrl
      })
    ).rejects.toThrow(/status 429/i);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("can fetch estimates with curl when configured", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: `${buildMovotoHtml(851000)}\n__STATUS__:200`,
      stderr: ""
    });
    const service = createHomeValuesService({
      prisma,
      providerSettings: buildHomeValuesProviderSettings({
        movotoFetchMethod: "curl",
        homesFetchMethod: "disabled",
        truliaFetchMethod: "disabled"
      }),
      execFileImpl
    });

    const { connectionId } = await service.createConnection({
      label: "Curl home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "MOVOTO",
      movotoUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(851000);
    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.calls[0]?.[0]).toBe("curl");
  });

  it("can fetch estimates with wget when configured", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: buildHomesHtml(818137, 894000),
      stderr: "  HTTP/1.1 200 OK\n"
    });
    const service = createHomeValuesService({
      prisma,
      providerSettings: buildHomeValuesProviderSettings({
        movotoFetchMethod: "curl",
        homesFetchMethod: "wget",
        truliaFetchMethod: "disabled"
      }),
      execFileImpl
    });

    const { connectionId } = await service.createConnection({
      label: "Wget home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "HOMES_COM",
      homesUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(856068.5);
    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.calls[0]?.[0]).toBe("wget");
  });

  it("can fetch Trulia estimates with wget when configured", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: buildTruliaHtml(857400),
      stderr: "  HTTP/1.1 200 OK\n"
    });
    const service = createHomeValuesService({
      prisma,
      providerSettings: buildHomeValuesProviderSettings({
        homesFetchMethod: "disabled",
        truliaFetchMethod: "wget"
      }),
      execFileImpl
    });

    const { connectionId } = await service.createConnection({
      label: "Trulia home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "TRULIA",
      truliaUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(857400);
    expect(execFileImpl).toHaveBeenCalledOnce();
    expect(execFileImpl.mock.calls[0]?.[0]).toBe("wget");
  });

  it("fails cleanly when fetching is disabled and no cached estimate exists", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createHomeValuesService({
      prisma,
      providerSettings: buildHomeValuesProviderSettings({
        redfinFetchMethod: "disabled",
        movotoFetchMethod: "curl",
        homesFetchMethod: "disabled",
        truliaFetchMethod: "disabled"
      })
    });

    await expect(
      service.createConnection({
        label: "Disabled home",
        address: "77 Columbus Ave, Somerville, MA 02143",
        source: "REDFIN",
        redfinUrl
      })
    ).rejects.toThrow(/disabled/i);
  });

  it("fetches Movoto and Homes.com estimates and averages all available estimates", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === movotoUrl) {
        return new Response(buildMovotoHtml(851000), { status: 200 });
      }
      if (url === homesUrl) {
        return new Response(buildHomesHtml(818137, 894000), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    const { connectionId } = await service.createConnection({
      label: "Future home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "AVERAGE",
      movotoUrl,
      homesUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });

    expect(connection.accounts[0]?.currentBalance).toBe(853534.25);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const metadata = JSON.parse(connection.metadataJson ?? "{}");
    expect(metadata.homeValues).toMatchObject({
      movotoEstimate: 851000,
      homesEstimate: 856068.5,
      calculatedValue: 853534.25
    });
  });

  it("allows average connections to save when one source fails and another succeeds", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === redfinUrl) {
        return new Response(buildRedfinHtml(834514.57), { status: 200 });
      }
      if (url === movotoUrl) {
        return new Response("blocked", { status: 403 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings()
    });

    const { connectionId } = await service.createConnection({
      label: "Home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "AVERAGE",
      redfinUrl,
      movotoUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });
    const metadata = JSON.parse(connection.metadataJson ?? "{}");

    expect(connection.accounts[0]?.currentBalance).toBe(834514.57);
    expect(metadata.homeValues.calculatedValue).toBe(834514.57);
    expect(metadata.homeValues.sources.movoto.lastFailureMessage).toContain("status 403");
    expect(metadata.homeValues.sources.movoto.estimate).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a cached source in the average during scheduled sync failures and marks it stale", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    let currentTime = new Date("2026-05-01T12:00:00.000Z");
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === redfinUrl) {
        if (currentTime.getTime() > Date.parse("2026-05-10T12:00:00.000Z")) {
          return new Response("upstream failed", { status: 503 });
        }
        return new Response(buildRedfinHtml(700000), { status: 200 });
      }
      if (url === movotoUrl) {
        if (currentTime.getTime() > Date.parse("2026-05-10T12:00:00.000Z")) {
          return new Response(buildMovotoHtml(740000), { status: 200 });
        }
        return new Response(buildMovotoHtml(730000), { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings(),
      now: () => currentTime
    });

    const { connectionId } = await service.createConnection({
      label: "Home",
      address: "77 Columbus Ave, Somerville, MA 02143",
      source: "AVERAGE",
      redfinUrl,
      movotoUrl
    });

    const connection = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });
    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-home-2",
        actualAccountName: "Home",
        assetType: "BANK",
        provider: "HOME_VALUES",
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

    expect(result.balanceSnapshot?.currentValue).toBe(720000);
    expect(result.balanceSnapshot?.notes).toContain("Redfin fetch warning:");

    const updated = await prisma.connection.findUniqueOrThrow({
      where: { id: connectionId },
      include: { accounts: true }
    });
    const metadata = JSON.parse(updated.metadataJson ?? "{}");
    expect(updated.accounts[0]?.currentBalance).toBe(720000);
    expect(metadata.homeValues.sources.redfin.estimate).toBe(700000);
    expect(metadata.homeValues.sources.redfin.usingCachedEstimate).toBe(true);
    expect(metadata.homeValues.sources.redfin.stale).toBe(true);
    expect(metadata.homeValues.sources.redfin.lastFailureMessage).toContain("status 503");
    expect(metadata.homeValues.sources.movoto.estimate).toBe(740000);
  });

  it("paces scheduled site fetches so the same provider is not polled twice inside an hour", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    let currentTime = new Date("2026-05-01T12:00:00.000Z");
    let nextRedfinValue = 810000;
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url !== redfinUrl) {
        throw new Error(`Unexpected URL: ${url}`);
      }
      const response = new Response(buildRedfinHtml(nextRedfinValue), { status: 200 });
      nextRedfinValue += 10000;
      return response;
    });

    const service = createHomeValuesService({
      prisma,
      fetchImpl,
      providerSettings: buildHomeValuesProviderSettings(),
      now: () => currentTime
    });

    const first = await service.createConnection({
      label: "Home one",
      address: "11 First St, Boston, MA",
      source: "REDFIN",
      redfinUrl
    });
    const second = await service.createConnection({
      label: "Home two",
      address: "22 Second St, Boston, MA",
      source: "REDFIN",
      redfinUrl
    });

    const firstConnection = await prisma.connection.findUniqueOrThrow({
      where: { id: first.connectionId },
      include: { accounts: true }
    });
    const secondConnection = await prisma.connection.findUniqueOrThrow({
      where: { id: second.connectionId },
      include: { accounts: true }
    });

    const firstLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-home-3",
        actualAccountName: "Home one",
        assetType: "BANK",
        provider: "HOME_VALUES",
        connectionId: first.connectionId,
        connectionAccountId: firstConnection.accounts[0]!.id,
        syncFrequency: "WEEKLY",
        syncDayOfWeek: 1,
        syncHour: 6,
        isEnabled: true
      }
    });
    const secondLink = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-home-4",
        actualAccountName: "Home two",
        assetType: "BANK",
        provider: "HOME_VALUES",
        connectionId: second.connectionId,
        connectionAccountId: secondConnection.accounts[0]!.id,
        syncFrequency: "WEEKLY",
        syncDayOfWeek: 1,
        syncHour: 7,
        isEnabled: true
      }
    });

    currentTime = new Date(currentTime.getTime() + 8 * dayMs);

    const firstResult = await service.syncAccountLink(firstLink.id);
    const secondResult = await service.syncAccountLink(secondLink.id);

    expect(firstResult.balanceSnapshot?.currentValue).toBe(830000);
    expect(secondResult.balanceSnapshot?.currentValue).toBe(820000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

});
