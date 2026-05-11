import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderFixtureCache } from "./provider-fixture-cache.js";

async function createTempCachePath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "actual-sync-provider-cache-"));
  return {
    filePath: path.join(directory, "provider-cache.json"),
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}

describe("createProviderFixtureCache", () => {
  afterEach(() => {
    // no shared global state to reset, but keep structure aligned with async temp cleanup tests
  });

  it("returns nulls and does not write files when the cache is disabled", async () => {
    const { filePath, cleanup } = await createTempCachePath();

    try {
      const cache = createProviderFixtureCache({
        enabled: false,
        filePath
      });

      expect(cache.isEnabled()).toBe(false);
      await expect(cache.getSimpleFin()).resolves.toBeNull();
      await expect(cache.getTeller()).resolves.toBeNull();

      await cache.setSimpleFin({
        accessKey: "simplefin-key",
        updatedAt: "2026-05-11T12:00:00.000Z"
      });
      await cache.setTeller({
        accessToken: "teller-token",
        enrollmentId: "enrollment-1",
        updatedAt: "2026-05-11T12:00:00.000Z"
      });

      await expect(fs.access(filePath)).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await cleanup();
    }
  });

  it("persists and reads both provider fixtures from the same backing file", async () => {
    const { filePath, cleanup } = await createTempCachePath();

    try {
      const cache = createProviderFixtureCache({
        enabled: true,
        filePath
      });

      await cache.setSimpleFin({
        accessKey: "simplefin-key",
        updatedAt: "2026-05-11T12:00:00.000Z"
      });
      await cache.setTeller({
        accessToken: "teller-token",
        enrollmentId: "enrollment-1",
        userId: "user-1",
        institutionName: "Mock Bank",
        updatedAt: "2026-05-11T12:30:00.000Z"
      });

      await expect(cache.getSimpleFin()).resolves.toEqual({
        accessKey: "simplefin-key",
        updatedAt: "2026-05-11T12:00:00.000Z"
      });
      await expect(cache.getTeller()).resolves.toEqual({
        accessToken: "teller-token",
        enrollmentId: "enrollment-1",
        userId: "user-1",
        institutionName: "Mock Bank",
        updatedAt: "2026-05-11T12:30:00.000Z"
      });

      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
        simplefin: {
          accessKey: "simplefin-key",
          updatedAt: "2026-05-11T12:00:00.000Z"
        },
        teller: {
          accessToken: "teller-token",
          enrollmentId: "enrollment-1",
          userId: "user-1",
          institutionName: "Mock Bank",
          updatedAt: "2026-05-11T12:30:00.000Z"
        }
      });
    } finally {
      await cleanup();
    }
  });

  it("clears one provider fixture without removing the other", async () => {
    const { filePath, cleanup } = await createTempCachePath();

    try {
      const cache = createProviderFixtureCache({
        enabled: true,
        filePath
      });

      await cache.setSimpleFin({
        accessKey: "simplefin-key",
        updatedAt: "2026-05-11T12:00:00.000Z"
      });
      await cache.setTeller({
        accessToken: "teller-token",
        enrollmentId: "enrollment-1",
        updatedAt: "2026-05-11T12:30:00.000Z"
      });

      await cache.clearSimpleFin();

      await expect(cache.getSimpleFin()).resolves.toBeNull();
      await expect(cache.getTeller()).resolves.toEqual({
        accessToken: "teller-token",
        enrollmentId: "enrollment-1",
        updatedAt: "2026-05-11T12:30:00.000Z"
      });

      await cache.clearTeller();
      await expect(cache.getTeller()).resolves.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("treats invalid cache JSON as empty state", async () => {
    const { filePath, cleanup } = await createTempCachePath();

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "[1,2,3]\n", "utf8");

      const cache = createProviderFixtureCache({
        enabled: true,
        filePath
      });

      await expect(cache.getSimpleFin()).resolves.toBeNull();
      await expect(cache.getTeller()).resolves.toBeNull();
    } finally {
      await cleanup();
    }
  });
});
