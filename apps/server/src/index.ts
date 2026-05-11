import { prisma } from "./db.js";
import { env } from "./env.js";
import { createAppContext } from "./app-context.js";
import { createServer } from "./server.js";
import { bootstrapAdminUser } from "./services/bootstrap.js";
import { SyncScheduler } from "./services/scheduler.js";

async function main() {
  await bootstrapAdminUser();
  const context = createAppContext();
  const app = await createServer({
    sessionSecret: env.SESSION_SECRET,
    nodeEnv: env.NODE_ENV,
    requestLoggingEnabled: env.httpRequestLogEnabled,
    context
  });
  const scheduler = env.disableScheduler
    ? null
    : new SyncScheduler({
        prisma: context.prisma,
        appService: context.appService
      });
  if (scheduler) {
    context.scheduler = scheduler;
  }
  scheduler?.start();
  const stopActualSyncEventWakeup =
    scheduler && typeof context.actualService.onActualSyncAccountsChanged === "function"
      ? context.actualService.onActualSyncAccountsChanged(accountIds => {
          scheduler.requestWakeupForAccounts(accountIds);
        })
      : null;

  const close = async () => {
    stopActualSyncEventWakeup?.();
    scheduler?.stop();
    await app.close();
    await prisma.$disconnect();
  };

  process.on("SIGINT", () => {
    void close().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().then(() => process.exit(0));
  });

  await app.listen({
    port: env.PORT,
    host: "0.0.0.0"
  });
}

void main();
