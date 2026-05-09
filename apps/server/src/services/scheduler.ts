import { prisma } from "../db.js";
import { appService } from "./app-service.js";

const DEFAULT_WAKEUP_DEBOUNCE_MS = 1_000;
const DEFAULT_REQUESTED_SYNC_POLL_INTERVAL_MS = 10_000;
const RUNNING_WAKEUP_RETRY_MS = 250;

type SchedulableLink = {
  id: string;
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
  private requestedSyncPollTimer?: NodeJS.Timeout;
  private wakeupTimer?: NodeJS.Timeout;
  private running = false;
  private requestedSyncPollPromise: Promise<void> | null = null;
  private requestedSyncAccountIds = new Set<string>();

  constructor(
    private readonly deps: {
      prisma?: typeof prisma;
      appService?: typeof appService;
      now?: () => Date;
      intervalMs?: number;
      requestedSyncPollIntervalMs?: number;
      wakeupDebounceMs?: number;
    } = {}
  ) {}

  start() {
    this.requestedSyncPollTimer = setInterval(() => {
      void this.pollRequestedExternalSyncs();
    }, this.deps.requestedSyncPollIntervalMs ?? DEFAULT_REQUESTED_SYNC_POLL_INTERVAL_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs ?? 60_000);
    void this.pollRequestedExternalSyncs();
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.requestedSyncPollTimer) {
      clearInterval(this.requestedSyncPollTimer);
    }
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = undefined;
    }
  }

  requestWakeup(delayMs = this.deps.wakeupDebounceMs ?? DEFAULT_WAKEUP_DEBOUNCE_MS) {
    if (this.wakeupTimer) {
      return;
    }

    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = undefined;

      if (this.running) {
        this.requestWakeup(RUNNING_WAKEUP_RETRY_MS);
        return;
      }

      void this.pollRequestedExternalSyncs();
      void this.tick();
    }, delayMs);
  }

  requestWakeupForAccounts(accountIds: Iterable<string>, delayMs = this.deps.wakeupDebounceMs ?? DEFAULT_WAKEUP_DEBOUNCE_MS) {
    const uniqueAccountIds = [...new Set(accountIds)];
    if (
      uniqueAccountIds.length > 0 &&
      uniqueAccountIds.every(accountId => this.requestedSyncAccountIds.has(accountId))
    ) {
      return;
    }

    this.requestWakeup(delayMs);
  }

  private async pollRequestedExternalSyncs() {
    if (this.requestedSyncPollPromise) {
      return this.requestedSyncPollPromise;
    }

    const service = this.deps.appService ?? appService;
    this.requestedSyncPollPromise = (async () => {
      if (
        typeof service.listRequestedExternalSyncAccountIds !== "function" ||
        typeof service.runRequestedExternalSync !== "function"
      ) {
        return;
      }

      const requestedActualAccountIds = await service.listRequestedExternalSyncAccountIds();
      const uniqueRequestedActualAccountIds = [...new Set(requestedActualAccountIds)];

      for (const actualAccountId of uniqueRequestedActualAccountIds) {
        this.requestedSyncAccountIds.add(actualAccountId);
      }

      for (const actualAccountId of uniqueRequestedActualAccountIds) {
        try {
          await service.runRequestedExternalSync(actualAccountId);
        } finally {
          this.requestedSyncAccountIds.delete(actualAccountId);
        }
      }
    })();

    try {
      await this.requestedSyncPollPromise;
    } finally {
      this.requestedSyncPollPromise = null;
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
      await this.requestedSyncPollPromise;
      const requestedActualAccountIds = new Set(this.requestedSyncAccountIds);
      const links = await database.accountLink.findMany({
        where: {
          isEnabled: true,
          status: {
            in: ["ACTIVE", "MIGRATING"]
          }
        }
      });
      const currentTime = now();
      const dueLinkIds: string[] = [];

      for (const link of links) {
        if (requestedActualAccountIds.has(link.actualAccountId)) {
          continue;
        }

        if (!isAccountLinkDue(currentTime, link)) {
          continue;
        }

        dueLinkIds.push(link.id);
      }

      if (dueLinkIds.length > 0) {
        await service.runScheduledLinkSyncs(dueLinkIds);
      }
    } finally {
      this.running = false;
    }
  }
}
