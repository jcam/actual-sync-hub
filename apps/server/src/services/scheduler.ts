import { prisma } from "../db.js";
import { appService } from "./app-service.js";

export { getNextAccountLinkDueAt, isAccountLinkDue } from "./account-link-schedule.js";

const DEFAULT_WAKEUP_DEBOUNCE_MS = 1_000;
const DEFAULT_REQUESTED_SYNC_POLL_INTERVAL_MS = 10_000;
const DEFAULT_SCHEDULE_SANITY_INTERVAL_MS = 4 * 60 * 60_000;
const POST_SCHEDULED_SYNC_RECHECK_MS = 60_000;
const RUNNING_WAKEUP_RETRY_MS = 250;

export class SyncScheduler {
  private sanityTimer: NodeJS.Timeout | undefined;
  private scheduledTickTimer: NodeJS.Timeout | undefined;
  private requestedSyncPollTimer: NodeJS.Timeout | undefined;
  private wakeupTimer: NodeJS.Timeout | undefined;
  private running = false;
  private started = false;
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
    if (this.started) {
      return;
    }

    this.started = true;
    this.requestedSyncPollTimer = setInterval(() => {
      void this.pollRequestedExternalSyncs();
    }, this.deps.requestedSyncPollIntervalMs ?? DEFAULT_REQUESTED_SYNC_POLL_INTERVAL_MS);
    this.sanityTimer = setInterval(() => {
      this.requestWakeup(0);
    }, this.deps.intervalMs ?? DEFAULT_SCHEDULE_SANITY_INTERVAL_MS);
    void this.pollRequestedExternalSyncs();
    void this.tick();
  }

  stop() {
    this.started = false;
    if (this.sanityTimer) {
      clearInterval(this.sanityTimer);
      this.sanityTimer = undefined;
    }
    if (this.scheduledTickTimer) {
      clearTimeout(this.scheduledTickTimer);
      this.scheduledTickTimer = undefined;
    }
    if (this.requestedSyncPollTimer) {
      clearInterval(this.requestedSyncPollTimer);
      this.requestedSyncPollTimer = undefined;
    }
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = undefined;
    }
  }

  requestWakeup(delayMs = this.deps.wakeupDebounceMs ?? DEFAULT_WAKEUP_DEBOUNCE_MS) {
    if (this.scheduledTickTimer) {
      clearTimeout(this.scheduledTickTimer);
      this.scheduledTickTimer = undefined;
    }

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

      if (this.started && uniqueRequestedActualAccountIds.length > 0) {
        this.armScheduledTick(0);
      }
    })();

    try {
      await this.requestedSyncPollPromise;
    } finally {
      this.requestedSyncPollPromise = null;
    }
  }

  private armScheduledTick(delayMs: number) {
    if (!this.started) {
      return;
    }

    if (this.scheduledTickTimer) {
      clearTimeout(this.scheduledTickTimer);
    }

    this.scheduledTickTimer = setTimeout(() => {
      this.scheduledTickTimer = undefined;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  private async scheduleNextTick() {
    if (!this.started) {
      return;
    }

    const database = this.deps.prisma ?? prisma;
    const now = this.deps.now ?? (() => new Date());
    const currentTime = now();
    const requestedActualAccountIds = new Set(this.requestedSyncAccountIds);
    const nextLink = await database.accountLink.findFirst({
      where: {
        isEnabled: true,
        status: {
          in: ["ACTIVE", "MIGRATING"]
        },
        syncFrequency: {
          not: "MANUAL"
        },
        nextSyncAt: {
          not: null
        },
        ...(requestedActualAccountIds.size > 0
          ? {
              actualAccountId: {
                notIn: [...requestedActualAccountIds]
              }
            }
          : {})
      },
      select: {
        nextSyncAt: true
      },
      orderBy: [
        {
          nextSyncAt: "asc"
        }
      ]
    });

    if (nextLink?.nextSyncAt) {
      this.armScheduledTick(Math.max(0, nextLink.nextSyncAt.getTime() - currentTime.getTime()));
    }
  }

  async tick() {
    if (this.running) {
      return;
    }

    this.running = true;
    let processedDueLinks = false;

    try {
      const database = this.deps.prisma ?? prisma;
      const service = this.deps.appService ?? appService;
      const now = this.deps.now ?? (() => new Date());
      await this.requestedSyncPollPromise;
      const currentTime = now();
      const requestedActualAccountIds = new Set(this.requestedSyncAccountIds);
      const links = await database.accountLink.findMany({
        where: {
          isEnabled: true,
          status: {
            in: ["ACTIVE", "MIGRATING"]
          },
          syncFrequency: {
            not: "MANUAL"
          },
          nextSyncAt: {
            lte: currentTime
          },
          ...(requestedActualAccountIds.size > 0
            ? {
                actualAccountId: {
                  notIn: [...requestedActualAccountIds]
                }
              }
            : {})
        },
        select: {
          id: true
        }
      });
      const dueLinkIds = links.map(link => link.id);

      if (dueLinkIds.length > 0) {
        processedDueLinks = true;
        await service.runScheduledLinkSyncs(dueLinkIds);
      }
    } finally {
      this.running = false;
      if (this.started) {
        if (processedDueLinks) {
          this.armScheduledTick(POST_SCHEDULED_SYNC_RECHECK_MS);
        } else if ((this.scheduledTickTimer ?? null) == null) {
          await this.scheduleNextTick();
        }
      }
    }
  }
}
