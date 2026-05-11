import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test/test-db.js";
import { createMonoService } from "./mono-service.js";

const monoTestEnvironment = process.env.MONO_TEST_ENV === "production" ? "production" : "sandbox";
const liveEnabled =
  process.env.MONO_TEST_RUN_LIVE === "1" &&
  monoTestEnvironment === "sandbox" &&
  Boolean(process.env.MONO_TEST_SECRET_KEY);

type MonoEnvelope<T> = {
  status?: string;
  message?: string;
  responseCode?: number;
  data?: T;
};

type MonoInstitution = {
  _id?: string;
  auth_methods?: Array<{
    type?: string;
    ui?: {
      form?: Array<{
        name?: string;
      }>;
    };
  }>;
};

type MonoConnectSession = {
  session?: {
    id?: string;
  };
};

type MonoSandboxCredentials = {
  credentials?: Array<{
    hasMultipleAccounts?: boolean;
    values?: Record<string, string>;
  }>;
};

type MonoLoginData = {
  code?: string;
  accounts?: Array<{
    accountNumber?: string;
  }>;
  userInput?: {
    form?: Array<{
      name?: string;
    }>;
  };
};

type MonoAccountDetails = {
  account?: {
    id?: string;
  };
  meta?: {
    data_status?: string;
  };
};

