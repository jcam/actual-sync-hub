import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app-context.js";
import type { TellerWebhookEvent } from "./services/teller-service.js";

const actualAccountIdParamsSchema = z.object({
  actualAccountId: z.string().min(1)
});

const reviewCommitBodySchema = z.object({
  importedIds: z.array(z.string().min(1)).default([])
});

const connectionIdParamsSchema = z.object({
  id: z.string().min(1)
});

const tellerWebhookBodySchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "enrollment.disconnected",
    "transactions.processed",
    "account.number_verification.processed",
    "webhook.test"
  ]),
  timestamp: z.string().min(1),
  payload: z
    .object({
      enrollment_id: z.string().min(1).optional(),
      reason: z.string().optional(),
      transactions: z.array(z.record(z.string(), z.unknown())).optional(),
      account_id: z.string().optional(),
      status: z.string().optional()
    })
    .passthrough()
});

function assertAuthenticated(request: FastifyRequest, reply: FastifyReply) {
  if (!request.session.user) {
    reply.status(401).send({
      error: "Unauthorized"
    });
    return false;
  }

  return true;
}

export async function registerRoutes(
  app: FastifyInstance,
  context: Pick<AppContext, "authService" | "appService" | "plaidService" | "simplefinService" | "tellerService">
) {
  const registerReviewRoutes = (prefix: "migration" | "sync-review") => {
    app.get(`/api/account-links/:actualAccountId/${prefix}/preview`, async (request, reply) => {
      if (!assertAuthenticated(request, reply)) {
        return;
      }

      const params = actualAccountIdParamsSchema.parse(request.params);

      return context.appService.previewAccountSyncReview(params.actualAccountId);
    });

    app.post(`/api/account-links/:actualAccountId/${prefix}/commit`, async (request, reply) => {
      if (!assertAuthenticated(request, reply)) {
        return;
      }

      const params = actualAccountIdParamsSchema.parse(request.params);
      const body = reviewCommitBodySchema.parse(request.body ?? {});

      await context.appService.commitAccountSyncReview(params.actualAccountId, body);
      return {
        ok: true
      };
    });
  };

  app.get("/api/health", async () => ({
    ok: true
  }));

  app.post("/api/webhooks/teller", async (request, reply) => {
    const body = tellerWebhookBodySchema.parse(request.body ?? {});
    const rawBody = JSON.stringify(request.body ?? {});

    if (!context.tellerService.webhooksConfigured()) {
      return reply.status(503).send({
        error: "Teller webhooks are not configured"
      });
    }

    if (!context.tellerService.verifyWebhookSignature(rawBody, request.headers["teller-signature"])) {
      return reply.status(401).send({
        error: "Invalid Teller webhook signature"
      });
    }

    await context.appService.handleTellerWebhook(body as TellerWebhookEvent);
    return {
      ok: true
    };
  });

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

  app.get("/api/actual/bank-sync-links", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.appService.listActualBankSyncLinks();
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

  app.post("/api/connections/simplefin/connect", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        setupToken: z.string().min(1),
        label: z.string().min(1).optional()
      })
      .parse(request.body);

    return {
      connectionId: await context.simplefinService.connectSetupToken(body)
    };
  });

  app.post("/api/connections/simplefin/reuse-cached", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        label: z.string().min(1).optional()
      })
      .parse(request.body ?? {});

    return {
      connectionId: await context.simplefinService.reuseCachedConnection(body.label)
    };
  });

  app.post("/api/connections/simplefin/import-existing", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        connectionId: z.string().min(1)
      })
      .parse(request.body);

    return context.appService.importExistingSimpleFinLinks(body.connectionId);
  });

  app.get("/api/connections/teller/connect-config", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.tellerService.getConnectConfig();
  });

  app.post("/api/connections/teller/enroll", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        accessToken: z.string().min(1),
        enrollmentId: z.string().min(1),
        userId: z.string().min(1).nullable().optional(),
        institutionName: z.string().min(1).nullable().optional(),
        label: z.string().min(1).nullable().optional()
      })
      .parse(request.body);

    const connectionId = await context.tellerService.enrollConnection(body);
    return {
      connectionId
    };
  });

  app.post("/api/connections/teller/reuse-cached", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        label: z.string().min(1).optional()
      })
      .parse(request.body ?? {});

    return {
      connectionId: await context.tellerService.reuseCachedConnection(body.label)
    };
  });

  app.post("/api/connections/teller/sandbox/seed-connection", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = z
      .object({
        label: z.string().min(1).optional()
      })
      .parse(request.body ?? {});

    return {
      connectionId: await context.tellerService.seedSandboxConnection(body.label)
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

    const params = connectionIdParamsSchema.parse(request.params);

    await context.appService.refreshConnection(params.id);
    return {
      ok: true
    };
  });

  app.post("/api/connections/:id/reauth-session", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = connectionIdParamsSchema.parse(request.params);

    return context.appService.createConnectionReauthSession(params.id, request.session.user!.id);
  });

  app.post("/api/connections/:id/disconnect", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = connectionIdParamsSchema.parse(request.params);

    await context.appService.disconnectConnection(params.id);
    return {
      ok: true
    };
  });

  app.post("/api/connections/:id/plaid/sandbox/seed-transactions", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = connectionIdParamsSchema.parse(request.params);

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

    return context.appService.listActualAccounts();
  });

  app.put("/api/account-links/:actualAccountId", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = actualAccountIdParamsSchema.parse(request.params);

    const body = z
      .object({
        actualAccountName: z.string().min(1),
        assetType: z.literal("BANK"),
        provider: z.enum(["PLAID", "TELLER", "SIMPLEFIN"]).nullable().optional(),
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

    const params = actualAccountIdParamsSchema.parse(request.params);

    await context.appService.runAccountSync(params.actualAccountId);
    return {
      ok: true
    };
  });

  registerReviewRoutes("migration");
  registerReviewRoutes("sync-review");

  app.get("/api/sync-runs", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.appService.listSyncRuns();
  });
}
