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
  ACTUAL_API_VERSION_MATCH_MODE: z.enum(["off", "auto", "strict"]).optional(),
  PLAID_CLIENT_ID: z.string().optional().default(""),
  PLAID_SECRET: z.string().optional().default(""),
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  PLAID_COUNTRY_CODES: z.string().default("US"),
  PLAID_PRODUCTS: z.string().default("transactions"),
  PLAID_TRANSACTIONS_DAYS_REQUESTED: z.coerce.number().int().min(1).max(730).default(365),
  PLAID_PERSONAL_FINANCE_CATEGORY_VERSION: z.enum(["v1", "v2"]).default("v2"),
  PLAID_SANDBOX_TOOLS_ENABLED: z.enum(["0", "1"]).default("0"),
  LIVE_SANDBOX_MODE: z.enum(["0", "1"]).default("0"),
  DISABLE_SCHEDULER: z.enum(["0", "1"]).default("0")
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  ACTUAL_DATA_DIR: path.resolve(process.cwd(), parsed.ACTUAL_DATA_DIR),
  actualApiVersionMatchMode:
    parsed.ACTUAL_API_VERSION_MATCH_MODE ??
    (parsed.NODE_ENV === "production" && parsed.LIVE_SANDBOX_MODE !== "1" ? "off" : "auto"),
  plaidEnabled: Boolean(parsed.PLAID_CLIENT_ID && parsed.PLAID_SECRET),
  plaidSandboxToolsEnabled: parsed.PLAID_SANDBOX_TOOLS_ENABLED === "1",
  liveSandboxMode: parsed.LIVE_SANDBOX_MODE === "1",
  disableScheduler: parsed.DISABLE_SCHEDULER === "1"
};