function sleep(delayMs: number) {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

async function monoRequest<T>({
  path,
  method = "GET",
  body,
  sessionId
}: {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  sessionId?: string;
}) {
  const response = await fetch(`https://api.withmono.com${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      "mono-sec-key": process.env.MONO_TEST_SECRET_KEY || "",
      ...(sessionId ? { "x-session-id": sessionId } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const payloadText = await response.text();
  let payload: MonoEnvelope<T> = {};

  if (payloadText) {
    const parsed: unknown = JSON.parse(payloadText);
    payload = typeof parsed === "object" && parsed !== null ? (parsed as MonoEnvelope<T>) : {};
  }

  if (!response.ok || payload.status === "failed") {
    throw new Error(
      `Mono sandbox request failed for ${method} ${path}: ${response.status} ${payload.message || payloadText || "Unknown error"}`
    );
  }

  return payload;
}

async function getSandboxInstitution() {
  const payload = await monoRequest<MonoInstitution[]>({
    path: "/v3/institutions?scope=financial_data"
  });

  const institutions = Array.isArray(payload.data) ? payload.data : [];
  const requestedInstitutionId = process.env.MONO_TEST_INSTITUTION_ID || "";
  const requestedAuthMethod = process.env.MONO_TEST_AUTH_METHOD || "";

  const institution =
    (requestedInstitutionId
      ? institutions.find(candidate => candidate._id === requestedInstitutionId)
      : undefined) ??
    institutions.find(candidate =>
      (candidate.auth_methods ?? []).some(method => {
        if (requestedAuthMethod && method.type !== requestedAuthMethod) {
          return false;
        }

        const fieldNames = (method.ui?.form ?? []).map(field => field.name?.toLowerCase() || "");
        return fieldNames.includes("username") && fieldNames.includes("password");
      })
    );

  if (!institution?._id) {
    throw new Error("No compatible Mono sandbox institution was found for the current test settings.");
  }

  const authMethod =
    (requestedAuthMethod
      ? institution.auth_methods?.find(candidate => candidate.type === requestedAuthMethod)
      : undefined) ??
    institution.auth_methods?.find(candidate => {
      const fieldNames = (candidate.ui?.form ?? []).map(field => field.name?.toLowerCase() || "");
      return fieldNames.includes("username") && fieldNames.includes("password");
    });

  if (!authMethod?.type) {
    throw new Error(`No compatible Mono auth method was found for institution ${institution._id}.`);
  }

  return {
    institutionId: institution._id,
    authMethod: authMethod.type
  };
}

function buildCommitPayload({
  loginData
}: {
  loginData: MonoLoginData | undefined;
}) {
  const payload: Record<string, string> = {};
  const accountNumber = loginData?.accounts?.[0]?.accountNumber;

  if (accountNumber) {
    payload.accountNumber = accountNumber;
  }

  for (const field of loginData?.userInput?.form ?? []) {
    const fieldName = field.name?.trim();
    if (!fieldName) {
      continue;
    }

    const envKey = `MONO_TEST_${fieldName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
    const envValue = process.env[envKey]?.trim();
    if (envValue) {
      payload[fieldName] = envValue;
      continue;
    }

    if (fieldName.toLowerCase().includes("otp")) {
      payload[fieldName] = "123456";
      continue;
    }

    if (fieldName.toLowerCase().includes("answer")) {
      payload[fieldName] = "dog";
      continue;
    }

    throw new Error(`Mono sandbox requires additional input "${fieldName}". Set ${envKey} to continue this live test.`);
  }

  return payload;
}

async function createSandboxCode() {
  const { institutionId, authMethod } = await getSandboxInstitution();
  const sessionPayload = await monoRequest<MonoConnectSession>({
    path: "/v2/connect/session",
    method: "POST",
    body: {
      institution: institutionId,
      auth_method: authMethod,
      scope: "financial_data",
      customer: {
        name: "Codex Mono Sandbox",
        email: "codex-mono-sandbox@example.com"
      }
    }
  });

  const sessionId = sessionPayload.data?.session?.id;
  if (!sessionId) {
    throw new Error("Mono sandbox session creation did not return a session id.");
  }

  const sandboxPayload = await monoRequest<MonoSandboxCredentials>({
    path: "/v2/connect/sandbox",
    sessionId
  });
  const credentials =
    sandboxPayload.data?.credentials?.find(candidate => candidate.hasMultipleAccounts === false) ??
    sandboxPayload.data?.credentials?.[0];
  const loginValues = credentials?.values;

  if (!loginValues || !loginValues.username || !loginValues.password) {
    throw new Error("Mono sandbox did not return usable username/password credentials.");
  }

  const loginPayload = await monoRequest<MonoLoginData>({
    path: "/v2/connect/login",
    method: "POST",
    sessionId,
    body: loginValues
  });

  if (loginPayload.responseCode === 99 && loginPayload.data?.code) {
    return loginPayload.data.code;
  }

  if (loginPayload.responseCode === 101 || loginPayload.responseCode === 102) {
    const commitPayload = buildCommitPayload({
      loginData: loginPayload.data
    });
    const commitResponse = await monoRequest<MonoLoginData>({
      path: "/v2/connect/commit",
      method: "POST",
      sessionId,
      body: commitPayload
    });

    if (commitResponse.responseCode === 99 && commitResponse.data?.code) {
      return commitResponse.data.code;
    }
  }

  throw new Error(
    `Mono sandbox login did not complete. responseCode=${String(loginPayload.responseCode)} message=${loginPayload.message || ""}`.trim()
  );
}

async function waitForAccountDataReady(accountId: string) {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const detailsPayload = await monoRequest<MonoAccountDetails>({
      path: `/v2/accounts/${accountId}`
    });

    const dataStatus = detailsPayload.data?.meta?.data_status?.toUpperCase() || "";
    if (dataStatus === "AVAILABLE") {
      return;
    }

    await sleep(2_000);
  }

  throw new Error(`Mono sandbox account ${accountId} did not reach AVAILABLE data status within 120 seconds.`);
}

describe.skipIf(!liveEnabled)("mono service live sandbox", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it("creates, refreshes, and syncs a live Mono sandbox connection", async () => {
    const { prisma, cleanup } = await createTestDatabase();
    cleanups.push(cleanup);

    const service = createMonoService({
      prisma,
      providerSettings: {
        get: async () => ({
          environment: monoTestEnvironment,
          sandbox: {
            publicKey: process.env.MONO_TEST_PUBLIC_KEY || "",
            secretKey: process.env.MONO_TEST_SECRET_KEY || "",
            webhookSecret: process.env.MONO_TEST_WEBHOOK_SECRET || ""
          },
          production: {
            publicKey: "",
            secretKey: "",
            webhookSecret: ""
          },
          transactionsInitialDays: 90,
          transactionsOverlapDays: 10,
          automaticSyncConcurrency: 1
        })
      } as never
    });

    const code = await createSandboxCode();
    const result = await service.exchangeCode({
      code,
      label: "Live Mono sandbox"
    });
    const exchangedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: result.connectionId
      }
    });

    expect(exchangedConnection.provider).toBe("MONO");
    expect(exchangedConnection.providerItemId).toBeTruthy();

    await waitForAccountDataReady(exchangedConnection.providerItemId || "");
    await service.refreshConnection(exchangedConnection.id);

    const refreshedConnection = await prisma.connection.findUniqueOrThrow({
      where: {
        id: exchangedConnection.id
      },
      include: {
        accounts: true
      }
    });
    expect(refreshedConnection.accounts.length).toBeGreaterThan(0);

    const preferredExternalAccountId = process.env.MONO_TEST_ACCOUNT_ID || "";
    const account =
      (preferredExternalAccountId
        ? refreshedConnection.accounts.find(candidate => candidate.externalAccountId === preferredExternalAccountId)
        : undefined) ?? refreshedConnection.accounts[0];
    expect(account).toBeTruthy();

    const link = await prisma.accountLink.create({
      data: {
        actualAccountId: "actual-live-mono-1",
        actualAccountName: "Mono Live Account",
        assetType: "BANK",
        provider: "MONO",
        connectionId: refreshedConnection.id,
        connectionAccountId: account!.id,
        syncFrequency: "MANUAL",
        isEnabled: true
      }
    });

    const syncResult = await service.syncAccountLink(link.id);

    expect(syncResult.imported).toBe(syncResult.transactions.length);
    expect(syncResult.transactions.every(transaction => Boolean(transaction.importedId))).toBe(true);
  }, 180_000);
});
