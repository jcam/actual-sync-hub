import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthService } from "./auth.js";

describe("createAuthService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when the user does not exist", async () => {
    const service = createAuthService({
      prisma: {
        user: {
          findUnique: vi.fn().mockResolvedValue(null)
        }
      } as never
    });

    await expect(service.authenticateUser("admin", "secret")).resolves.toBeNull();
  });

  it("returns null when password verification fails", async () => {
    const verifyPasswordFn = vi.fn().mockResolvedValue(false);
    const service = createAuthService({
      prisma: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            username: "admin",
            passwordHash: "hash"
          })
        }
      } as never,
      verifyPasswordFn
    });

    await expect(service.authenticateUser("admin", "wrong")).resolves.toBeNull();
    expect(verifyPasswordFn).toHaveBeenCalledWith("wrong", "hash");
  });

  it("returns the user id and username when authentication succeeds", async () => {
    const service = createAuthService({
      prisma: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: "user-1",
            username: "admin",
            passwordHash: "hash"
          })
        }
      } as never,
      verifyPasswordFn: vi.fn().mockResolvedValue(true)
    });

    await expect(service.authenticateUser("admin", "secret")).resolves.toEqual({
      id: "user-1",
      username: "admin"
    });
  });

  it("validates Actual tokens using the expected header and success payload", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      expect(url).toContain("/account/validate");
      expect(init?.headers).toEqual({
        "X-ACTUAL-TOKEN": "token-123"
      });
      return new Response(JSON.stringify({
        status: "ok"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createAuthService();

    await expect(service.validateActualToken("token-123")).resolves.toBe(true);
  });

  it("returns false when the Actual API rejects the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));

    const service = createAuthService();

    await expect(service.validateActualToken("token-123")).resolves.toBe(false);
  });

  it("returns false when the Actual API call throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const service = createAuthService();

    await expect(service.validateActualToken("token-123")).resolves.toBe(false);
  });
});
