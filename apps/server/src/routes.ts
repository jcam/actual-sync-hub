import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "./app-context.js";
import {
  getRawRequestBodyBuffer,
  getRawRequestBodyString,
  parseRawJsonBody,
  parseRequestBody,
  parseRequestParams,
  serializeRequestBody
} from "./lib/request-parsing.js";
import { stripUndefined } from "./lib/strip-undefined.js";
import { providerSchemas } from "./services/provider-settings-service.js";
import type { BelvoWebhookEvent } from "./services/belvo-service.js";
import type { MonoWebhookEvent } from "./services/mono-service.js";
import type { PlaidWebhookEvent } from "./services/plaid-service.js";
import type { TellerWebhookEvent } from "./services/teller-service.js";

const actualAccountIdParamsSchema = z.object({
  actualAccountId: z.string().min(1)
});

const reviewCommitBodySchema = z.object({
  snapshotId: z.string().min(1),
  importedIds: z.array(z.string().min(1)).default([])
});

const connectionIdParamsSchema = z.object({
  id: z.string().min(1)
});

const providerParamsSchema = z.object({
  provider: z.enum(["PLAID", "STRIPE", "TELLER", "MONO", "SIMPLEFIN", "BELVO", "HOME_VALUES", "VEHICLE_VALUES"])
});

const homeValueConnectionBodySchema = z.object({
  label: z.string().min(1).nullable().optional(),
  address: z.string().min(1),
  source: z.enum(["REDFIN", "MOVOTO", "HOMES_COM", "TRULIA", "AVERAGE"]),
  redfinEstimate: z.number().positive().nullable().optional(),
  redfinUrl: z.string().min(1).nullable().optional(),
  movotoEstimate: z.number().positive().nullable().optional(),
  movotoUrl: z.string().min(1).nullable().optional(),
  homesEstimate: z.number().positive().nullable().optional(),
  homesUrl: z.string().min(1).nullable().optional(),
  truliaEstimate: z.number().positive().nullable().optional(),
  truliaUrl: z.string().min(1).nullable().optional()
});

const vehicleValueConnectionBodySchema = z.object({
  label: z.string().min(1).nullable().optional(),
  vin: z.string().min(1).nullable().optional(),
  year: z.number().int().min(1886).nullable().optional(),
  make: z.string().min(1),
  model: z.string().min(1),
  trim: z.string().min(1).nullable().optional(),
  mileage: z.number().min(0),
  zipCode: z.string().min(1),
  condition: z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR"]),
  source: z.enum(["KBB", "EDMUNDS", "CARMAX", "HAGERTY", "AVERAGE"]),
  kbbValue: z.number().min(0).nullable().optional(),
  kbbUrl: z.string().min(1).nullable().optional(),
  edmundsValue: z.number().min(0).nullable().optional(),
  carmaxValue: z.number().min(0).nullable().optional(),
  hagertyValue: z.number().min(0).nullable().optional(),
  hagertyUrl: z.string().min(1).nullable().optional()
});

const loginBodySchema = z.object({
  username: z.string(),
  password: z.string()
});

const plaidExchangeBodySchema = z.object({
  publicToken: z.string().min(1),
  label: z.string().optional()
});

const stripeFinalizeBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  accountIds: z.array(z.string().min(1)).min(1)
});

const stripeReauthFinalizeBodySchema = z.object({
  sessionId: z.string().min(1).optional(),
  accountIds: z.array(z.string().min(1)).min(1)
});

const monoExchangeBodySchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1).optional()
});

const simplefinConnectBodySchema = z.object({
  setupToken: z.string().min(1),
  label: z.string().min(1).optional()
});

const belvoFinalizeBodySchema = z.object({
  linkId: z.string().min(1),
  label: z.string().min(1).optional()
});

const simplefinImportExistingBodySchema = z.object({
  connectionId: z.string().min(1)
});

const optionalLabelBodySchema = z.object({
  label: z.string().min(1).optional()
});

