import fs from "node:fs/promises";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import type { ConnectionReauthSessionDto, ProviderConnectResult, TellerConnectConfigDto } from "@actual-sync/shared";
import { prisma } from "../db.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { parseLinkConfig } from "./link-config.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { buildProviderCategoryNames } from "./category-matching.js";
import { providerFixtureCache } from './provider-fixture-cache.js';
import type { ProviderFixtureCache } from './provider-fixture-cache.js';
import { createProviderSettingsService } from './provider-settings-service.js';
import type { ProviderSettingsService } from './provider-settings-service.js';
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { buildImportedTransactionNotes, sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { clearSyncHealth, ProviderOperationError, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

const TELLER_API_BASE_URL = "https://api.teller.io";
const TELLER_TRANSACTION_PAGE_SIZE = 500;

export type TellerConfig = {
  appId: string;
  environment: "sandbox" | "development" | "production";
  certificateFile: string;
  keyFile: string;
  certificatePem?: string;
  keyPem?: string;
  sandboxAccessToken: string;
  transactionsInitialDays: number;
  transactionsOverlapDays: number;
  webhookSigningSecrets: string[];
  webhookToleranceSeconds: number;
}

export type TellerEnrollmentPayload = {
  accessToken: string;
  enrollmentId: string;
  userId?: string | null;
  institutionName?: string | null;
  label?: string | null;
}

type TellerApiInstitution = {
  id?: string | null;
  name?: string | null;
}

type TellerApiAccount = {
  id: string;
  enrollment_id?: string;
  institution?: TellerApiInstitution | null;
  name: string;
  type: string;
  subtype?: string | null;
  last_four?: string | null;
  status?: string;
  links?: {
    balances?: string;
  };
}

type TellerApiBalance = {
  ledger?: string | null;
  available?: string | null;
}

type TellerApiTransaction = {
  id: string;
  account_id: string;
  date: string;
  amount: string;
  description: string;
  status: "posted" | "pending";
  type: string;
  details?: {
    processing_status?: "pending" | "complete";
    category?: string | null;
    counterparty?: {
      name?: string | null;
      type?: string | null;
    } | null;
  } | null;
}

export type TellerWebhookEvent = {
  id: string;
  type: "enrollment.disconnected" | "transactions.processed" | "account.number_verification.processed" | "webhook.test";
  timestamp: string;
  payload: {
    enrollment_id?: string;
    reason?: string;
    transactions?: TellerApiTransaction[];
    account_id?: string;
    status?: string;
  };
}

type HydratedTellerAccount = {
  account: TellerApiAccount;
  balance: TellerApiBalance | null;
}

type TellerRequester = <T>({
  accessToken,
  path,
  method
}: {
  accessToken: string;
  path: string;
  method?: "GET" | "DELETE";
}) => Promise<T>;

async function buildMtlsAgent(config: TellerConfig) {
  if (config.environment === "sandbox") {
    return undefined;
  }

  if (!config.certificatePem && !config.certificateFile) {
    throw new Error("Teller mTLS certificate is not configured");
  }

  if (!config.keyPem && !config.keyFile) {
    throw new Error("Teller mTLS credentials are not configured");
  }

  const [cert, key] = await Promise.all([
    config.certificatePem ? Buffer.from(config.certificatePem, "utf8") : fs.readFile(config.certificateFile),
    config.keyPem ? Buffer.from(config.keyPem, "utf8") : fs.readFile(config.keyFile)
  ]);

  return new https.Agent({
    cert,
    key
  });
}

function createTellerRequester(getConfig: () => Promise<TellerConfig>): TellerRequester {
  let agentKey: string | null = null;
  let agentPromise: Promise<https.Agent | undefined> | null = null;

  const getAgent = async () => {
    const config = await getConfig();
    const nextKey = JSON.stringify({
      environment: config.environment,
      certificateFile: config.certificateFile,
      keyFile: config.keyFile,
      certificatePem: config.certificatePem,
      keyPem: config.keyPem
    });

    if (!agentPromise || agentKey !== nextKey) {
      agentKey = nextKey;
      agentPromise = buildMtlsAgent(config);
    }

    return {
      config,
      agent: await agentPromise
    };
  };

  return async function requestJson<T>({
    accessToken,
    path,
    method = "GET"
  }: {
    accessToken: string;
    path: string;
    method?: "GET" | "DELETE";
  }) {
    const url = new URL(path, TELLER_API_BASE_URL);
    const { agent } = await getAgent();
    const authorization = `Basic ${Buffer.from(`${accessToken}:`).toString("base64")}`;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent,
          headers: {
            Accept: "application/json",
            Authorization: authorization
          }
        },
        res => {
          const chunks: Buffer[] = [];

          res.on("data", chunk => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const payload = body ? JSON.parse(body) : null;

            if ((res.statusCode || 500) >= 400) {
              const message =
                payload && typeof payload === "object" && "error" in payload
                  ? typeof payload.error === "string"
                    ? payload.error
                    : typeof payload.error === "object" &&
                        payload.error &&
                        "message" in payload.error &&
                        typeof payload.error.message === "string"
                      ? payload.error.message
                      : `Teller request failed with status ${res.statusCode}`
                  : `Teller request failed with status ${res.statusCode}`;
              reject(new Error(message));
              return;
            }

            resolve(payload as T);
          });
        }
      );

      req.on("error", reject);
      req.end();
    });
  };
}

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDate(isoDate: string, deltaDays: number) {
  const base = new Date(`${isoDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return toIsoDate(base);
}

function getTellerCategoryNames(transaction: TellerApiTransaction) {
  const categoryNames: string[] = [];

  if (transaction.type.toLowerCase() === "transfer") {
    categoryNames.push("TRANSFER");
  }

  for (const categoryName of buildProviderCategoryNames(transaction.details?.category)) {
    if (!categoryNames.includes(categoryName)) {
      categoryNames.push(categoryName);
    }
  }

  return categoryNames;
}

function buildSyncWindow({
  lastSyncEndDate,
  today,
  initialDays,
  overlapDays
}: {
  lastSyncEndDate: string | undefined;
  today: string;
  initialDays: number;
  overlapDays: number;
}) {
  if (!lastSyncEndDate) {
    return {
      startDate: shiftIsoDate(today, -(initialDays - 1)),
      endDate: today
    };
  }

  return {
    startDate: shiftIsoDate(lastSyncEndDate, -overlapDays),
    endDate: today
  };
}

function parseConnectionMetadata(json: string | null | undefined) {
  if (!json) {
    return {};
  }

  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function classifyTellerError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown Teller error";
  const normalized = message.toLowerCase();
  if (normalized.includes("429") || normalized.includes("rate limit") || normalized.includes("too many requests")) {
    return new ProviderOperationError(message, {
      code: "RATE_LIMIT_EXCEEDED",
      healthState: "ERROR",
      healthScope: "SYNC_PIPELINE",
      healthAction: "RETRY"
    });
  }

  if (
    normalized.includes("mfa") ||
    normalized.includes("credentials") ||
    normalized.includes("user action") ||
    normalized.includes("account_locked")
  ) {
    return new ProviderOperationError(message, {
      healthState: normalized.includes("account_locked") || normalized.includes("user action")
        ? "ATTENTION_REQUIRED"
        : "REAUTH_REQUIRED",
      healthScope: "BANK_AUTH",
      healthAction: "REAUTH_BANK"
    });
  }

  if (normalized.includes("enrollment") || normalized.includes("token") || normalized.includes("authentication")) {
    return new ProviderOperationError(message, {
      healthState: "REAUTH_REQUIRED",
      healthScope: "CONNECTION_AUTH",
      healthAction: "REAUTH_CONNECTION"
    });
  }

  return new ProviderOperationError(message, {
    healthState: "ERROR",
    healthScope: "CONNECTION_AUTH",
    healthAction: "RETRY"
  });
}

function parseTellerSignatureHeader(signatureHeader: string) {
  const timestamp = signatureHeader
    .split(",")
    .map(part => part.trim())
    .find(part => part.startsWith("t="))
    ?.slice(2);
  const signatures = signatureHeader
    .split(",")
    .map(part => part.trim())
    .filter(part => part.startsWith("v1="))
    .map(part => part.slice(3))
    .filter(Boolean);

  if (!timestamp || signatures.length === 0) {
    return null;
  }

  return {
    timestamp,
    signatures
  };
}

function timingSafeHexMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

async function listTransactionsInWindow({
  request,
  accessToken,
  externalAccountId,
  startDate,
  endDate
}: {
  request: TellerRequester;
  accessToken: string;
  externalAccountId: string;
  startDate: string;
  endDate: string;
}) {
  const transactionsById = new Map<string, TellerApiTransaction>();
  let fromId: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      count: String(TELLER_TRANSACTION_PAGE_SIZE),
      start_date: startDate,
      end_date: endDate
    });
    if (fromId) {
      params.set("from_id", fromId);
    }

    const page = await request<TellerApiTransaction[]>({
      accessToken,
      path: `/accounts/${externalAccountId}/transactions?${params.toString()}`
    });

    for (const transaction of page) {
      transactionsById.set(transaction.id, transaction);
    }

    if (page.length < TELLER_TRANSACTION_PAGE_SIZE) {
      break;
    }

    fromId = page.at(-1)?.id;
    if (!fromId) {
      break;
    }
  }

  return [...transactionsById.values()].sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }

    return left.id.localeCompare(right.id);
  });
}

async function listAccountsWithBalances({
  request,
  accessToken
}: {
  request: TellerRequester;
  accessToken: string;
}) {
  const accounts = await request<TellerApiAccount[]>({
    accessToken,
    path: "/accounts"
  });

  const hydrated = await Promise.all(
    accounts.map(async account => {
      const hasBalances = Boolean(account.links?.balances);
      if (!hasBalances) {
        return {
          account,
          balance: null
        } satisfies HydratedTellerAccount;
      }

      try {
        const balance = await request<TellerApiBalance>({
          accessToken,
          path: `/accounts/${account.id}/balances`
        });
        return {
          account,
          balance
        } satisfies HydratedTellerAccount;
      } catch {
        return {
          account,
          balance: null
        } satisfies HydratedTellerAccount;
      }
    })
  );

  return hydrated;
}

async function upsertTellerConnection({
  database,
  request,
  payload,
  environment
}: {
  database: DatabaseClient;
  request: TellerRequester;
  payload: TellerEnrollmentPayload;
  environment: TellerConfig["environment"];
}) {
  const hydratedAccounts = await listAccountsWithBalances({
    request,
    accessToken: payload.accessToken
  });

  const primaryInstitution =
    hydratedAccounts[0]?.account.institution?.name || payload.institutionName || null;
  const primaryInstitutionId = hydratedAccounts[0]?.account.institution?.id || null;
  const label = payload.label || primaryInstitution || "Teller connection";
  const refreshedAt = new Date();

  const connection = await database.connection.upsert({
    where: {
      provider_providerItemId: {
        provider: "TELLER",
        providerItemId: payload.enrollmentId
      }
    },
    update: {
      label,
      status: "ACTIVE",
      institutionName: primaryInstitution,
      institutionId: primaryInstitutionId,
      accessTokenCiphertext: encryptString(payload.accessToken),
      metadataJson: JSON.stringify({
        teller: {
          environment,
          enrollmentId: payload.enrollmentId,
          userId: payload.userId || null
        },
        health: clearSyncHealth()
      }),
      lastRefreshedAt: refreshedAt
    },
    create: {
      provider: "TELLER",
      providerItemId: payload.enrollmentId,
      label,
      status: "ACTIVE",
      institutionName: primaryInstitution,
      institutionId: primaryInstitutionId,
      accessTokenCiphertext: encryptString(payload.accessToken),
      metadataJson: JSON.stringify({
        teller: {
          environment,
          enrollmentId: payload.enrollmentId,
          userId: payload.userId || null
        },
        health: clearSyncHealth()
      }),
      lastRefreshedAt: refreshedAt
    }
  });

  await database.connectionAccount.deleteMany({
    where: {
      connectionId: connection.id
    }
  });

  if (hydratedAccounts.length > 0) {
    await database.connectionAccount.createMany({
      data: hydratedAccounts.map(({ account, balance }) => ({
        connectionId: connection.id,
        externalAccountId: account.id,
        name: account.name,
        officialName: null,
        mask: account.last_four || null,
        type: account.type,
        subtype: account.subtype || null,
        currentBalance: balance?.ledger ? Number(balance.ledger) : null,
        availableBalance: balance?.available ? Number(balance.available) : null,
        rawJson: JSON.stringify(account)
      }))
    });
  }

  return connection.id;
}

export type TellerService = {
  getConnectConfig(): Promise<TellerConnectConfigDto>;
  getReauthConfig(connectionId: string): Promise<TellerConnectConfigDto & { enrollmentId: string }>;
  enrollConnection(payload: TellerEnrollmentPayload): Promise<ProviderConnectResult>;
  reuseCachedConnection(label?: string | null): Promise<ProviderConnectResult>;
  seedSandboxConnection(label?: string): Promise<ProviderConnectResult>;
  webhooksConfigured(): Promise<boolean>;
  verifyWebhookSignature(rawBody: string, signatureHeader: string | string[] | undefined): Promise<boolean>;
} & ProviderAdapter

export function createTellerService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  config = {
    appId: "",
    environment: "sandbox",
    certificateFile: "",
    keyFile: "",
    certificatePem: "",
    keyPem: "",
    sandboxAccessToken: "",
    transactionsInitialDays: 90,
    transactionsOverlapDays: 10,
    webhookSigningSecrets: [],
    webhookToleranceSeconds: 180
  } satisfies TellerConfig,
  request,
  fixtureCache = providerFixtureCache
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  config?: TellerConfig;
  request?: TellerRequester;
  fixtureCache?: ProviderFixtureCache;
} = {}): TellerService {
  const getEffectiveConfig = async (): Promise<TellerConfig> => {
    const settings = await providerSettings.get("TELLER");
    if (settings.environment === "sandbox") {
      return {
        ...config,
        appId: settings.sandbox.appId,
        environment: settings.environment,
        sandboxAccessToken: settings.sandbox.sandboxAccessToken,
        certificatePem: "",
        keyPem: "",
        webhookSigningSecrets: settings.sandbox.webhookSigningSecrets ?? [],
        transactionsInitialDays: settings.transactionsInitialDays,
        transactionsOverlapDays: settings.transactionsOverlapDays,
        webhookToleranceSeconds: settings.webhookToleranceSeconds
      };
    }

    const activeSettings = settings.environment === "development" ? settings.development : settings.production;
    return {
      ...config,
      appId: activeSettings.appId,
      environment: settings.environment,
      sandboxAccessToken: settings.sandbox.sandboxAccessToken,
      certificatePem: activeSettings.certificatePem,
      keyPem: activeSettings.keyPem,
      webhookSigningSecrets: activeSettings.webhookSigningSecrets,
      transactionsInitialDays: settings.transactionsInitialDays,
      transactionsOverlapDays: settings.transactionsOverlapDays,
      webhookToleranceSeconds: settings.webhookToleranceSeconds
    };
  };
  const requestClient = request ?? createTellerRequester(getEffectiveConfig);

  return {
    provider: "TELLER",
    isConfigured() {
      return false;
    },
    async getConnectConfig() {
      const effectiveConfig = await getEffectiveConfig();
      if (!effectiveConfig.appId) {
        throw new Error("Teller is not configured");
      }

      return {
        applicationId: effectiveConfig.appId,
        environment: effectiveConfig.environment,
        products: ["transactions", "balance"],
        selectAccount: "multiple"
      };
    },

    async disconnectConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "TELLER") {
        throw new Error("Connection is not a Teller enrollment");
      }

      try {
        await requestClient({
          accessToken: decryptString(connection.accessTokenCiphertext),
          path: "/accounts",
          method: "DELETE"
        });
      } catch (error) {
        const providerError = classifyTellerError(error);

        if (
          providerError.healthAction === "REAUTH_CONNECTION" ||
          providerError.healthAction === "REAUTH_BANK"
        ) {
          return;
        }

        throw providerError;
      }
    },

    async getReauthConfig(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      if (connection.provider !== "TELLER") {
        throw new Error("Connection is not a Teller enrollment");
      }

      if (!connection.providerItemId) {
        throw new Error("Teller enrollment is missing an enrollment id");
      }

      return {
        ...(await this.getConnectConfig()),
        enrollmentId: connection.providerItemId
      };
    },
    async createReauthSession({
      connectionId
    }: {
      connectionId: string;
      userId: string;
    }): Promise<ConnectionReauthSessionDto> {
      return {
        provider: "TELLER",
        connectionId,
        mode: "teller_repair",
        config: await this.getReauthConfig(connectionId)
      };
    },
    async webhooksConfigured() {
      const effectiveConfig = await getEffectiveConfig();
      return effectiveConfig.webhookSigningSecrets.length > 0;
    },
    async verifyWebhookSignature(rawBody: string, signatureHeader: string | string[] | undefined) {
      const effectiveConfig = await getEffectiveConfig();
      if (effectiveConfig.webhookSigningSecrets.length === 0) {
        return false;
      }

      const signatureValue = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      if (!signatureValue) {
        return false;
      }

      const parsedSignature = parseTellerSignatureHeader(signatureValue);
      if (!parsedSignature) {
        return false;
      }

      const timestampSeconds = Number(parsedSignature.timestamp);
      if (!Number.isFinite(timestampSeconds)) {
        return false;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - timestampSeconds) > effectiveConfig.webhookToleranceSeconds) {
        return false;
      }

      const signedMessage = `${parsedSignature.timestamp}.${rawBody}`;

      return effectiveConfig.webhookSigningSecrets.some(secret => {
        const expectedSignature = crypto.createHmac("sha256", secret).update(signedMessage).digest("hex");
        return parsedSignature.signatures.some(signature => timingSafeHexMatch(signature, expectedSignature));
      });
    },
    async enrollConnection(payload: TellerEnrollmentPayload) {
      const effectiveConfig = await getEffectiveConfig();
      if (!effectiveConfig.appId) {
        throw new Error("Teller is not configured");
      }

      if (!payload.accessToken || !payload.enrollmentId) {
        throw new Error("Teller enrollment payload is incomplete");
      }

      const connectionId = await upsertTellerConnection({
        database,
        request: requestClient,
        payload,
        environment: effectiveConfig.environment
      });
      await fixtureCache.setTeller({
        accessToken: payload.accessToken,
        enrollmentId: payload.enrollmentId,
        userId: payload.userId ?? null,
        institutionName: payload.institutionName ?? null,
        updatedAt: new Date().toISOString()
      });
      return {
        connectionId
      };
    },
    async reuseCachedConnection(label) {
      if (!fixtureCache.isEnabled()) {
        throw new Error("Provider fixture cache is not enabled.");
      }

      const cached = await fixtureCache.getTeller();
      if (!cached?.accessToken || !cached.enrollmentId) {
        throw new Error("No cached Teller fixture is available yet.");
      }

      try {
        const connectionId = await upsertTellerConnection({
          database,
          request: requestClient,
          payload: {
            accessToken: cached.accessToken,
            enrollmentId: cached.enrollmentId,
            userId: cached.userId ?? null,
            institutionName: cached.institutionName ?? null,
            ...stripUndefined({
              label
            })
          },
          environment: (await getEffectiveConfig()).environment
        });
        return {
          connectionId
        };
      } catch (error) {
        const providerError = classifyTellerError(error);
        if (providerError.healthScope === "CONNECTION_AUTH") {
          await fixtureCache.clearTeller();
        }
        throw providerError;
      }
    },
    async seedSandboxConnection(label) {
      const effectiveConfig = await getEffectiveConfig();
      if (effectiveConfig.environment !== "sandbox") {
        throw new Error("Teller sandbox helpers are only available in the sandbox environment");
      }

      const accessToken = effectiveConfig.sandboxAccessToken.trim();
      if (!accessToken) {
        throw new Error("Teller sandbox access token is required to seed a sandbox connection");
      }
      const accounts = await listAccountsWithBalances({
        request: requestClient,
        accessToken
      });
      const enrollmentId = accounts[0]?.account.enrollment_id;
      if (!enrollmentId) {
        throw new Error("Unable to derive Teller sandbox enrollment id");
      }

      const connectionId = await upsertTellerConnection({
        database,
        request: requestClient,
        payload: {
          accessToken,
          enrollmentId,
          institutionName: accounts[0]?.account.institution?.name || "Security Credit Union",
          label: label || `Teller Sandbox ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        },
        environment: effectiveConfig.environment
      });
      await fixtureCache.setTeller({
        accessToken,
        enrollmentId,
        institutionName: accounts[0]?.account.institution?.name || "Security Credit Union",
        userId: null,
        updatedAt: new Date().toISOString()
      });
      return {
        connectionId
      };
    },
    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        }
      });

      const metadata =
        parseConnectionMetadata(connection.metadataJson) as { teller?: { enrollmentId?: string | null } };

      try {
        await upsertTellerConnection({
          database,
          request: requestClient,
          payload: {
            accessToken: decryptString(connection.accessTokenCiphertext),
            enrollmentId: connection.providerItemId || metadata.teller?.enrollmentId || connection.id,
            institutionName: connection.institutionName,
            label: connection.label
          },
          environment: (await getEffectiveConfig()).environment
        });
      } catch (error) {
        const health = toSyncHealth(classifyTellerError(error));
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health
            })
          }
        });
        throw classifyTellerError(error);
      }
    },
    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const effectiveConfig = await getEffectiveConfig();
      const link = await database.accountLink.findUniqueOrThrow({
        where: {
          id: linkId
        },
        include: {
          connection: true,
          connectionAccount: true
        }
      });

      if (!link.connection || !link.connectionAccount) {
        throw new Error("Teller link is missing connection details");
      }

      try {
        const accessToken = decryptString(link.connection.accessTokenCiphertext);
        const configState = parseLinkConfig(link.configJson);
        const today = toIsoDate(new Date());
        const { startDate, endDate } = buildSyncWindow({
          lastSyncEndDate: configState.providerSyncState?.windowEndDate ?? undefined,
          today,
          initialDays: effectiveConfig.transactionsInitialDays,
          overlapDays: effectiveConfig.transactionsOverlapDays
        });
        const tellerTransactions = await listTransactionsInWindow({
          request: requestClient,
          accessToken,
          externalAccountId: link.connectionAccount.externalAccountId,
          startDate,
          endDate
        });

        const metadata = parseConnectionMetadata(link.connection.metadataJson);
        await database.connection.update({
          where: {
            id: link.connection.id
          },
          data: {
            status: "ACTIVE",
            lastRefreshedAt: new Date(),
            metadataJson: JSON.stringify({
              ...metadata,
              health: clearSyncHealth()
            })
          }
        });

        return sanitizeProviderSyncResult({
          imported: tellerTransactions.length,
          transactions: tellerTransactions.map(transaction => {
            const counterpartyName = transaction.details?.counterparty?.name?.trim() || undefined;
            const description = transaction.description?.trim() || transaction.type;

          return {
              ...stripUndefined({
                date: transaction.date,
                amount: Number(transaction.amount),
                payeeName: counterpartyName || description,
                importedPayee: description,
                notes: buildImportedTransactionNotes({
                  payeeName: counterpartyName || description,
                  description
                }),
                importedId: transaction.id,
                cleared: transaction.status === "posted",
                categoryNames: getTellerCategoryNames(transaction),
                searchText: [description, counterpartyName, transaction.type].filter(
                  (value): value is string => Boolean(value)
                )
              })
            };
          }),
          removedImportedIds: [],
          configPatch: {
            providerSyncState: {
              cursor: null,
              windowStartDate: startDate,
              windowEndDate: endDate
            }
          }
        });
      } catch (error) {
        const metadata = parseConnectionMetadata(link.connection.metadataJson);
        const health = toSyncHealth(classifyTellerError(error));
        await database.connection.update({
          where: {
            id: link.connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health
            })
          }
        });
        throw classifyTellerError(error);
      }
    }
  };
}

export const tellerService = createTellerService();
