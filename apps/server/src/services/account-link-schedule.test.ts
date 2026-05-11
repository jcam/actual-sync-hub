import { describe, expect, it } from "vitest";
import { getNextAccountLinkDueAt, isAccountLinkDue } from "./account-link-schedule.js";

describe("account-link schedule helpers", () => {
  it("never considers manual or disabled links due", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "MANUAL",
        syncHour: null,
        syncDayOfWeek: null,
        lastSyncedAt: null,
        isEnabled: true
      })
    ).toBe(false);

    expect(
      isAccountLinkDue(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "HOURLY",
        syncHour: null,
        syncDayOfWeek: null,
        lastSyncedAt: null,
        isEnabled: false
      })
    ).toBe(false);
  });

  it("treats enabled links without a last sync as due immediately", () => {
    expect(
      isAccountLinkDue(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "DAILY",
        syncHour: 8,
        syncDayOfWeek: null,
        lastSyncedAt: null,
        isEnabled: true
      })
    ).toBe(true);
  });

  it("schedules the next daily run for later today when the scheduled hour has not passed", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T05:00:00.000Z"), {
        syncFrequency: "DAILY",
        syncHour: 8,
        syncDayOfWeek: null,
        lastSyncedAt: new Date("2026-05-03T12:00:00.000Z"),
        isEnabled: true
      })?.toISOString()
    ).toBe("2026-05-04T12:00:00.000Z");
  });

  it("pushes the next daily run to tomorrow after syncing earlier the same day", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "DAILY",
        syncHour: 8,
        syncDayOfWeek: null,
        lastSyncedAt: new Date("2026-05-04T09:00:00.000Z"),
        isEnabled: true
      })?.toISOString()
    ).toBe("2026-05-05T12:00:00.000Z");
  });

  it("returns now for a never-synced weekly link when the scheduled slot is already open", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "WEEKLY",
        syncHour: 8,
        syncDayOfWeek: 1,
        lastSyncedAt: null,
        isEnabled: true
      })?.toISOString()
    ).toBe("2026-05-04T12:00:00.000Z");
  });

  it("schedules the next weekly run for the first matching day in the future", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T06:00:00.000Z"), {
        syncFrequency: "WEEKLY",
        syncHour: 8,
        syncDayOfWeek: 1,
        lastSyncedAt: new Date("2026-04-26T12:00:00.000Z"),
        isEnabled: true
      })?.toISOString()
    ).toBe("2026-05-04T12:00:00.000Z");
  });

  it("pushes weekly schedules forward until a full week has elapsed since the last sync", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T06:00:00.000Z"), {
        syncFrequency: "WEEKLY",
        syncHour: 8,
        syncDayOfWeek: 1,
        lastSyncedAt: new Date("2026-05-03T12:00:00.000Z"),
        isEnabled: true
      })?.toISOString()
    ).toBe("2026-05-11T12:00:00.000Z");
  });

  it("returns null for links that should never be scheduled", () => {
    expect(
      getNextAccountLinkDueAt(new Date("2026-05-04T12:00:00.000Z"), {
        syncFrequency: "MANUAL",
        syncHour: null,
        syncDayOfWeek: null,
        lastSyncedAt: new Date("2026-05-04T11:00:00.000Z"),
        isEnabled: true
      })
    ).toBeNull();
  });
});
