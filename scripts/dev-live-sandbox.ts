import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import dotenv from "dotenv";
import { seedActualSandboxBudget } from "../apps/server/src/dev/actual-fixture.js";
import { startActualTestContainer } from "../apps/server/src/test/actual-container.js";
import { createSqliteDatabase } from "../apps/server/src/test/test-db.js";

dotenv.config();
dotenv.config({ path: ".env.example", override: false });

function requiredValue(name: string, fallback?: string) {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function sessionSecretValue() {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) {
    return value;
  }

  return "replace-with-long-random-secret-change-me-1234";
}

function actualSandboxPort() {
  const raw = process.env.ACTUAL_LIVE_SANDBOX_PORT || process.env.ACTUAL_TEST_PORT || "5007";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Actual live sandbox port: ${raw}`);
  }

  return port;
}

async function main() {
  const actualPassword = process.env.ACTUAL_TEST_PASSWORD || process.env.ACTUAL_SERVER_PASSWORD || "actual-test-password";
  const plaidClientId = process.env.PLAID_CLIENT_ID || process.env.PLAID_TEST_CLIENT_ID;
  const plaidSecret = process.env.PLAID_SECRET || process.env.PLAID_TEST_SECRET;
  const actualPort = actualSandboxPort();

  if (!plaidClientId || !plaidSecret) {
    throw new Error("Provide Plaid sandbox credentials via PLAID_CLIENT_ID/PLAID_SECRET or PLAID_TEST_CLIENT_ID/PLAID_TEST_SECRET");
  }

  const container = await startActualTestContainer({
    image: process.env.ACTUAL_TEST_IMAGE || "ghcr.io/actualbudget/actual:26.5.0-alpine",
    port: actualPort
  });
  const cleanups: Array<() => Promise<void>> = [() => container.stop()];

  try {
    await container.setPassword(actualPassword);
    const runtimeBaseDir = path.join(process.cwd(), ".tmp");
    await fs.mkdir(runtimeBaseDir, { recursive: true });
    const runtimeDir = await fs.mkdtemp(path.join(runtimeBaseDir, "actual-sync-live-sandbox-"));
    cleanups.unshift(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const liveSandboxDbPath = path.join(runtimeDir, "live-sandbox.db");
    const databaseUrl = `file:${liveSandboxDbPath}`;
    const seededDatabase = await createSqliteDatabase(databaseUrl);
    await seededDatabase.$disconnect();

    const seed = await seedActualSandboxBudget({
      serverURL: container.serverURL,
      password: actualPassword,
      dataDir: path.join(runtimeDir, "seed")
    });

    const launcherEnv = {
      ...process.env,
      NODE_ENV: "development",
      PORT: process.env.PORT || "4000",
      APP_BASE_URL: process.env.APP_BASE_URL || "http://localhost:4000",
      APP_INSTANCE_LABEL: "Live Sandbox",
      LIVE_SANDBOX_MODE: "1",
      DISABLE_SCHEDULER: "1",
      DATABASE_URL: databaseUrl,
      ACTUAL_SERVER_URL: container.serverURL,
      ACTUAL_SERVER_PASSWORD: actualPassword,
      ACTUAL_BUDGET_SYNC_ID: seed.syncId,
      ACTUAL_BUDGET_ENCRYPTION_PASSWORD: "",
      ACTUAL_DATA_DIR: path.join(runtimeDir, "actual-cache"),
      PLAID_CLIENT_ID: plaidClientId,
      PLAID_SECRET: plaidSecret,
      PLAID_ENV: "sandbox",
      PLAID_SANDBOX_TOOLS_ENABLED: "1",
      SESSION_SECRET: sessionSecretValue(),
      ADMIN_USERNAME: requiredValue("ADMIN_USERNAME", "admin"),
      ADMIN_PASSWORD: requiredValue("ADMIN_PASSWORD", "change-me-now")
    };

    const child = spawn("npm", ["run", "dev"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: launcherEnv
    });

    console.log("");
    console.log("Live sandbox ready:");
    console.log(`- Actual Sync Hub UI: http://localhost:5173`);
    console.log(`- API server: http://localhost:${process.env.PORT || "4000"}`);
    console.log(`- Actual docker server: ${container.serverURL}`);
    console.log(`- Seeded Actual accounts: ${seed.accounts.map(account => account.name).join(", ")}`);
    console.log(`- Login: ${process.env.ADMIN_USERNAME || "admin"}`);
    console.log("");

    let stopping = false;
    const stop = async () => {
      stopping = true;
      child.kill("SIGTERM");
      await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
    };

    process.on("SIGINT", () => {
      void stop().then(() => process.exit(0));
    });

    process.on("SIGTERM", () => {
      void stop().then(() => process.exit(0));
    });

    await new Promise<void>((resolve, reject) => {
      child.on("exit", async code => {
        await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
        if (stopping) {
          resolve();
          return;
        }

        if (code && code !== 0) {
          reject(new Error(`dev process exited with code ${code}`));
          return;
        }

        resolve();
      });
      child.on("error", reject);
    });
  } catch (error) {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
    throw error;
  }
}

void main();
