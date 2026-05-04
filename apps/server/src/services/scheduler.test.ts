import { describe, expect, it } from "vitest";
import { isAccountLinkDue } from "./scheduler.js";

describe("isAccountLinkDue", () => {
  it("returns true for hourly links after one hour", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T13:00:00.000Z"), {
        syncFrequency: "HOURLY",
        syncHour: null,
        syncDayOfWeek: null,
        isEnabled: true,
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
        lastSyncedAt: new Date("2026-04-26T12:00:00.000Z")
      })
    ).toBe(true);
  });
});
