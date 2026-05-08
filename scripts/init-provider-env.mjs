import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";

const providerChoices = ["PLAID", "STRIPE", "TELLER", "SIMPLEFIN", "SALT_EDGE", "HOME_VALUES"];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = "true";
    }
  }
  return args;
}

function ensureEnvFile(envPath) {
  if (existsSync(envPath)) {
    return;
  }
  const examplePath = resolve(".env.example");
  const seed = existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
  writeFileSync(envPath, seed, "utf8");
}

function parseExistingEnv(envPath) {
  const raw = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  return {
    raw,
    parsed: dotenv.parse(raw || "")
  };
}

function serializeEnvValue(value) {
  if (value.length === 0) {
    return "";
  }
  if (/^[A-Za-z0-9._:/@,=-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function applyEnvUpdates(envPath, title, updates) {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const titleComment = `# ${title}`;
  const managedKeys = new Set(Object.keys(updates));
  const retainedLines = current
    .split(/\r?\n/u)
    .filter(line => {
      const trimmed = line.trim();
      if (trimmed === titleComment) {
        return false;
      }
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        return true;
      }
      const key = trimmed.slice(0, separator);
      return !managedKeys.has(key);
    })
    .join("\n")
    .replace(/\s+$/u, "");

  const block = [
    retainedLines,
    retainedLines ? "" : "",
    titleComment,
    ...Object.entries(updates).map(([key, value]) => `${key}=${serializeEnvValue(value)}`)
  ]
    .filter((_line, index, lines) => !(index === 1 && lines[0] === ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");

  writeFileSync(envPath, `${block.trimEnd()}\n`, "utf8");
}

async function promptProvider(rl) {
  console.log("Choose a provider:");
  providerChoices.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider}`);
  });

  while (true) {
    const answer = (await rl.question("Provider number: ")).trim();
    const numeric = Number.parseInt(answer, 10);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= providerChoices.length) {
      return providerChoices[numeric - 1];
    }
    console.log("Enter one of the listed numbers.");
  }
}

async function ask(rl, label, options = {}) {
  const { defaultValue = "", required = false, validate } = options;
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const value = answer || defaultValue;

    if (required && !value) {
      console.log("This value is required.");
      continue;
    }
    if (validate) {
      const message = validate(value);
      if (message) {
        console.log(message);
        continue;
      }
    }
    return value;
  }
}

async function askChoice(rl, label, choices, defaultValue) {
  const display = choices.join("/");
  while (true) {
    const value = await ask(rl, `${label} (${display})`, { defaultValue, required: true });
    if (choices.includes(value)) {
      return value;
    }
    console.log(`Choose one of: ${choices.join(", ")}`);
  }
}

async function maybeExchangeSimpleFinSetupToken(setupToken) {
  const claimUrl = Buffer.from(setupToken, "base64").toString("utf8");
  if (!/^https?:\/\//u.test(claimUrl)) {
    throw new Error("That does not look like a valid SimpleFIN setup token.");
  }

  const response = await fetch(claimUrl, {
    method: "POST",
    headers: {
      "Content-Length": "0"
    }
  });
  if (!response.ok) {
    throw new Error(`SimpleFIN setup-token exchange failed with status ${response.status}.`);
  }

  const accessKey = (await response.text()).trim();
  if (!/^https?:\/\/[^:]+:[^@]+@.+$/u.test(accessKey)) {
    throw new Error("SimpleFIN returned an unexpected access key format.");
  }
  return accessKey;
}

async function buildProviderUpdates(provider, rl, args) {
  switch (provider) {
    case "PLAID": {
      const environment = args.env || (await askChoice(rl, "Plaid environment", ["sandbox", "production"], "sandbox"));
      const clientId = args["client-id"] || (await ask(rl, "PLAID_TEST_CLIENT_ID", { required: true }));
      const secret = args.secret || (await ask(rl, "PLAID_TEST_SECRET", { required: true }));
      return {
        title: "Plaid development / test credentials",
        updates: {
          PLAID_TEST_RUN_LIVE: "1",
          PLAID_TEST_ENV: environment,
          PLAID_TEST_CLIENT_ID: clientId,
          PLAID_TEST_SECRET: secret
        }
      };
    }
    case "STRIPE": {
      const environment = args.env || (await askChoice(rl, "Stripe environment", ["test", "live"], "test"));
      const publishableKey =
        args["publishable-key"] || (await ask(rl, "STRIPE_TEST_PUBLISHABLE_KEY", { required: true }));
      const secretKey = args["secret-key"] || (await ask(rl, "STRIPE_TEST_SECRET_KEY", { required: true }));
      const webhookSigningSecrets =
        args["webhook-secrets"] ||
        (await ask(rl, "STRIPE_TEST_WEBHOOK_SIGNING_SECRETS (comma-separated, optional)", { defaultValue: "" }));
      const customerId =
        args["customer-id"] ||
        (await ask(rl, "STRIPE_TEST_CUSTOMER_ID (optional customer for deeper live tests)", { defaultValue: "" }));
      const accountId =
        args["account-id"] ||
        (await ask(rl, "STRIPE_TEST_ACCOUNT_ID (optional preferred account for sync tests)", { defaultValue: "" }));
      return {
        title: "Stripe development / test credentials",
        updates: {
          STRIPE_TEST_RUN_LIVE: "1",
          STRIPE_TEST_ENV: environment,
          STRIPE_TEST_PUBLISHABLE_KEY: publishableKey,
          STRIPE_TEST_SECRET_KEY: secretKey,
          STRIPE_TEST_WEBHOOK_SIGNING_SECRETS: webhookSigningSecrets,
          STRIPE_TEST_CUSTOMER_ID: customerId,
          STRIPE_TEST_ACCOUNT_ID: accountId
        }
      };
    }
    case "TELLER": {
      const environment =
        args.env || (await askChoice(rl, "Teller environment", ["sandbox", "development", "production"], "sandbox"));
      const appId = args["app-id"] || (await ask(rl, "TELLER_TEST_APP_ID", { required: true }));
      const updates = {
        TELLER_TEST_RUN_LIVE: "1",
        TELLER_TEST_ENV: environment,
        TELLER_TEST_APP_ID: appId,
        TELLER_TEST_CERT_FILE: "",
        TELLER_TEST_KEY_FILE: "",
        TELLER_TEST_SANDBOX_ACCESS_TOKEN: "",
        TELLER_TEST_WEBHOOK_SIGNING_SECRETS: ""
      };

      if (environment === "sandbox") {
        updates.TELLER_TEST_SANDBOX_ACCESS_TOKEN =
          args["sandbox-access-token"] ||
          (await ask(rl, "TELLER_TEST_SANDBOX_ACCESS_TOKEN", {
            required: true
          }));
      } else {
        updates.TELLER_TEST_CERT_FILE =
          args["cert-file"] || (await ask(rl, "Path to Teller client certificate PEM", { required: true }));
        updates.TELLER_TEST_KEY_FILE =
          args["key-file"] || (await ask(rl, "Path to Teller private key PEM", { required: true }));
        updates.TELLER_TEST_WEBHOOK_SIGNING_SECRETS =
          args["webhook-secrets"] ||
          (await ask(rl, "Webhook signing secrets (comma-separated, optional)", { defaultValue: "" }));
      }

      return {
        title: "Teller development / test credentials",
        updates
      };
    }
    case "SIMPLEFIN": {
      const mode = args["setup-token"]
        ? "setup_token"
        : args["access-key"]
          ? "access_key"
          : await askChoice(rl, "SimpleFIN input type", ["setup_token", "access_key"], "setup_token");
      let accessKey = "";
      if (mode === "setup_token") {
        const setupToken = args["setup-token"] || (await ask(rl, "Paste a one-time SimpleFIN setup token", { required: true }));
        accessKey = await maybeExchangeSimpleFinSetupToken(setupToken);
        console.log("Setup token exchanged successfully. Saving the resulting access key to .env.");
      } else {
        accessKey =
          args["access-key"] ||
          (await ask(rl, "SIMPLEFIN_TEST_ACCESS_KEY", {
            required: true,
            validate(value) {
              return /^https?:\/\/[^:]+:[^@]+@.+$/u.test(value)
                ? ""
                : "Expected a full SimpleFIN access key URL with embedded credentials.";
            }
          }));
      }

      const accountId = args["account-id"] || (await ask(rl, "SIMPLEFIN_TEST_ACCOUNT_ID (optional)", { defaultValue: "" }));
      return {
        title: "SimpleFIN development / test credentials",
        updates: {
          SIMPLEFIN_TEST_RUN_LIVE: "1",
          SIMPLEFIN_TEST_ACCESS_KEY: accessKey,
          SIMPLEFIN_TEST_ACCOUNT_ID: accountId
        }
      };
    }
    case "SALT_EDGE": {
      const environment =
        args.env || (await askChoice(rl, "Salt Edge environment", ["sandbox", "test", "production"], "sandbox"));
      const appId = args["app-id"] || (await ask(rl, "SALT_EDGE_TEST_APP_ID", { required: true }));
      const secret = args.secret || (await ask(rl, "SALT_EDGE_TEST_SECRET", { required: true }));
      const customerId = args["customer-id"] || (await ask(rl, "SALT_EDGE_TEST_CUSTOMER_ID (optional)", { defaultValue: "" }));
      const connectionId =
        args["connection-id"] || (await ask(rl, "SALT_EDGE_TEST_CONNECTION_ID (optional)", { defaultValue: "" }));
      const connectionSecret =
        args["connection-secret"] ||
        (await ask(rl, "SALT_EDGE_TEST_CONNECTION_SECRET (optional)", { defaultValue: "" }));
      const accountId = args["account-id"] || (await ask(rl, "SALT_EDGE_TEST_ACCOUNT_ID (optional)", { defaultValue: "" }));
      return {
        title: "Salt Edge development / test credentials",
        updates: {
          SALT_EDGE_TEST_RUN_LIVE: "1",
          SALT_EDGE_TEST_ENVIRONMENT: environment,
          SALT_EDGE_TEST_APP_ID: appId,
          SALT_EDGE_TEST_SECRET: secret,
          SALT_EDGE_TEST_CUSTOMER_ID: customerId,
          SALT_EDGE_TEST_CONNECTION_ID: connectionId,
          SALT_EDGE_TEST_CONNECTION_SECRET: connectionSecret,
          SALT_EDGE_TEST_ACCOUNT_ID: accountId
        }
      };
    }
    case "HOME_VALUES":
      return {
        title: "Home Values provider note",
        updates: {}
      };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve(args.file || ".env");
  ensureEnvFile(envPath);
  const { parsed } = parseExistingEnv(envPath);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const provider =
      args.provider && providerChoices.includes(args.provider) ? args.provider : await promptProvider(rl);
    const { title, updates } = await buildProviderUpdates(provider, rl, args);

    if (provider === "HOME_VALUES") {
      console.log(`No provider-specific .env keys are needed for ${provider}.`);
      console.log("Use the app UI to set property URLs and fetch methods.");
      console.log(`Existing .env left in place at ${envPath}.`);
      return;
    }

    applyEnvUpdates(envPath, title, updates);

    console.log(`Updated ${envPath}`);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Start the app with `npm run dev` or `npm run dev:live-sandbox`.");
    console.log("  2. Use the generated values for this repo's development flow, live sandbox, or live integration tests.");
    console.log("  3. Open the provider page in the UI and confirm the provider settings loaded.");
    if (provider === "PLAID") {
      console.log("  4. Use Plaid sandbox test credentials like `user_good` / `pass_good` in Link.");
    }
    if (provider === "STRIPE") {
      console.log("  4. `npm run dev:live-sandbox` will seed Provider Settings > Stripe from these STRIPE_TEST_* values.");
    }
    if (provider === "SIMPLEFIN") {
      console.log("  4. Your `.env` now stores the claimed access key, not the one-time setup token.");
    }
    if (provider === "TELLER" && updates.TELLER_TEST_ENV !== "sandbox") {
      console.log("  4. Make sure the certificate and key file paths are readable from this machine.");
    }
    if (provider === "SALT_EDGE") {
      console.log("  4. If you only entered app credentials, you can still create a connect session from the UI.");
    }

    if (parsed.ADMIN_PASSWORD === "change-me" || parsed.SESSION_SECRET === "replace-with-long-random-secret-at-least-32") {
      console.log("");
      console.log("Warning: your base app secrets still look like defaults. Update ADMIN_PASSWORD and SESSION_SECRET if needed.");
    }
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
