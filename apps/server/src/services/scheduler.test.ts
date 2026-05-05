import { describe, expect, it, vi } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { isAccountLinkDue, SyncScheduler } from "./scheduler.js";

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
      const scheduler = new SyncScheduler({
        prisma,
        appService: {
          runScheduledLinkSyncs
        } as never,
        now: () => new Date("2026-05-04T12:00:00.000Z")
      });

      await scheduler.tick();

      expect(runScheduledLinkSyncs).toHaveBeenCalledWith(["link-due"]);
    } finally {
      await cleanup();
    }
  });
});
