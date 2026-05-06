import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  APP_BASE_URL: z.string().url().default("http://localhost:4000"),
  APP_INSTANCE_LABEL: z.string().default("Actual Sync Hub"),
  SESSION_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8),
  DATABASE_URL: z.string().min(1),
  ACTUAL_SERVER_URL: z.string().url(),
  ACTUAL_SERVER_PASSWORD: z.string().min(1),
  ACTUAL_BUDGET_SYNC_ID: z.string().min(1),
  ACTUAL_BUDGET_ENCRYPTION_PASSWORD: z.string().optional().default(""),
  ACTUAL_DATA_DIR: z.string().default("./data/actual-cache"),
  ACTUAL_API_LOCAL_ENTRY: z.string().optional().default(""),
  ACTUAL_API_VERSION_MATCH_MODE: z.enum(["off", "auto", "strict"]).optional(),
  ACTUAL_EXTERNAL_SYNC_WRITEBACK_ENABLED: z.enum(["0", "1"]).default("0"),
  AUTOMATIC_SYNC_BACKOFF_BASE_MINUTES: z.coerce.number().int().min(1).max(120).default(5),
  AUTOMATIC_SYNC_BACKOFF_MAX_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  PROVIDER_FIXTURE_CACHE_ENABLED: z.enum(["0", "1"]).default("0"),
  PROVIDER_FIXTURE_CACHE_FILE: z.string().default("./.local/provider-fixtures.json"),
  LIVE_SANDBOX_MODE: z.enum(["0", "1"]).default("0"),
  DISABLE_SCHEDULER: z.enum(["0", "1"]).default("0")
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  ACTUAL_DATA_DIR: path.resolve(process.cwd(), parsed.ACTUAL_DATA_DIR),
  ACTUAL_API_LOCAL_ENTRY: parsed.ACTUAL_API_LOCAL_ENTRY ? path.resolve(process.cwd(), parsed.ACTUAL_API_LOCAL_ENTRY) : "",
  actualApiVersionMatchMode:
    parsed.ACTUAL_API_VERSION_MATCH_MODE ??
    (parsed.NODE_ENV === "production" && parsed.LIVE_SANDBOX_MODE !== "1" ? "off" : "auto"),
  actualExternalSyncWritebackEnabled: parsed.ACTUAL_EXTERNAL_SYNC_WRITEBACK_ENABLED === "1",
  providerFixtureCacheEnabled: parsed.PROVIDER_FIXTURE_CACHE_ENABLED === "1",
  providerFixtureCacheFile: path.resolve(process.cwd(), parsed.PROVIDER_FIXTURE_CACHE_FILE),
  liveSandboxMode: parsed.LIVE_SANDBOX_MODE === "1",
  disableScheduler: parsed.DISABLE_SCHEDULER === "1"
};
