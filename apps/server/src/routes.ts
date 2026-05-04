import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app-context.js";

function assertAuthenticated(request: FastifyRequest, reply: FastifyReply) {
  if (!request.session.user) {
    reply.status(401).send({
      error: "Unauthorized"
    });
    return false;
  }

  return true;
}

export async function registerRoutes(app: FastifyInstance, context: Pick<AppContext, "authService" | "appService" | "plaidService">) {
  app.get("/api/health", async () => ({
    ok: true
  }));

  app.get("/api/auth/session", async request => ({
    authenticated: Boolean(request.session.user),
    username: request.session.user?.username
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = z
      .object({
        username: z.string(),
        password: z.string()
      })
      .parse(request.body);

    const user = await context.authService.authenticateUser(body.username, body.password);
    if (!user) {
      return reply.status(401).send({
        error: "Invalid credentials"
      });
    }

    request.session.user = user;
    return {
      authenticated: true,
      username: user.username
    };
  });

  app.post("/api/auth/logout", async request => {
    await request.session.destroy();
    return {
      authenticated: false
    };
  });

  app.get("/api/connections", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.appService.listConnections();
  });

  app.get("/api/runtime", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.appService.getRuntimeInfo();
  });

  app.post("/api/connections/plaid/link-token", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return {
      linkToken: await context.plaidService.createLinkToken(request.session.user!.id)
    };
  });

  app.post("/api/connections/plaid/exchange", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        publicToken: z.string().min(1),
        label: z.string().optional()
      })
      .parse(request.body);

    const connectionId = await context.plaidService.exchangePublicToken(body.publicToken, body.label);
    return {
      connectionId
    };
  });

  app.post("/api/connections/refresh-all", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    await context.appService.refreshAllConnections();
    return {
      ok: true
    };
  });

  app.post("/api/connections/plaid/sandbox/seed-connection", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        label: z.string().min(1).optional()
      })
      .parse(request.body ?? {});

    return {
      connectionId: await context.plaidService.seedSandboxConnection(body.label)
    };
  });

  app.post("/api/connections/:id/refresh", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        id: z.string().min(1)
      })
      .parse(request.params);

    await context.plaidService.refreshConnection(params.id);
    return {
      ok: true
    };
  });

  app.post("/api/connections/:id/plaid/sandbox/seed-transactions", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        id: z.string().min(1)
      })
      .parse(request.params);

    const body = z
      .object({
        count: z.number().int().min(1).max(10).optional()
      })
      .parse(request.body ?? {});

    return context.plaidService.seedSandboxTransactions(params.id, body.count);
  });

  app.get("/api/actual/accounts", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const query = z
      .object({
        includeTransactions: z.enum(["true", "false"]).optional()
      })
      .parse(request.query);

    return context.appService.listActualAccounts(query.includeTransactions === "true");
  });

  app.put("/api/account-links/:actualAccountId", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);

    const body = z
      .object({
        actualAccountName: z.string().min(1),
        assetType: z.literal("BANK"),
        provider: z.literal("PLAID").nullable().optional(),
        connectionId: z.string().nullable().optional(),
        connectionAccountId: z.string().nullable().optional(),
        syncFrequency: z.enum(["MANUAL", "HOURLY", "DAILY", "WEEKLY"]),
        syncHour: z.number().int().min(0).max(23).nullable().optional(),
        syncDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
        isEnabled: z.boolean(),
        categoryMappings: z.array(
          z.object({
            sourceCategory: z.string().min(1),
            actualCategoryId: z.string().min(1)
          })
        ).default([])
      })
      .parse(request.body);

    await context.appService.upsertAccountLink(params.actualAccountId, body);
    return {
      ok: true
    };
  });

  app.post("/api/account-links/:actualAccountId/sync", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);

    await context.appService.runAccountSync(params.actualAccountId);
    return {
      ok: true
    };
  });

  app.get("/api/account-links/:actualAccountId/migration/preview", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);

    return context.appService.previewAccountSyncReview(params.actualAccountId);
  });

  app.post("/api/account-links/:actualAccountId/migration/commit", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);
    const body = z
      .object({
        importedIds: z.array(z.string().min(1)).default([])
      })
      .parse(request.body ?? {});

    await context.appService.commitAccountSyncReview(params.actualAccountId, body);
    return {
      ok: true
    };
  });

  app.get("/api/account-links/:actualAccountId/sync-review/preview", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);

    return context.appService.previewAccountSyncReview(params.actualAccountId);
  });

  app.post("/api/account-links/:actualAccountId/sync-review/commit", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = z
      .object({
        actualAccountId: z.string().min(1)
      })
      .parse(request.params);
    const body = z
      .object({
        importedIds: z.array(z.string().min(1)).default([])
      })
      .parse(request.body ?? {});

    await context.appService.commitAccountSyncReview(params.actualAccountId, body);
    return {
      ok: true
    };
  });

  app.get("/api/sync-runs", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.appService.listSyncRuns();
  });
}
