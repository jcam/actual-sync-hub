import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";

export interface CachedSimpleFinFixture {
  accessKey: string;
  updatedAt: string;
}

export interface CachedTellerFixture {
  accessToken: string;
  enrollmentId: string;
  userId?: string | null;
  institutionName?: string | null;
  updatedAt: string;
}

interface ProviderFixtureCacheFile {
  simplefin?: CachedSimpleFinFixture | null;
  teller?: CachedTellerFixture | null;
}

export interface ProviderFixtureCache {
  isEnabled(): boolean;
  getSimpleFin(): Promise<CachedSimpleFinFixture | null>;
  setSimpleFin(fixture: CachedSimpleFinFixture): Promise<void>;
  clearSimpleFin(): Promise<void>;
  getTeller(): Promise<CachedTellerFixture | null>;
  setTeller(fixture: CachedTellerFixture): Promise<void>;
  clearTeller(): Promise<void>;
}

async function readCacheFile(filePath: string): Promise<ProviderFixtureCacheFile> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ProviderFixtureCacheFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeCacheFile(filePath: string, data: ProviderFixtureCacheFile) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function createProviderFixtureCache({
  enabled = env.providerFixtureCacheEnabled,
  filePath = env.providerFixtureCacheFile
}: {
  enabled?: boolean;
  filePath?: string;
} = {}): ProviderFixtureCache {
  return {
    isEnabled() {
      return enabled;
    },

    async getSimpleFin() {
      if (!enabled) {
        return null;
      }
      return (await readCacheFile(filePath)).simplefin ?? null;
    },

    async setSimpleFin(fixture) {
      if (!enabled) {
        return;
      }
      const current = await readCacheFile(filePath);
      await writeCacheFile(filePath, {
        ...current,
        simplefin: fixture
      });
    },

    async clearSimpleFin() {
      if (!enabled) {
        return;
      }
      const current = await readCacheFile(filePath);
      await writeCacheFile(filePath, {
        ...current,
        simplefin: null
      });
    },

    async getTeller() {
      if (!enabled) {
        return null;
      }
      return (await readCacheFile(filePath)).teller ?? null;
    },

    async setTeller(fixture) {
      if (!enabled) {
        return;
      }
      const current = await readCacheFile(filePath);
      await writeCacheFile(filePath, {
        ...current,
        teller: fixture
      });
    },

    async clearTeller() {
      if (!enabled) {
        return;
      }
      const current = await readCacheFile(filePath);
      await writeCacheFile(filePath, {
        ...current,
        teller: null
      });
    }
  };
}

export const providerFixtureCache = createProviderFixtureCache();
