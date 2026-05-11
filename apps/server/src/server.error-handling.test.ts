import { afterEach, describe, expect, it, vi } from "vitest";
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
});
