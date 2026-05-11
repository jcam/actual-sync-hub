import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createServer } from "./server.js";
import { createTrackedApps, loginAsAdmin, makeContext } from "./routes.test-helpers.js";

describe("server error handling", () => {
  const trackedApps = createTrackedApps();

  afterEach(async () => {
    await trackedApps.cleanup();
  });

  it("returns a 400 for invalid raw JSON webhook bodies", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          plaidService: {
            webhooksConfigured: vi.fn().mockReturnValue(true),
            verifyWebhookSignature: vi.fn().mockReturnValue(true)
          }
        })
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/plaid",
      headers: {
        "content-type": "application/json",
        "plaid-verification": "jwt-value"
      },
      payload: "{not-json"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Invalid JSON body"
    });
  });

  it("returns a 500 when a route throws an unexpected error", async () => {
    const listConnections = vi.fn().mockRejectedValue(new Error("boom"));
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext({
          authService: {
            authenticateUser: vi.fn().mockResolvedValue({
              id: "user-1",
              username: "admin"
            })
          },
          appService: {
            listConnections
          }
        })
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/connections",
      cookies: await loginAsAdmin(app)
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "Internal server error"
    });
  });

  it("formats enum validation issues through the shared Zod error handler", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext()
      })
    );

    app.get("/test/invalid-enum", async () => {
      z.object({
        provider: z.enum(["PLAID", "STRIPE"])
      }).parse({
        provider: "TELLER"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/invalid-enum"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Provider must be one of PLAID, STRIPE.",
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "Provider must be one of PLAID, STRIPE."
        })
      ])
    });
  });

  it("formats URL validation issues through the shared Zod error handler", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: false,
        context: makeContext()
      })
    );

    app.get("/test/invalid-url", async () => {
      z.object({
        appBaseUrl: z.string().url()
      }).parse({
        appBaseUrl: "not-a-url"
      });
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/invalid-url"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "App Base URL must be a valid URL.",
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: "App Base URL must be a valid URL."
        })
      ])
    });
  });

  it("serves the built web app when static assets are enabled", async () => {
    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: true,
        context: makeContext()
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<!doctype html>");
  });

  it("skips static asset registration when the web dist is missing", async () => {
    const access = vi.spyOn(fs, "access").mockRejectedValueOnce(Object.assign(new Error("missing"), {
      code: "ENOENT"
    }));

    const app = trackedApps.track(
      await createServer({
        sessionSecret: "0123456789abcdef0123456789abcdef",
        nodeEnv: "test",
        enableStatic: true,
        context: makeContext()
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(404);
    access.mockRestore();
  });
});
