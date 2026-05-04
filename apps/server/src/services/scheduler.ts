import { prisma } from "../db.js";
import { appService } from "./app-service.js";

type SchedulableLink = {
  syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
  syncHour: number | null;
  syncDayOfWeek: number | null;
  lastSyncedAt: Date | null;
  isEnabled: boolean;
};

export function isAccountLinkDue(now: Date, link: SchedulableLink) {
  if (!link.isEnabled || link.syncFrequency === "MANUAL") {
    return false;
  }

  if (!link.lastSyncedAt) {
    return true;
  }

  if (link.syncFrequency === "HOURLY") {
    return now.getTime() - link.lastSyncedAt.getTime() >= 60 * 60 * 1000;
  }

  if (link.syncFrequency === "DAILY") {
    const currentHour = now.getHours();
    return currentHour >= (link.syncHour ?? 0) && now.toDateString() !== link.lastSyncedAt.toDateString();
  }

  if (link.syncFrequency === "WEEKLY") {
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    const sameWeek =
      now.getFullYear() === link.lastSyncedAt.getFullYear() &&
      Math.abs(now.getTime() - link.lastSyncedAt.getTime()) < 7 * 24 * 60 * 60 * 1000;

    return currentDay === (link.syncDayOfWeek ?? 0) && currentHour >= (link.syncHour ?? 0) && !sameWeek;
  }

  return false;
}

export class SyncScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly deps: {
      prisma?: typeof prisma;
      appService?: typeof appService;
      now?: () => Date;
      intervalMs?: number;
    } = {}
  ) {}

  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs ?? 60_000);
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async tick() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const database = this.deps.prisma ?? prisma;
      const service = this.deps.appService ?? appService;
      const now = this.deps.now ?? (() => new Date());
      const links = await database.accountLink.findMany({
        where: {
          isEnabled: true,
          status: {
            in: ["ACTIVE", "MIGRATING"]
          }
        }
      });
      const currentTime = now();

      for (const link of links) {
        if (!isAccountLinkDue(currentTime, link)) {
          continue;
        }

        await service.runAccountSync(link.actualAccountId);
      }
    } finally {
      this.running = false;
    }
  }
}
