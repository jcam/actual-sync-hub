import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { seedActualSandboxBudget } from "../apps/server/src/dev/actual-fixture.js";
import { startActualTestContainer } from "../apps/server/src/test/actual-container.js";
import { createSqliteDatabase } from "../apps/server/src/test/test-db.js";

const execFileAsync = promisify(execFile);

dotenv.config();
dotenv.config({ path: ".env.example", override: false });

const DEV_APP_IMAGE = "actual-sync-hub-dev";
const DEV_APP_CONTAINER = "actual-sync-live-sandbox-app";
const DEV_ACTUAL_NETWORK = "actual-sync-live-sandbox";
const DEV_NODE_MODULES_VOLUME = "actual-sync-live-sandbox-node-modules";

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

function splitCsv(value: string | undefined, fallback: string) {
  return (value || fallback)
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
}

async function readOptionalFile(filePath: string | undefined) {
  if (!filePath) {
    return "";
  }

  return fs.readFile(filePath, "utf8");
}

function actualSandboxPort() {
  const raw = process.env.ACTUAL_LIVE_SANDBOX_PORT || process.env.ACTUAL_TEST_PORT || "5007";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid Actual live sandbox port: ${raw}`);
  }

  return port;
}

async function waitForHttp(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401 || response.status === 403) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function removeContainerIfExists(name: string) {
  await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
}

async function ensureDockerNetwork(name: string) {
  const inspect = await execFileAsync("docker", ["network", "inspect", name]).catch(() => null);
  if (inspect) {
    return;
  }

  await execFileAsync("docker", ["network", "create", name]);
}

async function removeDockerNetwork(name: string) {
  await execFileAsync("docker", ["network", "rm", name]).catch(() => undefined);
}

async function ensureDockerVolume(name: string) {
  const inspect = await execFileAsync("docker", ["volume", "inspect", name]).catch(() => null);
  if (inspect) {
    return;
  }

  await execFileAsync("docker", ["volume", "create", name]);
}

async function buildDevAppImage() {
  await execFileAsync("docker", [
    "build",
    "-f",
    "Dockerfile.dev",
    "-t",
    DEV_APP_IMAGE,
    "."
  ]);
}

function toContainerPath(localPath: string) {
  const relative = path.relative(process.cwd(), localPath);
  return path.posix.join("/workspace", relative.split(path.sep).join("/"));
}

async function startDevAppContainer({
  actualServerUrl,
  actualPassword,
  budgetSyncId,
  databaseUrl,
  actualDataDir
}: {
  actualServerUrl: string;
  actualPassword: string;
  budgetSyncId: string;
  databaseUrl: string;
  actualDataDir: string;
}) {
  await removeContainerIfExists(DEV_APP_CONTAINER);
  await ensureDockerNetwork(DEV_ACTUAL_NETWORK);
  await ensureDockerVolume(DEV_NODE_MODULES_VOLUME);
  await buildDevAppImage();

  const args = [
    "run",
    "--rm",
    "-d",
    "--name",
    DEV_APP_CONTAINER,
    "--network",
    DEV_ACTUAL_NETWORK,
    "-p",
    `${process.env.PORT || "4000"}:4000`,
    "-p",
    "5173:5173",
    "-v",
    `${process.cwd()}:/workspace`,
    "-v",
    `${DEV_NODE_MODULES_VOLUME}:/workspace/node_modules`,
    "-w",
    "/workspace",
    "-e",
    "NODE_ENV=development",
    "-e",
    `PORT=${process.env.PORT || "4000"}`,
    "-e",
    `APP_BASE_URL=${process.env.APP_BASE_URL || "http://localhost:4000"}`,
    "-e",
    "APP_INSTANCE_LABEL=Live Sandbox",
    "-e",
    "LIVE_SANDBOX_MODE=1",
    "-e",
    "DISABLE_SCHEDULER=1",
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    "-e",
    `ACTUAL_SERVER_URL=${actualServerUrl}`,
    "-e",
    `ACTUAL_SERVER_PASSWORD=${actualPassword}`,
    "-e",
    `ACTUAL_BUDGET_SYNC_ID=${budgetSyncId}`,
    "-e",
    "ACTUAL_BUDGET_ENCRYPTION_PASSWORD=",
    "-e",
    `ACTUAL_DATA_DIR=${actualDataDir}`,
    "-e",
    `PROVIDER_FIXTURE_CACHE_ENABLED=${process.env.PROVIDER_FIXTURE_CACHE_ENABLED || "0"}`,
    "-e",
    `PROVIDER_FIXTURE_CACHE_FILE=${process.env.PROVIDER_FIXTURE_CACHE_FILE || "./.local/provider-fixtures.json"}`,
    "-e",
    `SESSION_SECRET=${sessionSecretValue()}`,
    "-e",
    `ADMIN_USERNAME=${requiredValue("ADMIN_USERNAME", "admin")}`,
    "-e",
    `ADMIN_PASSWORD=${requiredValue("ADMIN_PASSWORD", "change-me-now")}`,
    "-e",
    "VITE_HOST=0.0.0.0",
    DEV_APP_IMAGE
  ];

  await execFileAsync("docker", args);
}

async function loginToApp(baseUrl: string, username: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username,
      password
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to log into live sandbox API: ${response.status}`);
  }

  const sessionCookie = response.headers.get("set-cookie");
  if (!sessionCookie) {
    throw new Error("Live sandbox login did not return a session cookie");
  }

  return sessionCookie.split(";")[0];
}