const tellerEnrollBodySchema = z.object({
  accessToken: z.string().min(1),
  enrollmentId: z.string().min(1),
  userId: z.string().min(1).nullable().optional(),
  institutionName: z.string().min(1).nullable().optional(),
  label: z.string().min(1).nullable().optional()
});

const plaidSeedTransactionsBodySchema = z.object({
  count: z.number().int().min(1).max(10).optional()
});

const accountLinkBodySchema = z.object({
  actualAccountName: z.string().min(1),
  assetType: z.enum(["BANK", "LOAN", "INVESTMENT", "PROPERTY", "OTHER_ASSET", "OTHER_LIABILITY"]),
  writeMode: z.enum(["TRANSACTIONS", "SNAPSHOT_DELTA", "TRANSACTIONS_AND_SNAPSHOT_DELTA"]).optional(),
  snapshotHistory: z.boolean().optional(),
  provider: z
    .enum(["PLAID", "STRIPE", "TELLER", "MONO", "SIMPLEFIN", "BELVO", "HOME_VALUES", "VEHICLE_VALUES"])
    .nullable()
    .optional(),
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

const plaidWebhookBodySchema = z.object({
  webhook_type: z.string().min(1),
  webhook_code: z.string().min(1),
  item_id: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  initial_update_complete: z.boolean().optional(),
  historical_update_complete: z.boolean().optional(),
  error: z.unknown().optional(),
  new_transactions: z.number().optional()
}).passthrough();

const monoWebhookBodySchema = z.object({
  event: z.string().min(1),
  event_id: z.string().optional(),
  timestamp: z.string().optional(),
  data: z
    .object({
      account: z.record(z.string(), z.unknown()).optional(),
      meta: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
}).passthrough();

const belvoWebhookBodySchema = z.object({
  webhook_id: z.string().min(1),
  webhook_type: z.string().min(1),
  process_type: z.string().min(1),
  webhook_code: z.string().min(1),
  link_id: z.string().min(1),
  request_id: z.string().min(1).optional(),
  external_id: z.string().min(1).nullable().optional(),
  data: z.unknown().optional()
}).passthrough();

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
  context: Pick<AppContext, "authService" | "appService" | "belvoService" | "monoService" | "plaidService" | "providerSettingsService" | "simplefinService" | "stripeService" | "tellerService" | "scheduler">
) {
  const registerReviewRoutes = (prefix: "migration" | "sync-review") => {
    app.get(`/api/account-links/:actualAccountId/${prefix}/preview`, async (request, reply) => {
      if (!assertAuthenticated(request, reply)) {
        return;
      }

      const params = parseRequestParams(actualAccountIdParamsSchema, request);

      return context.appService.previewAccountSyncReview(params.actualAccountId);
    });

    app.post(`/api/account-links/:actualAccountId/${prefix}/commit`, async (request, reply) => {
      if (!assertAuthenticated(request, reply)) {
        return;
      }

      const params = parseRequestParams(actualAccountIdParamsSchema, request);
      const body = parseRequestBody(reviewCommitBodySchema, request, { fallbackToEmptyObject: true });

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
    const body = parseRequestBody(tellerWebhookBodySchema, request, { fallbackToEmptyObject: true });
    const rawBody = serializeRequestBody(request);

    if (!(await context.tellerService.webhooksConfigured())) {
      return reply.status(503).send({
        error: "Teller webhooks are not configured"
      });
    }

    if (!(await context.tellerService.verifyWebhookSignature(rawBody, request.headers["teller-signature"]))) {
      return reply.status(401).send({
        error: "Invalid Teller webhook signature"
      });
    }

    await context.appService.handleTellerWebhook(body as TellerWebhookEvent);
    return {
      ok: true
    };
  });

  app.post("/api/webhooks/mono", async (request, reply) => {
    const body = parseRequestBody(monoWebhookBodySchema, request, { fallbackToEmptyObject: true });

    if (!context.monoService || !(await context.monoService.webhooksConfigured())) {
      return reply.status(503).send({
        error: "Mono webhooks are not configured"
      });
    }

    if (!(await context.monoService.verifyWebhookSignature(request.headers["mono-webhook-secret"]))) {
      return reply.status(401).send({
        error: "Invalid Mono webhook signature"
      });
    }

    await context.appService.handleMonoWebhook(body as MonoWebhookEvent);
    return {
      ok: true
    };
  });

  app.post("/api/webhooks/belvo", async (request, reply) => {
    const body = parseRequestBody(belvoWebhookBodySchema, request, { fallbackToEmptyObject: true });

    if (!(await context.belvoService.webhooksConfigured())) {
      return reply.status(503).send({
        error: "Belvo webhooks are not configured"
      });
    }

    if (!(await context.belvoService.verifyWebhookAuthorization(request.headers.authorization))) {
      return reply.status(401).send({
        error: "Invalid Belvo webhook authorization"
      });
    }

    await context.appService.handleBelvoWebhook(body as BelvoWebhookEvent);
    return {
      ok: true
    };
  });

  await app.register(async plaidWebhookApp => {
    plaidWebhookApp.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });

    plaidWebhookApp.post("/api/webhooks/plaid", async (request, reply) => {
      if (!(await context.plaidService.webhooksConfigured())) {
        return reply.status(503).send({
          error: "Plaid webhooks are not configured"
        });
      }

      const rawBody = getRawRequestBodyString(request);
      if (!(await context.plaidService.verifyWebhookSignature(rawBody, request.headers["plaid-verification"]))) {
        return reply.status(401).send({
          error: "Invalid Plaid webhook signature"
        });
      }

      const body = parseRawJsonBody(plaidWebhookBodySchema, rawBody);
      await context.appService.handlePlaidWebhook(body as PlaidWebhookEvent);
      return {
        ok: true
      };
    });
  });

  await app.register(async stripeWebhookApp => {
    stripeWebhookApp.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    stripeWebhookApp.post("/api/webhooks/stripe", async (request, reply) => {
      const stripeService = context.stripeService;
      if (!stripeService || !(await stripeService.webhooksConfigured())) {
        return reply.status(503).send({
          error: "Stripe webhooks are not configured"
        });
      }

      const rawBody = getRawRequestBodyBuffer(request);
      const event = await stripeService.constructWebhookEvent(rawBody, request.headers["stripe-signature"]);

      if (!event) {
        return reply.status(401).send({
          error: "Invalid Stripe webhook signature"
        });
      }

      await context.appService.handleStripeWebhook(event);
      return {
        ok: true
      };
    });
  });

  app.get("/api/auth/session", async request => ({
    authenticated: Boolean(request.session.user),
    username: request.session.user?.username
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = parseRequestBody(loginBodySchema, request);

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

  app.get("/api/provider-settings/:provider", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(providerParamsSchema, request);

    return context.providerSettingsService.get(params.provider);
  });

  app.put("/api/provider-settings/:provider", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(providerParamsSchema, request);
    const schema = providerSchemas[params.provider];
    const body = parseRequestBody(schema, request, { fallbackToEmptyObject: true });

    return context.providerSettingsService.update(params.provider, body as never);
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

    const body = parseRequestBody(plaidExchangeBodySchema, request);

    return await context.plaidService.exchangePublicToken(body.publicToken, body.label);
  });

  app.post("/api/connections/stripe/session", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return context.stripeService!.createConnectSession(request.session.user!.id);
  });

  app.post("/api/connections/stripe/finalize", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(stripeFinalizeBodySchema, request, { fallbackToEmptyObject: true });

    return context.stripeService!.finalizeAccounts(stripUndefined(body));
  });

  app.post("/api/connections/mono/exchange", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(monoExchangeBodySchema, request);
    return context.monoService!.exchangeCode(stripUndefined(body));
  });

  app.post("/api/connections/:id/stripe/reauth-finalize", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);
    const body = parseRequestBody(stripeReauthFinalizeBodySchema, request, { fallbackToEmptyObject: true });

    return context.stripeService!.finalizeReauthSession(stripUndefined({
      connectionId: params.id,
      ...body
    }));
  });

  app.post("/api/connections/simplefin/connect", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(simplefinConnectBodySchema, request);

    return await context.simplefinService.connectSetupToken(stripUndefined(body));
  });

  app.post("/api/connections/belvo/session", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return await context.belvoService.createConnectSession();
  });

  app.post("/api/connections/belvo/finalize", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(belvoFinalizeBodySchema, request);

    return await context.belvoService.connectLink(stripUndefined(body));
  });

  app.post("/api/connections/simplefin/reuse-cached", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(optionalLabelBodySchema, request, { fallbackToEmptyObject: true });

    return await context.simplefinService.reuseCachedConnection(body.label ?? null);
  });

  app.post("/api/connections/simplefin/import-existing", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(simplefinImportExistingBodySchema, request);

    return context.appService.importExistingSimpleFinLinks(body.connectionId);
  });

  app.post("/api/connections/home-values", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(homeValueConnectionBodySchema, request, { fallbackToEmptyObject: true });
    return context.appService.createHomeValueConnection(stripUndefined(body));
  });

  app.put("/api/connections/:id/home-values", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);
    const body = parseRequestBody(homeValueConnectionBodySchema, request, { fallbackToEmptyObject: true });
    return context.appService.updateHomeValueConnection(params.id, stripUndefined(body));
  });

  app.post("/api/connections/vehicle-values", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(vehicleValueConnectionBodySchema, request, { fallbackToEmptyObject: true });
    return context.appService.createVehicleValueConnection(stripUndefined(body));
  });

  app.put("/api/connections/:id/vehicle-values", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);
    const body = parseRequestBody(vehicleValueConnectionBodySchema, request, { fallbackToEmptyObject: true });
    return context.appService.updateVehicleValueConnection(params.id, stripUndefined(body));
  });

  app.get("/api/connections/teller/connect-config", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    return await context.tellerService.getConnectConfig();
  });

  app.post("/api/connections/teller/enroll", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(tellerEnrollBodySchema, request);

    return await context.tellerService.enrollConnection(stripUndefined(body));
  });

  app.post("/api/connections/teller/reuse-cached", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(optionalLabelBodySchema, request, { fallbackToEmptyObject: true });

    return await context.tellerService.reuseCachedConnection(body.label ?? null);
  });

  app.post("/api/connections/teller/sandbox/seed-connection", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const body = parseRequestBody(optionalLabelBodySchema, request, { fallbackToEmptyObject: true });

    return await context.tellerService.seedSandboxConnection(body.label);
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

    const body = parseRequestBody(optionalLabelBodySchema, request, { fallbackToEmptyObject: true });

    return await context.plaidService.seedSandboxConnection(body.label);
  });

  app.post("/api/connections/:id/refresh", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);

    await context.appService.refreshConnection(params.id);
    return {
      ok: true
    };
  });

  app.post("/api/connections/:id/reauth-session", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);

    return context.appService.createConnectionReauthSession(params.id, request.session.user!.id);
  });

  app.post("/api/connections/:id/disconnect", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);

    await context.appService.disconnectConnection(params.id);
    return {
      ok: true
    };
  });

  app.post("/api/connections/:id/plaid/sandbox/seed-transactions", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(connectionIdParamsSchema, request);

    const body = parseRequestBody(plaidSeedTransactionsBodySchema, request, { fallbackToEmptyObject: true });

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

    const params = parseRequestParams(actualAccountIdParamsSchema, request);

    const body = parseRequestBody(accountLinkBodySchema, request);

    await context.appService.upsertAccountLink(params.actualAccountId, stripUndefined(body));
    context.scheduler?.requestWakeup();
    return {
      ok: true
    };
  });

  app.post("/api/account-links/:actualAccountId/sync", async (request, reply) => {
    if (!assertAuthenticated(request, reply)) {
      return;
    }

    const params = parseRequestParams(actualAccountIdParamsSchema, request);

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
