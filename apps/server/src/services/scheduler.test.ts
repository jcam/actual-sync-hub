import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { getNextAccountLinkDueAt, isAccountLinkDue, SyncScheduler } from "./scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("isAccountLinkDue", () => {
  it("returns true for hourly links after one hour", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T13:00:00.000Z"), {
        syncFrequency: "HOURLY",
        syncHour: null,
        syncDayOfWeek: null,
      isEnabled: true,
      id: "link-1",
      lastSyncedAt: new Date("2026-05-04T12:00:00.000Z")
    })
    ).toBe(true);
  });

  it("returns false for daily links before the configured hour", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T05:00:00.000Z"), {
        syncFrequency: "DAILY",
        syncHour: 6,
        syncDayOfWeek: null,
      isEnabled: true,
      id: "link-1",
      lastSyncedAt: new Date("2026-05-03T12:00:00.000Z")
    })
    ).toBe(false);
  });

  it("returns true for weekly links on the matching day and hour", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "WEEKLY",
        syncHour: 8,
        syncDayOfWeek: 1,
      isEnabled: true,
      id: "link-1",
      lastSyncedAt: new Date("2026-04-26T12:00:00.000Z")
    })
    ).toBe(true);
  });

  it("computes the next due time for an hourly link", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "HOURLY",
        syncHour: null,
        syncDayOfWeek: null,
        isEnabled: true,
        id: "link-1",
        lastSyncedAt: new Date("2026-05-04T11:30:00.000Z")
      })?.toISOString()
    ).toBe("2026-05-04T12:30:00.000Z");
  });

  it("passes due links to the batched scheduled sync entrypoint", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      await prisma.accountLink.createMany({
        data: [
          {
            id: "link-due",
            actualAccountId: "actual-1",
            actualAccountName: "Checking",
            assetType: "BANK",
            provider: "SIMPLEFIN",
            syncFrequency: "HOURLY",
            isEnabled: true,
            lastSyncedAt: new Date("2026-05-04T10:00:00.000Z"),
            nextSyncAt: new Date("2026-05-04T11:00:00.000Z"),
            updatedAt: new Date("2026-05-04T10:00:00.000Z")
          },
          {
            id: "link-manual",
            actualAccountId: "actual-2",
            actualAccountName: "Savings",
            assetType: "BANK",
            provider: "SIMPLEFIN",
            syncFrequency: "MANUAL",
            isEnabled: true,
            updatedAt: new Date("2026-05-04T10:00:00.000Z")
          }
        ]
      });

      const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
      const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
      const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
      const scheduler = new SyncScheduler({
        prisma,
        appService: {
          listRequestedExternalSyncAccountIds,
          runRequestedExternalSync,
          runScheduledLinkSyncs
        } as never,
        now: () => new Date("2026-05-04T12:00:00.000Z")
      });

      await scheduler.tick();

      expect(runScheduledLinkSyncs).toHaveBeenCalledWith(["link-due"]);
      expect(listRequestedExternalSyncAccountIds).not.toHaveBeenCalled();
      expect(runRequestedExternalSync).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("does not schedule a second sync for accounts already handled from Actual sync requests", async () => {
    const { prisma, cleanup } = await createTestDatabase();

    try {
      await prisma.accountLink.create({
        data: {
          id: "link-due",
          actualAccountId: "actual-1",
          actualAccountName: "Checking",
          assetType: "BANK",
          provider: "SIMPLEFIN",
          syncFrequency: "HOURLY",
          isEnabled: true,
          lastSyncedAt: new Date("2026-05-04T10:00:00.000Z"),
          nextSyncAt: new Date("2026-05-04T11:00:00.000Z"),
          updatedAt: new Date("2026-05-04T10:00:00.000Z")
        }
      });

      const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
      const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
      const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
      const scheduler = new SyncScheduler({
        prisma,
        appService: {
          listRequestedExternalSyncAccountIds,
          runRequestedExternalSync,
          runScheduledLinkSyncs
        } as never,
        now: () => new Date("2026-05-04T12:00:00.000Z")
      });

      scheduler["requestedSyncAccountIds"].add("actual-1");
      await scheduler.tick();

      expect(listRequestedExternalSyncAccountIds).not.toHaveBeenCalled();
      expect(runRequestedExternalSync).not.toHaveBeenCalled();
      expect(runScheduledLinkSyncs).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("coalesces repeated event wakeups into a single tick", async () => {
    vi.useFakeTimers();

    const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
    const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
    const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SyncScheduler({
      prisma: {
        accountLink: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null)
        }
      } as never,
      appService: {
        listRequestedExternalSyncAccountIds,
        runRequestedExternalSync,
        runScheduledLinkSyncs
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      wakeupDebounceMs: 100
    });

    scheduler.requestWakeup();
    scheduler.requestWakeup();
    scheduler.requestWakeup();

    await vi.advanceTimersByTimeAsync(100);

    expect(listRequestedExternalSyncAccountIds).toHaveBeenCalledTimes(1);
    expect(runRequestedExternalSync).not.toHaveBeenCalled();
    expect(runScheduledLinkSyncs).not.toHaveBeenCalled();
  });

  it("polls requested external syncs independently of the 60-second scheduled tick", async () => {
    vi.useFakeTimers();

    const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
    const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
    const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SyncScheduler({
      prisma: {
        accountLink: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null)
        }
      } as never,
      appService: {
        listRequestedExternalSyncAccountIds,
        runRequestedExternalSync,
        runScheduledLinkSyncs
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      intervalMs: 60_000,
      requestedSyncPollIntervalMs: 10_000
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    listRequestedExternalSyncAccountIds.mockClear();
    runRequestedExternalSync.mockClear();
    runScheduledLinkSyncs.mockClear();

    await vi.advanceTimersByTimeAsync(25_000);

    expect(listRequestedExternalSyncAccountIds).toHaveBeenCalledTimes(2);
    expect(runRequestedExternalSync).not.toHaveBeenCalled();
    expect(runScheduledLinkSyncs).not.toHaveBeenCalled();

    scheduler.stop();
  });

  it("arms a one-shot scheduled tick for the next due link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));

    const { prisma, cleanup } = await createTestDatabase();
    const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
    const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
    const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
    await prisma.accountLink.create({
      data: {
        id: "link-1",
        actualAccountId: "actual-1",
        actualAccountName: "Checking",
        assetType: "BANK",
        provider: "SIMPLEFIN",
        syncFrequency: "HOURLY",
        isEnabled: true,
        lastSyncedAt: new Date("2026-05-04T11:30:00.000Z"),
        nextSyncAt: new Date("2026-05-04T12:30:00.000Z")
      }
    });
    const scheduler = new SyncScheduler({
      prisma,
      appService: {
        listRequestedExternalSyncAccountIds,
        runRequestedExternalSync,
        runScheduledLinkSyncs
      } as never,
      intervalMs: 60_000,
      requestedSyncPollIntervalMs: 10_000
    });

    scheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    runScheduledLinkSyncs.mockClear();

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(runScheduledLinkSyncs).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runOnlyPendingTimersAsync();
    expect(runScheduledLinkSyncs).toHaveBeenCalledWith(["link-1"]);

    scheduler.stop();
    await cleanup();
  });

  it("reuses the in-flight requested external sync poll between the fast poll and the main tick", async () => {
    vi.useFakeTimers();

    let resolveRequestedSyncs: ((value: string[]) => void) | null = null;
    const listRequestedExternalSyncAccountIds = vi.fn().mockImplementation(
      () =>
        new Promise<string[]>(resolve => {
          resolveRequestedSyncs = resolve;
        })
    );
    const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
    const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SyncScheduler({
      prisma: {
        accountLink: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null)
        }
      } as never,
      appService: {
        listRequestedExternalSyncAccountIds,
        runRequestedExternalSync,
        runScheduledLinkSyncs
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      intervalMs: 1,
      requestedSyncPollIntervalMs: 1
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(listRequestedExternalSyncAccountIds).toHaveBeenCalledTimes(1);
    expect(runRequestedExternalSync).not.toHaveBeenCalled();

    if (!resolveRequestedSyncs) {
      throw new Error("Expected requested sync poll to be in flight");
    }
    (resolveRequestedSyncs as (value: string[]) => void)([]);
    await vi.runOnlyPendingTimersAsync();

    scheduler.stop();
  });

  it("suppresses account-scoped wakeups while the requested sync for that account is already in flight", async () => {
    vi.useFakeTimers();

    const listRequestedExternalSyncAccountIds = vi.fn().mockResolvedValue([]);
    const runRequestedExternalSync = vi.fn().mockResolvedValue(undefined);
    const runScheduledLinkSyncs = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SyncScheduler({
      prisma: {
        accountLink: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null)
        }
      } as never,
      appService: {
        listRequestedExternalSyncAccountIds,
        runRequestedExternalSync,
        runScheduledLinkSyncs
      } as never,
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      wakeupDebounceMs: 100
    });

    scheduler["requestedSyncAccountIds"].add("actual-1");
    scheduler.requestWakeupForAccounts(["actual-1"]);
    await vi.advanceTimersByTimeAsync(100);

    expect(listRequestedExternalSyncAccountIds).not.toHaveBeenCalled();
    expect(runRequestedExternalSync).not.toHaveBeenCalled();
    expect(runScheduledLinkSyncs).not.toHaveBeenCalled();
  });
});