async function updateProviderSetting(
  baseUrl: string,
  sessionCookie: string,
  provider: "PLAID" | "STRIPE" | "TELLER" | "SIMPLEFIN",
  settings: unknown
) {
  const response = await fetch(`${baseUrl}/api/provider-settings/${provider}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie
    },
    body: JSON.stringify(settings)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Failed to update ${provider} settings: ${response.status} ${errorText}`);
  }
}

async function configureLiveSandboxProviderSettings(baseUrl: string) {
  const sessionCookie = await loginToApp(
    baseUrl,
    requiredValue("ADMIN_USERNAME", "admin"),
    requiredValue("ADMIN_PASSWORD", "change-me-now")
  );

  const tellerCertificatePem = await readOptionalFile(process.env.TELLER_TEST_CERT_FILE);
  const tellerKeyPem = await readOptionalFile(process.env.TELLER_TEST_KEY_FILE);

  await updateProviderSetting(baseUrl, sessionCookie, "PLAID", {
    environment: (process.env.PLAID_TEST_ENV || "sandbox") === "production" ? "production" : "sandbox",
    sandbox: {
      clientId: (process.env.PLAID_TEST_ENV || "sandbox") === "sandbox" ? process.env.PLAID_TEST_CLIENT_ID || "" : "",
      secret: (process.env.PLAID_TEST_ENV || "sandbox") === "sandbox" ? process.env.PLAID_TEST_SECRET || "" : ""
    },
    production: {
      clientId: (process.env.PLAID_TEST_ENV || "sandbox") === "production" ? process.env.PLAID_TEST_CLIENT_ID || "" : "",
      secret: (process.env.PLAID_TEST_ENV || "sandbox") === "production" ? process.env.PLAID_TEST_SECRET || "" : ""
    },
    countryCodes: ["US"],
    products: ["transactions"],
    transactionsDaysRequested: 365,
    personalFinanceCategoryVersion: "v2",
    automaticSyncConcurrency: 2
  });

  await updateProviderSetting(baseUrl, sessionCookie, "STRIPE", {
    environment: (process.env.STRIPE_TEST_ENV || "test") === "live" ? "live" : "test",
    test: {
      publishableKey: (process.env.STRIPE_TEST_ENV || "test") === "test" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
      secretKey: (process.env.STRIPE_TEST_ENV || "test") === "test" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
      webhookSigningSecrets:
        (process.env.STRIPE_TEST_ENV || "test") === "test"
          ? splitCsv(process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS, "")
          : []
    },
    live: {
      publishableKey: (process.env.STRIPE_TEST_ENV || "test") === "live" ? process.env.STRIPE_TEST_PUBLISHABLE_KEY || "" : "",
      secretKey: (process.env.STRIPE_TEST_ENV || "test") === "live" ? process.env.STRIPE_TEST_SECRET_KEY || "" : "",
      webhookSigningSecrets:
        (process.env.STRIPE_TEST_ENV || "test") === "live"
          ? splitCsv(process.env.STRIPE_TEST_WEBHOOK_SIGNING_SECRETS, "")
          : []
    },
    countryCodes: ["US"],
    permissions: ["balances", "transactions"],
    prefetch: ["balances", "transactions"],
    transactionsInitialDays: 90,
    automaticSyncConcurrency: 2
  });

  await updateProviderSetting(baseUrl, sessionCookie, "TELLER", {
    environment: process.env.TELLER_TEST_ENV || "sandbox",
    sandbox: {
      appId: (process.env.TELLER_TEST_ENV || "sandbox") === "sandbox" ? process.env.TELLER_TEST_APP_ID || "" : "",
      sandboxAccessToken: process.env.TELLER_TEST_SANDBOX_ACCESS_TOKEN || ""
    },
    development: {
      appId: (process.env.TELLER_TEST_ENV || "sandbox") === "development" ? process.env.TELLER_TEST_APP_ID || "" : "",
      certificatePem: (process.env.TELLER_TEST_ENV || "sandbox") === "development" ? tellerCertificatePem : "",
      keyPem: (process.env.TELLER_TEST_ENV || "sandbox") === "development" ? tellerKeyPem : "",
      webhookSigningSecrets:
        (process.env.TELLER_TEST_ENV || "sandbox") === "development"
          ? splitCsv(process.env.TELLER_TEST_WEBHOOK_SIGNING_SECRETS, "")
          : []
    },
    production: {
      appId: (process.env.TELLER_TEST_ENV || "sandbox") === "production" ? process.env.TELLER_TEST_APP_ID || "" : "",
      certificatePem: (process.env.TELLER_TEST_ENV || "sandbox") === "production" ? tellerCertificatePem : "",
      keyPem: (process.env.TELLER_TEST_ENV || "sandbox") === "production" ? tellerKeyPem : "",
      webhookSigningSecrets:
        (process.env.TELLER_TEST_ENV || "sandbox") === "production"
          ? splitCsv(process.env.TELLER_TEST_WEBHOOK_SIGNING_SECRETS, "")
          : []
    },
    transactionsInitialDays: 90,
    transactionsOverlapDays: 10,
    automaticSyncConcurrency: 1,
    webhookSyncDebounceSeconds: 30,
    webhookToleranceSeconds: 180
  });

  await updateProviderSetting(baseUrl, sessionCookie, "SIMPLEFIN", {
    mode: "sandbox",
    development: {
      serverUrl: ""
    },
    transactionsInitialDays: 45,
    automaticSyncConcurrency: 2
  });
}

async function main() {
  const actualPassword = process.env.ACTUAL_TEST_PASSWORD || process.env.ACTUAL_SERVER_PASSWORD || "actual-test-password";
  const actualPort = actualSandboxPort();

  const cleanups: Array<() => Promise<void>> = [async () => removeDockerNetwork(DEV_ACTUAL_NETWORK)];
  await ensureDockerNetwork(DEV_ACTUAL_NETWORK);

  const container = await startActualTestContainer({
    image: process.env.ACTUAL_TEST_IMAGE || "ghcr.io/actualbudget/actual:26.5.0-alpine",
    port: actualPort,
    network: DEV_ACTUAL_NETWORK
  });
  cleanups.unshift(() => container.stop());

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
    const containerDatabaseUrl = `file:${toContainerPath(liveSandboxDbPath)}`;
    const containerActualDataDir = toContainerPath(path.join(runtimeDir, "actual-cache"));

    await startDevAppContainer({
      actualServerUrl: `http://${container.containerName}:5006`,
      actualPassword,
      budgetSyncId: seed.syncId,
      databaseUrl: containerDatabaseUrl,
      actualDataDir: containerActualDataDir
    });
    cleanups.unshift(async () => {
      await removeContainerIfExists(DEV_APP_CONTAINER);
    });

    const apiBaseUrl = `http://127.0.0.1:${process.env.PORT || "4000"}`;
    await waitForHttp(`${apiBaseUrl}/api/auth/session`);
    await waitForHttp("http://127.0.0.1:5173");
    await configureLiveSandboxProviderSettings(apiBaseUrl);

    console.log("");
    console.log("Live sandbox ready:");
    console.log(`- Actual Sync Hub UI: http://localhost:5173`);
    console.log(`- API server: http://localhost:${process.env.PORT || "4000"}`);
    console.log(`- Actual docker server: ${container.serverURL}`);
    console.log(`- Seeded Actual accounts: ${seed.accounts.map(account => account.name).join(", ")}`);
    console.log(`- Login: ${process.env.ADMIN_USERNAME || "admin"}`);
    console.log("");

    let stopping = false;
    const logFollower = spawn("docker", ["logs", "-f", DEV_APP_CONTAINER], {
      stdio: "inherit"
    });
    const stop = async () => {
      stopping = true;
      logFollower.kill("SIGTERM");
      await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
    };

    process.on("SIGINT", () => {
      void stop().then(() => process.exit(0));
    });

    process.on("SIGTERM", () => {
      void stop().then(() => process.exit(0));
    });

    await new Promise<void>((resolve, reject) => {
      logFollower.on("exit", code => {
        void (async () => {
          await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
          if (stopping) {
            resolve();
            return;
          }

          if (code && code !== 0) {
            reject(new Error(`dev container log stream exited with code ${code}`));
            return;
          }

          resolve();
        })();
      });
      logFollower.on("error", reject);
    });
  } catch (error) {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup().catch(() => undefined)));
    throw error;
  }
}

void main();
