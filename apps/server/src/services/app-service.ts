import type {
  ActualAccountDto,
  ActualAccountsResponseDto,
  ActualBankSyncStatus,
  ActualBankSyncLinkDto,
  ActualCategoryDto,
  CommitMigrationPayload,
  ConnectionReauthSessionDto,
  ConnectionAccountOptionDto,
  ConnectionDto,
  MigrationPreviewDto,
  Provider,
  RuntimeInfoDto,
  SyncRunDto,
  UpsertHomeValueConnectionPayload,
  UpsertVehicleValueConnectionPayload,
  UpdateAccountLinkPayload,
  WriteMode
} from "@actual-sync/shared";
import {
  getActivePlaidEnvironmentSettings,
  getActiveStripeEnvironmentSettings,
  getActiveSimpleFinModeSettings,
  getActiveTellerEnvironmentSettings
} from "@actual-sync/shared";
import type { Prisma, Provider as PrismaProvider } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encryptString } from "../lib/crypto.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { actualService } from "./actual-service.js";
import type {
  ActualExternalSyncAccountRecord,
  ActualExternalSyncMetadataInput,
  ReconcileTransactionInput
} from "./actual-service.js";
import { getStripeMetadata, getTellerMetadata, parseConnectionMetadata } from "./connection-metadata.js";
import { learnCategoryMappingsFromHistory, pruneImportedTransactionLedger } from "./imported-transaction-ledger.js";
import { getNextAccountLinkDueAt } from "./account-link-schedule.js";
import { CURRENT_LINK_STATUSES, linkIdentityChanged, parseLinkConfig, selectCurrentLink, serializeLinkConfig, toLinkDto } from "./link-config.js";
import type { LinkConfigData } from "./link-config.js";
import { plaidService } from "./plaid-service.js";
import type { PlaidService, PlaidWebhookEvent } from "./plaid-service.js";
import {
  applyWriteModeToProviderSyncResult,
  buildSnapshotDeltaTransaction,
  DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS,
  getPrimarySourceCategory,
  normalizeActualExternalSyncPrefs,
  resolveEffectiveWriteMode,
  resolveTransactionCategoryId,
  resolveTransferActualAccountId,
  writeModeUsesSnapshotDelta,
  toImportTransactionInput
} from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import { parseSimpleFinAccountRawJson } from "./simplefin-native-metadata.js";
import { simplefinService } from "./simplefin-service.js";
import type { SimpleFinService } from "./simplefin-service.js";
import { stripeService } from "./stripe-service.js";
import type { StripeService } from "./stripe-service.js";
import { createSyncReviewService } from "./sync-review-service.js";
import { tellerService } from "./teller-service.js";
import type { TellerService, TellerWebhookEvent } from "./teller-service.js";
import type { ProviderAdapter, ProviderSyncOutcome, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { clearSyncHealth, isBlockingSyncHealth, isRateLimitedSyncError, toSyncHealth } from "./sync-health.js";
import { homeValuesService } from "./home-values-service.js";
import type { HomeValuesService } from "./home-values-service.js";
import { vehicleValuesService } from "./vehicle-values-service.js";
import type { VehicleValuesService } from "./vehicle-values-service.js";
import type Stripe from "stripe";

type DatabaseClient = typeof prisma;
type ActualService = typeof actualService;
type AutomaticSyncConcurrencyConfig = Record<Provider, number>;
type ProviderBackgroundSyncGate = {
  limit: number;
  run: ReturnType<typeof createConcurrencyGate>;
};
type SiblingLink = Prisma.AccountLinkGetPayload<{
  include: {
    connectionAccount: true;
  };
}>;
type SyncableLink = Prisma.AccountLinkGetPayload<{
  include: {
    connection: true;
    connectionAccount: true;
  };
}>;
type AppliedSyncOutcome = {
  newTransactions: string[];
  matchedTransactions: string[];
  updatedAccounts: string[];
  summary: string;
  lastSync: string;
};
type InternalActualExternalSyncStatus = {
  configured: boolean;
  state: "ok" | "syncing" | "error" | "reauth_required" | "not_configured";
  message?: string | null;
  lastSync?: string | null;
  canSync: boolean;
  needsReauth: boolean;
};
type ExistingExternalSyncMetadata = Pick<
  ActualExternalSyncAccountRecord,
  | "linked"
  | "syncSource"
  | "providerAccountId"
  | "institutionName"
  | "institutionExternalId"
  | "mask"
  | "officialName"
  | "balanceCurrent"
  | "balanceAvailable"
  | "balanceLimit"
  | "lastSync"
>;

const currentLinkOrderBy = [
  {
    status: "asc"
  },
  {
    updatedAt: "desc"
  },
  {
    createdAt: "desc"
  }
] satisfies Prisma.AccountLinkOrderByWithRelationInput[];

const currentLinkInclude = {
  connection: true,
  connectionAccount: true
} satisfies Prisma.AccountLinkInclude;
const IMPORTED_TRANSACTION_LEDGER_WRITE_CONCURRENCY = 25;

function createConcurrencyGate(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function runWithGate<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>(resolve => {
        queue.push(resolve);
      });
    }

    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function getPlaidMetadata(metadata: Record<string, unknown>) {
  return typeof metadata.plaid === "object" && metadata.plaid ? (metadata.plaid as Record<string, unknown>) : {};
}

function toPrismaProvider(provider: Provider | null | undefined): PrismaProvider | null {
  return provider == null ? null : (provider as PrismaProvider);
}

function toActualLastSyncValue(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return String(value.getTime());
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}

function toActualAmountInteger(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 100);
}

function getDateRangeBounds(dates: string[]) {
  if (dates.length === 0) {
    return null;
  }

  const sorted = [...dates].sort((left, right) => left.localeCompare(right));
  return {
    startDate: sorted[0]!,
    endDate: sorted[sorted.length - 1]!
  };
}

function groupLinksByActualAccountId<T extends { actualAccountId: string }>(links: T[]) {
  const linksByActualId = new Map<string, T[]>();

  for (const link of links) {
    const group = linksByActualId.get(link.actualAccountId) || [];
    group.push(link);
    linksByActualId.set(link.actualAccountId, group);
  }

  return linksByActualId;
}

function isValuationProvider(provider: Provider | null | undefined): provider is "HOME_VALUES" | "VEHICLE_VALUES" {
  return provider === "HOME_VALUES" || provider === "VEHICLE_VALUES";
}

function getValuationAssetType(provider: "HOME_VALUES" | "VEHICLE_VALUES") {
  return provider === "HOME_VALUES" ? "PROPERTY" : "OTHER_ASSET";
}

export type AppService = {
  getRuntimeInfo(): Promise<RuntimeInfoDto>;
  listConnections(): Promise<ConnectionDto[]>;
  listActualAccounts(): Promise<ActualAccountsResponseDto>;
  listActualBankSyncLinks(): Promise<ActualBankSyncLinkDto[]>;
  importExistingSimpleFinLinks(connectionId: string): Promise<{
    imported: number;
    updated: number;
    skipped: number;
    unmatched: number;
  }>;
  createConnectionReauthSession(connectionId: string, userId: string): Promise<ConnectionReauthSessionDto>;
  createHomeValueConnection(payload: UpsertHomeValueConnectionPayload): Promise<{ connectionId: string }>;
  updateHomeValueConnection(connectionId: string, payload: UpsertHomeValueConnectionPayload): Promise<{ connectionId: string }>;
  createVehicleValueConnection(payload: UpsertVehicleValueConnectionPayload): Promise<{ connectionId: string }>;
  updateVehicleValueConnection(connectionId: string, payload: UpsertVehicleValueConnectionPayload): Promise<{ connectionId: string }>;
  disconnectConnection(connectionId: string): Promise<void>;
  refreshConnection(connectionId: string): Promise<void>;
  refreshAllConnections(): Promise<void>;
  upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload): Promise<unknown>;
  listRequestedExternalSyncAccountIds(): Promise<string[]>;
  runRequestedExternalSync(actualAccountId: string): Promise<void>;
  runRequestedExternalSyncs(): Promise<string[]>;
  runAccountSync(actualAccountId: string): Promise<AppliedSyncOutcome | void>;
  runScheduledLinkSyncs(linkIds: string[]): Promise<void>;
  handlePlaidWebhook(event: PlaidWebhookEvent): Promise<void>;
  handleTellerWebhook(event: TellerWebhookEvent): Promise<void>;
  handleStripeWebhook(event: Stripe.Event): Promise<void>;
  previewAccountSyncReview(actualAccountId: string): Promise<MigrationPreviewDto>;
  commitAccountSyncReview(actualAccountId: string, payload: CommitMigrationPayload): Promise<void>;
  listSyncRuns(limit?: number): Promise<SyncRunDto[]>;
}

export function createAppService({
  prisma: database = prisma,
  actualService: actual = actualService,
  homeValuesService: homeValues = homeValuesService,
  vehicleValuesService: vehicleValues = vehicleValuesService,
  plaidService: plaid = plaidService,
  providerSettingsService: settings = createProviderSettingsService({ prisma: database }),
  simplefinService: simplefin = simplefinService,
  stripeService: stripe = stripeService,
  tellerService: teller = tellerService,
  runtime = {
    instanceLabel: env.APP_INSTANCE_LABEL,
    liveSandboxMode: env.liveSandboxMode,
    actualServerUrl: env.ACTUAL_SERVER_URL,
    actualBudgetSyncIdConfigured: Boolean(env.ACTUAL_BUDGET_SYNC_ID),
    automaticSyncBackoffBaseMinutes: env.AUTOMATIC_SYNC_BACKOFF_BASE_MINUTES,
    automaticSyncBackoffMaxMinutes: env.AUTOMATIC_SYNC_BACKOFF_MAX_MINUTES
  },
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  actualService?: ActualService;
  homeValuesService?: HomeValuesService;
  vehicleValuesService?: VehicleValuesService;
  plaidService?: PlaidService;
  providerSettingsService?: ProviderSettingsService;
  simplefinService?: SimpleFinService;
  stripeService?: StripeService;
  tellerService?: TellerService;
  runtime?: {
    instanceLabel: string;
    liveSandboxMode: boolean;
    actualServerUrl: string;
    actualBudgetSyncIdConfigured: boolean;
    automaticSyncBackoffBaseMinutes: number;
    automaticSyncBackoffMaxMinutes: number;
  };
  now?: () => Date;
} = {}): AppService {
  const providerAdapters = {
    HOME_VALUES: homeValues,
    PLAID: plaid,
    SIMPLEFIN: simplefin,
    STRIPE: stripe,
    TELLER: teller,
    VEHICLE_VALUES: vehicleValues
  } satisfies Record<Provider, ProviderAdapter>;
  const providerBackgroundSyncGates = new Map<Provider, ProviderBackgroundSyncGate>();
  const activePlaidWebhookSyncs = new Map<string, { pending: boolean }>();
  const runImportedTransactionLedgerWrite = createConcurrencyGate(IMPORTED_TRANSACTION_LEDGER_WRITE_CONCURRENCY);
  const getEffectiveProviderSettings = () => settings.getAll();
  let actualCapabilitiesPromise: Promise<{
    externalSyncWritebackEnabled: boolean;
    externalSyncMode: "none" | "dedicated-api" | "account-api";
    externalSyncStatusEnabled: boolean;
  }> | null = null;

  const normalizeActualCapabilities = (
    capabilities?: Partial<Awaited<NonNullable<typeof actualCapabilitiesPromise>>>
  ) => {
    const externalSyncStatusEnabled =
      capabilities?.externalSyncStatusEnabled ?? typeof actual.updateExternalSyncAccountStatus === "function";
    const externalSyncWritebackEnabled =
      capabilities?.externalSyncWritebackEnabled ??
      (externalSyncStatusEnabled ||
        (typeof actual.linkExternalSyncAccount === "function" &&
          typeof actual.getExternalSyncAccount === "function" &&
          typeof actual.unlinkExternalSyncAccount === "function"));
    const externalSyncMode =
      capabilities?.externalSyncMode ??
      (externalSyncStatusEnabled ? "account-api" : externalSyncWritebackEnabled ? "dedicated-api" : "none");

    return {
      externalSyncWritebackEnabled,
      externalSyncMode,
      externalSyncStatusEnabled
    } as const;
  };

  const getActualCapabilities = () => {
    if (!actualCapabilitiesPromise) {
      actualCapabilitiesPromise = (async () => {
        if (typeof actual.getCapabilities === "function") {
          return normalizeActualCapabilities(await actual.getCapabilities());
        }

        return normalizeActualCapabilities();
      })();
    }

    return actualCapabilitiesPromise;
  };

  const getProviderAdapter = (provider: Provider | null | undefined) => {
    if (!provider) {
      return null;
    }

    return providerAdapters[provider];
  };

  const getActualExternalSyncPrefs = async (actualAccountId: string) => {
    if (typeof actual.getExternalSyncAccount !== "function") {
      return DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS;
    }

    return (await actual.getExternalSyncAccount(actualAccountId)).prefs;
  };

  const listTrackedCurrentActualExternalLinks = async (actualAccountIds?: string[]) => {
    const links = await database.accountLink.findMany({
      where: {
        status: {
          in: [...CURRENT_LINK_STATUSES]
        },
        ...(actualAccountIds
          ? {
              actualAccountId: {
                in: actualAccountIds
              }
            }
          : {})
      },
      orderBy: currentLinkOrderBy
    });

    return [...groupLinksByActualAccountId(links).values()]
      .map(group => selectCurrentLink(group))
      .filter((link): link is NonNullable<typeof link> => Boolean(link))
      .filter(link => parseLinkConfig(link.configJson).actualExternalLinked === true);
  };

  const isProviderConfigured = async (provider: Provider) => {
    const providerSettings = await getEffectiveProviderSettings();

    if (isValuationProvider(provider)) {
      return true;
    }

    if (provider === "PLAID") {
      const activePlaidSettings = getActivePlaidEnvironmentSettings(providerSettings.PLAID);
      return Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
    }

    if (provider === "TELLER") {
      return Boolean(getActiveTellerEnvironmentSettings(providerSettings.TELLER).appId);
    }

    if (provider === "STRIPE") {
      const activeStripeSettings = getActiveStripeEnvironmentSettings(providerSettings.STRIPE);
      return Boolean(activeStripeSettings.publishableKey.trim() && activeStripeSettings.secretKey);
    }

    return true;
  };

  const getProviderRuntimeInfo = async (
    providerSettings?: Awaited<ReturnType<typeof getEffectiveProviderSettings>>
  ): Promise<RuntimeInfoDto["providers"]> => {
    const effectiveProviderSettings = providerSettings ?? (await getEffectiveProviderSettings());
    const plaidEnvironment = effectiveProviderSettings.PLAID.environment;
    const activePlaidSettings = getActivePlaidEnvironmentSettings(effectiveProviderSettings.PLAID);
    const plaidEnabled = Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
    const plaidSandboxToolsEnabled = plaidEnvironment === "sandbox";
    const stripeEnvironment = effectiveProviderSettings.STRIPE.environment;
    const activeStripeSettings = getActiveStripeEnvironmentSettings(effectiveProviderSettings.STRIPE);
    const stripePublishableKeyConfigured = Boolean(activeStripeSettings.publishableKey.trim());
    const stripeSecretKeyConfigured = Boolean(activeStripeSettings.secretKey);
    const stripeEnabled = stripePublishableKeyConfigured && stripeSecretKeyConfigured;
    const activeTellerSettings = getActiveTellerEnvironmentSettings(effectiveProviderSettings.TELLER);
    const tellerEnabled = Boolean(activeTellerSettings.appId);
    const tellerEnvironment = effectiveProviderSettings.TELLER.environment;
    const tellerMtlsConfigured =
      tellerEnvironment === "sandbox" ||
      Boolean(
        ("certificatePem" in activeTellerSettings ? activeTellerSettings.certificatePem : "") &&
          ("keyPem" in activeTellerSettings ? activeTellerSettings.keyPem : "")
      );
    const simpleFinMode = effectiveProviderSettings.SIMPLEFIN.mode;
    const simpleFinDevelopmentConfigured =
      simpleFinMode !== "development" ||
      Boolean(getActiveSimpleFinModeSettings(effectiveProviderSettings.SIMPLEFIN)?.serverUrl);

    return [
      {
        provider: "HOME_VALUES",
        label: "Home Values",
        enabled: true,
        ready: true,
        environment: null,
        issues: [],
        notes: [
          "Use property URLs from Redfin, Movoto, Homes.com, or Trulia to keep an off-budget asset account current with weekly spaced refreshes."
        ]
      },
      {
        provider: "VEHICLE_VALUES",
        label: "Vehicle Values",
        enabled: true,
        ready: true,
        environment: null,
        issues: [],
        notes: [
          "Store manual valuation snapshots for vehicles and sync them into Actual as off-budget other-asset balances."
        ]
      },
      {
        provider: "PLAID",
        label: "Plaid",
        enabled: plaidEnabled,
        ready: plaidEnabled,
        environment: plaidEnvironment,
        issues: plaidEnabled ? [] : ["Enter a Plaid client ID and secret to enable Plaid connections."],
        notes: plaidSandboxToolsEnabled
          ? ["Sandbox tools are enabled for creating fixture Items and transactions."]
          : []
      },
      {
        provider: "STRIPE",
        label: "Stripe",
        enabled: stripeEnabled,
        ready: stripeEnabled,
        environment: stripeEnvironment,
        issues: [
          ...(stripePublishableKeyConfigured ? [] : ["Enter a Stripe publishable key to launch Financial Connections."]),
          ...(stripeSecretKeyConfigured ? [] : ["Enter a Stripe secret key to create sessions and sync account data."])
        ],
        notes: [
          "Financial Connections supports US bank accounts, and live transactions access requires Stripe Financial Connections registration."
        ]
      },
      {
        provider: "TELLER",
        label: "Teller.io",
        enabled: tellerEnabled,
        ready: tellerEnabled && tellerMtlsConfigured,
        environment: tellerEnvironment,
        issues: [
          ...(tellerEnabled ? [] : ["Enter a Teller application ID to enable Teller Connect."]),
          ...(tellerEnabled && tellerEnvironment !== "sandbox" && !tellerMtlsConfigured
            ? ["Enter Teller client certificate and key PEM values to enable non-sandbox Teller connections."]
            : [])
        ],
        notes:
          tellerEnvironment === "sandbox"
            ? ["Sandbox enrollments do not require mTLS client certificates."]
            : ["Webhook signing secrets are optional but recommended for automatic Teller syncs."]
      },
      {
        provider: "SIMPLEFIN",
        label: "SimpleFIN",
        enabled: true,
        ready: simpleFinDevelopmentConfigured,
        environment: simpleFinMode,
        issues:
          simpleFinMode === "development" && !simpleFinDevelopmentConfigured
            ? ["Enter a SimpleFIN server URL to use development mode."]
            : [],
        notes: [
          simpleFinMode === "development"
            ? "Use a setup token from your development SimpleFIN server."
            : simpleFinMode === "sandbox"
              ? "Use a setup token from the SimpleFIN Bridge demo flow."
              : "Use a setup token from your production SimpleFIN provider or the live Bridge."
        ]
      }
    ];
  };

  const getStripeWebhookTimestamp = (event: Stripe.Event) =>
    Number.isFinite(event.created) ? new Date(event.created * 1000).toISOString() : now().toISOString();

  const findStripeConnectionForWebhook = async (account: Stripe.FinancialConnections.Account) => {
    if (!account.id && !account.authorization) {
      return null;
    }

    return database.connection.findFirst({
      where: {
        provider: "STRIPE",
        OR: [
          ...(account.authorization
            ? [
                {
                  providerItemId: account.authorization
                }
              ]
            : []),
          ...(account.id
            ? [
                {
                  accounts: {
                    some: {
                      externalAccountId: account.id
                    }
                  }
                }
              ]
            : [])
        ]
      },
      include: {
        accounts: true
      }
    });
  };

  const runWithProviderBackgroundGate = async <T>(provider: Provider, task: () => Promise<T>) => {
    const providerSettings = await getEffectiveProviderSettings();
    const dynamicAutomaticSyncConcurrency: AutomaticSyncConcurrencyConfig = {
      HOME_VALUES: providerSettings.HOME_VALUES?.automaticSyncConcurrency ?? 1,
      PLAID: providerSettings.PLAID.automaticSyncConcurrency,
      STRIPE: providerSettings.STRIPE.automaticSyncConcurrency,
      TELLER: providerSettings.TELLER.automaticSyncConcurrency,
      SIMPLEFIN: providerSettings.SIMPLEFIN.automaticSyncConcurrency,
      VEHICLE_VALUES: providerSettings.VEHICLE_VALUES?.automaticSyncConcurrency ?? 1
    };
    const limit = dynamicAutomaticSyncConcurrency[provider];
    const existingGate = providerBackgroundSyncGates.get(provider);
    const gate =
      existingGate && existingGate.limit === limit
        ? existingGate
        : {
            limit,
            run: createConcurrencyGate(limit)
          };

    if (!existingGate || existingGate.limit !== limit) {
      providerBackgroundSyncGates.set(provider, gate);
    }

    return gate.run(task);
  };

  const updatePlaidWebhookMetadata = async ({
    connectionId,
    event,
    nowIso,
    extra = {}
  }: {
    connectionId: string;
    event: PlaidWebhookEvent;
    nowIso: string;
    extra?: Record<string, unknown>;
  }) => {
    const currentConnection = await database.connection.findUniqueOrThrow({
      where: {
        id: connectionId
      },
      select: {
        metadataJson: true
      }
    });
    const metadata = parseConnectionMetadata(currentConnection.metadataJson);
    const plaidMetadata = getPlaidMetadata(metadata);

    await database.connection.update({
      where: {
        id: connectionId
      },
      data: {
        metadataJson: JSON.stringify({
          ...metadata,
          plaid: {
            ...plaidMetadata,
            lastWebhookAt: nowIso,
            lastWebhookCode: event.webhook_code,
            lastWebhookEnvironment: event.environment ?? null,
            initialUpdateComplete: event.initial_update_complete ?? plaidMetadata.initialUpdateComplete ?? null,
            historicalUpdateComplete: event.historical_update_complete ?? plaidMetadata.historicalUpdateComplete ?? null,
            ...extra
          }
        })
      }
    });
  };

  const buildSiblingLinks = async (link: {
    connectionId: string | null;
    provider: Provider | null;
  }): Promise<SiblingLink[]> => {
    if (!link.connectionId || !link.provider) {
      return [];
    }

    return database.accountLink.findMany({
      where: {
        status: {
          in: [...CURRENT_LINK_STATUSES]
        },
        connectionId: link.connectionId,
        provider: toPrismaProvider(link.provider),
        connectionAccountId: {
          not: null
        }
      },
      include: {
        connectionAccount: true
      }
    });
  };

  const getNextValuationWeeklySlot = async (excludeLinkId?: string | null) => {
    const weeklyLinks = await database.accountLink.findMany({
      where: {
        provider: {
          in: ["HOME_VALUES", "VEHICLE_VALUES"]
        },
        syncFrequency: "WEEKLY",
        isEnabled: true,
        status: {
          in: [...CURRENT_LINK_STATUSES]
        },
        ...(excludeLinkId
          ? {
              id: {
                not: excludeLinkId
              }
            }
          : {})
      },
      select: {
        syncHour: true,
        syncDayOfWeek: true
      }
    });

    const usedSlots = new Set(
      weeklyLinks
        .map(link =>
          typeof link.syncDayOfWeek === "number" && typeof link.syncHour === "number"
            ? link.syncDayOfWeek * 24 + link.syncHour
            : null
        )
        .filter((slot): slot is number => slot != null)
    );

    for (let slot = 0; slot < 7 * 24; slot += 1) {
      if (!usedSlots.has(slot)) {
        return {
          syncDayOfWeek: Math.floor(slot / 24),
          syncHour: slot % 24
        };
      }
    }

    const fallbackSlot = usedSlots.size % (7 * 24);
    return {
      syncDayOfWeek: Math.floor(fallbackSlot / 24),
      syncHour: fallbackSlot % 24
    };
  };

  const normalizeHomeValueLinkSchedule = async (
    payload: UpdateAccountLinkPayload,
    currentLink?: {
      id: string;
      provider: Provider | null;
      assetType: UpdateAccountLinkPayload["assetType"];
      writeMode: WriteMode;
      snapshotHistory: boolean;
      syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
      syncHour: number | null;
      syncDayOfWeek: number | null;
    } | null
  ): Promise<UpdateAccountLinkPayload> => {
    if (!isValuationProvider(payload.provider)) {
      return payload;
    }

    if (payload.syncFrequency === "MANUAL" || !payload.isEnabled) {
      return {
        ...payload,
        syncFrequency: "MANUAL",
        syncHour: null,
        syncDayOfWeek: null
      };
    }

    if (
      isValuationProvider(currentLink?.provider) &&
      currentLink.syncFrequency === "WEEKLY" &&
      typeof currentLink.syncHour === "number" &&
      typeof currentLink.syncDayOfWeek === "number"
    ) {
      return {
        ...payload,
        syncFrequency: "WEEKLY",
        syncHour: currentLink.syncHour,
        syncDayOfWeek: currentLink.syncDayOfWeek
      };
    }

    const slot = await getNextValuationWeeklySlot(currentLink?.id ?? null);
    return {
      ...payload,
      syncFrequency: "WEEKLY",
      syncHour: slot.syncHour,
      syncDayOfWeek: slot.syncDayOfWeek
    };
  };

  const normalizeAccountLinkPayload = async (
    payload: UpdateAccountLinkPayload,
    currentLink?: {
      id: string;
      provider: Provider | null;
      assetType: UpdateAccountLinkPayload["assetType"];
      writeMode: WriteMode;
      snapshotHistory: boolean;
      syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
      syncHour: number | null;
      syncDayOfWeek: number | null;
    } | null
  ): Promise<UpdateAccountLinkPayload & { writeMode: WriteMode; snapshotHistory: boolean }> => {
    const scheduledPayload = await normalizeHomeValueLinkSchedule(payload, currentLink);
    const valuationProvider = isValuationProvider(scheduledPayload.provider) ? scheduledPayload.provider : null;

    return {
      ...scheduledPayload,
      assetType: valuationProvider ? getValuationAssetType(valuationProvider) : scheduledPayload.assetType,
      writeMode:
        valuationProvider
          ? "SNAPSHOT_DELTA"
          : scheduledPayload.writeMode ?? currentLink?.writeMode ?? "TRANSACTIONS",
      snapshotHistory: scheduledPayload.snapshotHistory ?? currentLink?.snapshotHistory ?? true
    };
  };

  const getPersistedNextSyncAt = ({
    syncFrequency,
    syncHour,
    syncDayOfWeek,
    isEnabled,
    lastSyncedAt
  }: {
    syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
    syncHour: number | null;
    syncDayOfWeek: number | null;
    isEnabled: boolean;
    lastSyncedAt: Date | null;
  }) =>
    getNextAccountLinkDueAt(now(), {
      syncFrequency,
      syncHour,
      syncDayOfWeek,
      isEnabled,
      lastSyncedAt
    });

  const listCurrentSyncLinks = (where: Prisma.AccountLinkWhereInput = {}) =>
    database.accountLink.findMany({
      where: {
        status: {
          in: [...CURRENT_LINK_STATUSES]
        },
        ...where
      },
      include: currentLinkInclude,
      orderBy: currentLinkOrderBy
    });

  const findCurrentSyncLinkRecord = (actualAccountId: string) =>
    database.accountLink.findFirst({
      where: {
        actualAccountId,
        status: {
          in: [...CURRENT_LINK_STATUSES]
        }
      },
      include: currentLinkInclude,
      orderBy: currentLinkOrderBy
    });

  const listActualTransactionsForImportedIdsByDateRange = async ({
    actualAccountId,
    transactions
  }: {
    actualAccountId: string;
    transactions: Array<{
      importedId: string;
      transactionDate: string;
    }>;
  }) => {
    const bounds = getDateRangeBounds(transactions.map(transaction => transaction.transactionDate));
    if (!bounds) {
      return new Map<string, Awaited<ReturnType<typeof actual.listTransactionsByDateRange>>[number]>();
    }

    const importedIds = new Set(transactions.map(transaction => transaction.importedId));
    const matchingTransactions = await actual.listTransactionsByDateRange(
      actualAccountId,
      bounds.startDate,
      bounds.endDate
    );

    return new Map(
      matchingTransactions
        .filter(transaction => transaction.imported_id && importedIds.has(transaction.imported_id))
        .map(transaction => [transaction.imported_id as string, transaction])
    );
  };

  const buildReconcileTransactions = ({
    actualAccountId,
    actualCategories,
    linkConfig,
    siblingLinks,
    transactions
  }: {
    actualAccountId: string;
    actualCategories: ActualCategoryDto[];
    linkConfig: LinkConfigData;
    siblingLinks: Awaited<ReturnType<typeof buildSiblingLinks>>;
    transactions: ProviderSyncTransaction[];
  }) =>
    transactions.map(transaction => {
      const resolvedCategoryId = resolveTransactionCategoryId({
        transaction,
        actualCategories,
        categoryMappings: linkConfig.categoryMappings || []
      });

      return stripUndefined({
        date: transaction.date,
        amount: transaction.amount,
        payee_name: transaction.payeeName,
        imported_payee: transaction.importedPayee,
        notes: transaction.notes,
        imported_id: transaction.importedId,
        cleared: transaction.cleared,
        category_names: transaction.categoryNames,
        resolved_category_id: resolvedCategoryId,
        transfer_actual_account_id: resolveTransferActualAccountId({
          transaction,
          siblings: siblingLinks.map(sibling => ({
            actualAccountId: sibling.actualAccountId,
            actualAccountName: sibling.actualAccountName,
            connectionAccount: sibling.connectionAccount
              ? {
                  name: sibling.connectionAccount.name,
                  officialName: sibling.connectionAccount.officialName,
                  mask: sibling.connectionAccount.mask
                }
              : null
          })),
          currentActualAccountId: actualAccountId
        })
      }) satisfies ReconcileTransactionInput;
    });

  const getAutomaticSyncBlockReason = (link: Pick<SyncableLink, "configJson" | "connection">) => {
    const linkHealth = parseLinkConfig(link.configJson).health;
    if (isBlockingSyncHealth(linkHealth)) {
      return linkHealth?.message || "Link requires attention before automatic sync can continue.";
    }

    const connectionHealth = parseConnectionMetadata(link.connection?.metadataJson).health;
    if (isBlockingSyncHealth(connectionHealth)) {
      return connectionHealth?.message || "Connection requires attention before automatic sync can continue.";
    }

    return null;
  };

  const isAutomaticSyncBackoffActive = (link: Pick<SyncableLink, "configJson">) => {
    const backoffUntil = parseLinkConfig(link.configJson).automaticSyncBackoffUntil;
    if (!backoffUntil) {
      return false;
    }

    const backoffUntilMs = Date.parse(backoffUntil);
    return Number.isFinite(backoffUntilMs) && backoffUntilMs > now().getTime();
  };

  const reconcileActualExternalUnlinks = async (actualAccountIds?: string[]) => {
    const capabilities = await getActualCapabilities();
    if (!capabilities.externalSyncWritebackEnabled) {
      return;
    }

    const trackedCurrentLinks = await listTrackedCurrentActualExternalLinks(actualAccountIds);
    if (trackedCurrentLinks.length === 0) {
      return;
    }

    const trackedActualAccountIds = trackedCurrentLinks.map(link => link.actualAccountId);
    const actualExternalLinkedAccountIds = new Set<string>();

    if (actualAccountIds && trackedActualAccountIds.length > 0 && typeof actual.getExternalSyncAccount === "function") {
      for (const actualAccountId of trackedActualAccountIds) {
        const externalSync = await actual.getExternalSyncAccount(actualAccountId);
        if (externalSync.linked && externalSync.syncSource === "external") {
          actualExternalLinkedAccountIds.add(actualAccountId);
        }
      }
    } else {
      const actualBankSyncLinks = await actual.listBankSyncLinks();
      for (const link of actualBankSyncLinks) {
        if (link.accountSyncSource === "external") {
          actualExternalLinkedAccountIds.add(link.actualAccountId);
        }
      }
    }

    await Promise.all(
      trackedCurrentLinks
        .filter(link => !actualExternalLinkedAccountIds.has(link.actualAccountId))
        .map(link => {
          const linkConfig = parseLinkConfig(link.configJson);
          return database.accountLink.update({
            where: {
              id: link.id
            },
            data: {
              isEnabled: false,
              nextSyncAt: null,
              configJson: serializeLinkConfig({
                ...linkConfig,
                actualExternalLinked: false,
                health: {
                  state: "ATTENTION_REQUIRED",
                  scope: "ACTUAL_BACKEND",
                  action: "NONE",
                  code: "ACTUAL_UNLINKED",
                  message: "This account was unlinked in Actual. Re-link it here to resume sync.",
                  updatedAt: now().toISOString()
                },
                categoryMappings: linkConfig.categoryMappings || [],
                seenCategoryNames: linkConfig.seenCategoryNames || []
              })
            }
          });
        })
    );
  };

  const loadCurrentSyncLink = async (actualAccountId: string): Promise<SyncableLink> =>
    reconcileActualExternalUnlinks([actualAccountId]).then(() =>
      database.accountLink.findFirstOrThrow({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: currentLinkInclude,
        orderBy: currentLinkOrderBy
      })
    );

  const findCurrentSyncLink = async (actualAccountId: string): Promise<SyncableLink | null> =>
    reconcileActualExternalUnlinks([actualAccountId]).then(() => findCurrentSyncLinkRecord(actualAccountId));

  const createSyncRunForLink = async (link: Pick<SyncableLink, "id" | "connectionId">) =>
    database.syncRun.create({
      data: {
        accountLinkId: link.id,
        connectionId: link.connectionId,
        status: "RUNNING"
      }
    });

  const getCurrentLinkedWritebackState = async (actualAccountId: string) => {
    const link = await database.accountLink.findFirst({
      where: {
        actualAccountId,
        status: {
          in: [...CURRENT_LINK_STATUSES]
        }
      },
      include: {
        connection: true,
        connectionAccount: true
      },
      orderBy: [
        {
          status: "asc"
        },
        {
          updatedAt: "desc"
        },
        {
          createdAt: "desc"
        }
      ]
    });

    if (!link || !link.provider || !link.connection || !link.connectionAccount) {
      return null;
    }

    const metadata: ActualExternalSyncMetadataInput = {
      syncSource: "external",
      providerAccountId: link.connectionAccount.externalAccountId,
      institutionName: link.connection.institutionName || link.connection.label,
      institutionExternalId: link.connection.institutionId ?? null,
      mask: link.connectionAccount.mask ?? null,
      officialName: link.connectionAccount.officialName ?? null,
      balanceCurrent: toActualAmountInteger(link.connectionAccount.currentBalance),
      balanceAvailable: toActualAmountInteger(link.connectionAccount.availableBalance),
      balanceLimit: null,
      lastSync: toActualLastSyncValue(link.lastSyncedAt)
    };

    return {
      link,
      metadata
    };
  };

  const externalSyncMetadataMatches = (
    current: ExistingExternalSyncMetadata,
    next: ActualExternalSyncMetadataInput,
    options?: {
      includeLastSync?: boolean;
    }
  ) =>
    current.linked &&
    current.syncSource === "external" &&
    current.providerAccountId === next.providerAccountId &&
    current.institutionName === next.institutionName &&
    current.institutionExternalId === (next.institutionExternalId ?? null) &&
    current.mask === (next.mask ?? null) &&
    current.officialName === (next.officialName ?? null) &&
    current.balanceCurrent === (typeof next.balanceCurrent === "number" ? next.balanceCurrent : null) &&
    current.balanceAvailable === (typeof next.balanceAvailable === "number" ? next.balanceAvailable : null) &&
    current.balanceLimit === (typeof next.balanceLimit === "number" ? next.balanceLimit : null) &&
    (!options?.includeLastSync || current.lastSync === (next.lastSync ?? null));

  const syncActualExternalWriteback = async ({
    actualAccountId,
    lastSync
  }: {
    actualAccountId: string;
    lastSync?: string | null;
  }): Promise<void> => {
    const capabilities = await getActualCapabilities();
    if (!capabilities.externalSyncWritebackEnabled) {
      return;
    }

    const current = await getCurrentLinkedWritebackState(actualAccountId);
    if (!current) {
      try {
        await actual.unlinkExternalSyncAccount(actualAccountId);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("is not externally linked")) {
          throw error;
        }
      }
      return;
    }

    const nextMetadata = {
      ...current.metadata,
      lastSync: lastSync ?? current.metadata.lastSync ?? null
    } satisfies ActualExternalSyncMetadataInput;
    const existingExternalSync =
      typeof actual.getExternalSyncAccount === "function"
        ? await actual.getExternalSyncAccount(actualAccountId)
        : null;
    const includeLastSync = capabilities.externalSyncMode !== "account-api";

    if (existingExternalSync && externalSyncMetadataMatches(existingExternalSync, nextMetadata, { includeLastSync })) {
      const currentConfig = parseLinkConfig(current.link.configJson);
      if (!currentConfig.actualExternalLinked) {
        await database.accountLink.update({
          where: {
            id: current.link.id
          },
          data: {
            configJson: serializeLinkConfig({
              ...currentConfig,
              health: currentConfig.health?.code === "ACTUAL_UNLINKED" ? null : currentConfig.health ?? null,
              actualExternalLinked: true,
              categoryMappings: currentConfig.categoryMappings || [],
              seenCategoryNames: currentConfig.seenCategoryNames || []
            })
          }
        });
      }
      return;
    }

    await actual.linkExternalSyncAccount(actualAccountId, {
      ...nextMetadata,
      bankSyncStatus: existingExternalSync?.bankSyncStatus ?? null
    });

    const currentConfig = parseLinkConfig(current.link.configJson);
    if (!currentConfig.actualExternalLinked) {
      await database.accountLink.update({
        where: {
          id: current.link.id
        },
        data: {
          configJson: serializeLinkConfig({
            ...currentConfig,
            health: currentConfig.health?.code === "ACTUAL_UNLINKED" ? null : currentConfig.health ?? null,
            actualExternalLinked: true,
            categoryMappings: currentConfig.categoryMappings || [],
            seenCategoryNames: currentConfig.seenCategoryNames || []
          })
        }
      });
    }
  };

  const markSyncRunFailure = async ({
    link,
    syncRunId,
    error,
    summary = "Unknown sync failure",
    automatic = false
  }: {
    link: Pick<SyncableLink, "id" | "configJson" | "actualAccountId">;
    syncRunId: string;
    error: unknown;
    summary?: string;
    automatic?: boolean;
  }) => {
    const existingConfig = parseLinkConfig(link.configJson);
    const nextAutomaticSyncFailureCount = automatic ? (existingConfig.automaticSyncFailureCount || 0) + 1 : 0;
    const backoffBaseMinutes = isRateLimitedSyncError(error)
      ? Math.min(runtime.automaticSyncBackoffMaxMinutes, runtime.automaticSyncBackoffBaseMinutes * 4)
      : runtime.automaticSyncBackoffBaseMinutes;
    const nextAutomaticSyncBackoffUntil = automatic
      ? new Date(
          now().getTime() +
            Math.min(
              runtime.automaticSyncBackoffMaxMinutes,
              backoffBaseMinutes * 2 ** Math.max(nextAutomaticSyncFailureCount - 1, 0)
            ) *
              60 *
              1000
        ).toISOString()
      : null;
    await database.syncRun.update({
      where: {
        id: syncRunId
      },
      data: {
        status: "FAILED",
        finishedAt: now(),
        error: error instanceof Error ? error.message : summary
      }
    });
    await database.accountLink.update({
      where: {
        id: link.id
      },
      data: {
        configJson: serializeLinkConfig({
          ...existingConfig,
          health: toSyncHealth(error, {
            scope: "ACTUAL_BACKEND",
            action: "RETRY"
          }),
          automaticSyncBackoffUntil: nextAutomaticSyncBackoffUntil,
          automaticSyncFailureCount: nextAutomaticSyncFailureCount,
          categoryMappings: existingConfig.categoryMappings || [],
          seenCategoryNames: existingConfig.seenCategoryNames || []
        })
      }
    });
    await markActualExternalSyncFailure(link.actualAccountId);
  };

  const applyReconcilePhase = async ({
    link,
    providerTransactions,
    reconcileTransactions,
    removedImportedIds,
    actualExternalSyncPrefs
  }: {
    link: SyncableLink;
    providerTransactions: ProviderSyncTransaction[];
    reconcileTransactions: ReconcileTransactionInput[];
    removedImportedIds: string[];
    actualExternalSyncPrefs: ReturnType<typeof normalizeActualExternalSyncPrefs>;
  }) => {
    const migrating = link.status === "MIGRATING";
    const importPayload = reconcileTransactions.map(toImportTransactionInput);
    const importOptions = {
      reimportDeleted: actualExternalSyncPrefs.reimportDeleted,
      updateDates: actualExternalSyncPrefs.updateDates
    };

    const migrationResult = migrating && importPayload.length > 0
      ? await actual.importTransactions(link.actualAccountId, importPayload, importOptions)
      : migrating
        ? { added: [], updated: [], errors: [] }
        : null;
    if (migrationResult?.errors.length) {
      throw new Error(migrationResult.errors[0]?.message || "Actual migration import failed");
    }

    const removedActualTransactionIds = !migrating && removedImportedIds.length > 0
      ? (
          await database.importedTransaction.findMany({
            where: {
              accountLinkId: link.id,
              importedId: {
                in: removedImportedIds
              },
              actualTransactionId: {
                not: null
              }
            },
            select: {
              actualTransactionId: true
            }
          })
        )
          .map(transaction => transaction.actualTransactionId)
          .filter((transactionId): transactionId is string => Boolean(transactionId))
      : [];

    const reconcileResult = !migrating && (reconcileTransactions.length > 0 || removedImportedIds.length > 0)
      ? await actual.reconcileTransactions(
          link.actualAccountId,
          reconcileTransactions,
          removedImportedIds,
          removedActualTransactionIds,
          importOptions
        )
      : !migrating
        ? { added: 0, updated: 0, removed: 0, renamedPayees: 0, addedIds: [], updatedIds: [] }
        : null;

    const importedTransactionByImportedId = reconcileTransactions.length > 0
      ? await listActualTransactionsForImportedIdsByDateRange({
          actualAccountId: link.actualAccountId,
          transactions: reconcileTransactions.map(transaction => ({
            importedId: transaction.imported_id,
            transactionDate: transaction.date
          }))
        })
      : new Map<string, Awaited<ReturnType<typeof actual.listTransactionsByDateRange>>[number]>();

    if (reconcileTransactions.length > 0) {
      const ledgerSeenAt = now();
      await Promise.all(
        reconcileTransactions.map((transaction, index) =>
          runImportedTransactionLedgerWrite(() => {
            const actualTransactionId = importedTransactionByImportedId.get(transaction.imported_id)?.id ?? null;
            const primarySourceCategory = getPrimarySourceCategory(providerTransactions[index]!);

            return database.importedTransaction.upsert({
              where: {
                accountLinkId_importedId: {
                  accountLinkId: link.id,
                  importedId: transaction.imported_id
                }
              },
              update: stripUndefined({
                transactionDate: transaction.date,
                actualTransactionId,
                primarySourceCategory,
                appliedCategoryId: transaction.resolved_category_id ?? null,
                lastSeenAt: ledgerSeenAt
              }),
              create: stripUndefined({
                accountLinkId: link.id,
                importedId: transaction.imported_id,
                transactionDate: transaction.date,
                actualTransactionId,
                primarySourceCategory,
                appliedCategoryId: transaction.resolved_category_id ?? null,
                observedCategoryId: transaction.resolved_category_id ?? null,
                lastSeenAt: ledgerSeenAt
              })
            });
          })
        )
      );
    }

    if (!migrating && removedImportedIds.length > 0) {
      await database.importedTransaction.deleteMany({
        where: {
          accountLinkId: link.id,
          importedId: {
            in: removedImportedIds
          }
        }
      });
    }

    return {
      addedCount: migrating ? migrationResult?.added.length ?? 0 : reconcileResult?.added ?? 0,
      updatedCount: migrating ? migrationResult?.updated.length ?? 0 : reconcileResult?.updated ?? 0,
      removedCount: migrating ? 0 : reconcileResult?.removed ?? 0,
      newTransactions: migrating ? migrationResult?.added ?? [] : reconcileResult?.addedIds ?? [],
      matchedTransactions: migrating ? migrationResult?.updated ?? [] : reconcileResult?.updatedIds ?? []
    };
  };

  const applySyncResultToLink = async ({
    link,
    syncRunId,
    syncResult
  }: {
    link: SyncableLink;
    syncRunId: string;
    syncResult: ProviderSyncResult;
  }): Promise<AppliedSyncOutcome> => {
    const actualExternalSyncPrefs = normalizeActualExternalSyncPrefs(
      await getActualExternalSyncPrefs(link.actualAccountId)
    );
    const effectiveWriteMode = resolveEffectiveWriteMode(link.writeMode, actualExternalSyncPrefs);
    const transactionSyncResult = applyWriteModeToProviderSyncResult({
      result: syncResult,
      writeMode: link.writeMode,
      prefs: actualExternalSyncPrefs
    });
    const actualCategories = (await actual.listCategories()).map(category => ({
      id: category.id,
      name: category.name
    }));
    let linkConfig = parseLinkConfig(link.configJson);
    linkConfig = await learnCategoryMappingsFromHistory({
      database,
      actual,
      link: {
        id: link.id,
        actualAccountId: link.actualAccountId
      },
      linkConfig,
      actualCategories,
      now: now()
    });

    const siblingLinks = await buildSiblingLinks(link);
    const transactionReconcileTransactions: ReconcileTransactionInput[] = buildReconcileTransactions({
      actualAccountId: link.actualAccountId,
      actualCategories,
      linkConfig,
      siblingLinks,
      transactions: transactionSyncResult.transactions
    });
    const reconcileImportedIds = new Set(transactionReconcileTransactions.map(transaction => transaction.imported_id));
    const transactionRemovedImportedIds = transactionSyncResult.removedImportedIds.filter(
      importedId => !reconcileImportedIds.has(importedId)
    );
    const transactionPhase = await applyReconcilePhase({
      link,
      providerTransactions: transactionSyncResult.transactions,
      reconcileTransactions: transactionReconcileTransactions,
      removedImportedIds: transactionRemovedImportedIds,
      actualExternalSyncPrefs
    });

    const snapshotTransaction =
      writeModeUsesSnapshotDelta(effectiveWriteMode) && syncResult.balanceSnapshot
        ? buildSnapshotDeltaTransaction({
            result: syncResult,
            snapshotHistory: link.snapshotHistory,
            prefs: actualExternalSyncPrefs,
            currentLedgerBalance: await actual.getAccountBalance(link.actualAccountId)
          })
        : null;
    const snapshotTransactions = snapshotTransaction ? [snapshotTransaction] : [];
    const snapshotReconcileTransactions = snapshotTransaction
      ? buildReconcileTransactions({
          actualAccountId: link.actualAccountId,
          actualCategories,
          linkConfig,
          siblingLinks,
          transactions: snapshotTransactions
        })
      : [];
    const snapshotPhase = await applyReconcilePhase({
      link,
      providerTransactions: snapshotTransactions,
      reconcileTransactions: snapshotReconcileTransactions,
      removedImportedIds: [],
      actualExternalSyncPrefs
    });

    await pruneImportedTransactionLedger({
      database,
      accountLinkId: link.id,
      now: now()
    });

    const migrating = link.status === "MIGRATING";
    const syncCompletedAt = now();
    await database.accountLink.update({
      where: {
        id: link.id
      },
      data: {
        status: migrating ? "ACTIVE" : link.status,
        lastSyncedAt: syncCompletedAt,
        nextSyncAt: getPersistedNextSyncAt({
          syncFrequency: link.syncFrequency,
          syncHour: link.syncHour,
          syncDayOfWeek: link.syncDayOfWeek,
          isEnabled: link.isEnabled,
          lastSyncedAt: syncCompletedAt
        }),
        migrationCompletedAt: migrating ? syncCompletedAt : link.migrationCompletedAt,
        configJson: serializeLinkConfig({
          ...linkConfig,
          ...syncResult.configPatch,
          health: clearSyncHealth(),
          automaticSyncBackoffUntil: null,
          automaticSyncFailureCount: 0,
          categoryMappings: linkConfig.categoryMappings || [],
          seenCategoryNames: [
            ...(linkConfig.seenCategoryNames || []),
            ...transactionSyncResult.transactions.flatMap(transaction => transaction.categoryNames || [])
          ]
        })
      }
    });

    await syncActualExternalWriteback({
      actualAccountId: link.actualAccountId,
      lastSync: toActualLastSyncValue(syncCompletedAt)
    });
    await markActualExternalSyncSuccess(link.actualAccountId, syncCompletedAt);

    const addedCount = transactionPhase.addedCount + snapshotPhase.addedCount;
    const updatedCount = transactionPhase.updatedCount + snapshotPhase.updatedCount;
    const removedCount = transactionPhase.removedCount + snapshotPhase.removedCount;
    const newTransactions = [...transactionPhase.newTransactions, ...snapshotPhase.newTransactions];
    const matchedTransactions = [...transactionPhase.matchedTransactions, ...snapshotPhase.matchedTransactions];
    const summary = migrating
      ? `Migration sync imported ${addedCount} transactions, updated ${updatedCount}, removed 0.`
      : `Imported ${addedCount} transactions, updated ${updatedCount}, removed ${removedCount}.`;
    const updatedAccounts =
      newTransactions.length > 0 || matchedTransactions.length > 0 || removedCount > 0
        ? [link.actualAccountId]
        : [];

    await database.syncRun.update({
      where: {
        id: syncRunId
      },
      data: {
        status: "SUCCESS",
        finishedAt: now(),
        summary
      }
    });

    return {
      newTransactions,
      matchedTransactions,
      updatedAccounts,
      summary,
      lastSync: syncCompletedAt.toISOString()
    };
  };

  const runLoadedLinkSyncBatch = async (links: SyncableLink[]) => {
    const eligibleLinks: SyncableLink[] = [];

    for (const link of links) {
      if (isAutomaticSyncBackoffActive(link)) {
        continue;
      }

      const blockReason = getAutomaticSyncBlockReason(link);
      if (!blockReason) {
        eligibleLinks.push(link);
        continue;
      }

      await database.syncRun.create({
        data: {
          accountLinkId: link.id,
          connectionId: link.connectionId,
          status: "SKIPPED",
          finishedAt: now(),
          summary: `Skipped automatic sync: ${blockReason}`
        }
      });
    }

    if (eligibleLinks.length === 0) {
      return;
    }

    const syncRunsByLinkId = new Map<string, string>();
    for (const link of eligibleLinks) {
      const syncRun = await createSyncRunForLink(link);
      syncRunsByLinkId.set(link.id, syncRun.id);
    }

    const groups = new Map<string, SyncableLink[]>();
    for (const link of eligibleLinks) {
      const batchKey = link.provider && link.connectionId ? `${link.provider}:${link.connectionId}` : `single:${link.id}`;
      const group = groups.get(batchKey) || [];
      group.push(link);
      groups.set(batchKey, group);
    }

    for (const group of groups.values()) {
      const adapter = getProviderAdapter(group[0]?.provider);
      if (!adapter) {
        for (const link of group) {
          const syncRunId = syncRunsByLinkId.get(link.id);
          if (!syncRunId) {
            continue;
          }

          await database.syncRun.update({
            where: {
              id: syncRunId
            },
            data: {
              status: "SKIPPED",
              finishedAt: now(),
              summary: "No provider configured"
            }
          });
        }
        continue;
      }

      if (!adapter.syncAccountLinks || group.length === 1) {
        for (const link of group) {
          const syncRunId = syncRunsByLinkId.get(link.id);
          if (!syncRunId) {
            continue;
          }

          try {
            await markActualExternalSyncPending(link.actualAccountId);
            const syncResult = await runWithProviderBackgroundGate(link.provider!, () => adapter.syncAccountLink(link.id));
            await applySyncResultToLink({
              link,
              syncRunId,
              syncResult
            });
          } catch (error) {
            await markSyncRunFailure({
              link,
              syncRunId,
              error,
              automatic: true
            });
          }
        }
        continue;
      }

      let outcomes: Map<string, ProviderSyncOutcome>;
      try {
        await Promise.all(group.map(link => markActualExternalSyncPending(link.actualAccountId)));
        outcomes = await runWithProviderBackgroundGate(group[0]!.provider!, () =>
          adapter.syncAccountLinks!(group.map(link => link.id))
        );
      } catch (error) {
        outcomes = new Map(group.map(link => [link.id, { error } satisfies ProviderSyncOutcome]));
      }

      for (const link of group) {
        const syncRunId = syncRunsByLinkId.get(link.id);
        if (!syncRunId) {
          continue;
        }

        const outcome = outcomes.get(link.id);
        const syncResult = outcome?.result;
        const syncError = outcome?.error ?? (!syncResult ? new Error(`No sync result returned for link ${link.id}`) : null);
        if (syncError) {
          await markSyncRunFailure({
            link,
            syncRunId,
            error: syncError,
            automatic: true
          });
          continue;
        }

        try {
          await applySyncResultToLink({
            link,
            syncRunId,
            syncResult: syncResult!
          });
        } catch (error) {
          await markSyncRunFailure({
            link,
            syncRunId,
            error,
            automatic: true
          });
        }
      }
    }
  };

  const toExternalSyncStatusFromHealth = ({
    configured,
    isEnabled,
    lastSync,
    health
  }: {
    configured: boolean;
    isEnabled: boolean;
    lastSync?: string | null;
    health?: ReturnType<typeof parseLinkConfig>["health"]   | null;
  }): InternalActualExternalSyncStatus => {
    if (!health) {
      if (!isEnabled) {
        return {
          configured,
          state: "error",
          message: "External sync is disabled for this account.",
          lastSync: lastSync ?? null,
          canSync: false,
          needsReauth: false
        };
      }

      return {
        configured,
        state: "ok",
        message: null,
        lastSync: lastSync ?? null,
        canSync: true,
        needsReauth: false
      };
    }

    const reauthRequired =
      health.action === "REAUTH_CONNECTION" ||
      health.action === "REAUTH_BANK" ||
      health.action === "MANUAL_RECONNECT" ||
      health.action === "CHECK_PROVIDER";

    return {
      configured,
      state: reauthRequired ? "reauth_required" : "error",
      message: health.message ?? null,
      lastSync: lastSync ?? null,
      canSync: !reauthRequired && isEnabled,
      needsReauth: reauthRequired
    };
  };

  const getActualExternalSyncStatus = async (actualAccountId?: string): Promise<InternalActualExternalSyncStatus> => {
    if (!actualAccountId) {
      return {
        configured: true,
        state: "ok",
        message: null,
        lastSync: null,
        canSync: false,
        needsReauth: false
      };
    }

    const link = await findCurrentSyncLink(actualAccountId);
    if (!link || !link.provider || !link.connection || !link.connectionAccount) {
      return {
        configured: false,
        state: "not_configured",
        message: "No external sync link is configured for this account.",
        lastSync: null,
        canSync: false,
        needsReauth: false
      };
    }

    const configured = await isProviderConfigured(link.provider);

    if (!configured) {
      return {
        configured: false,
        state: "not_configured",
        message: `${link.provider} is not configured in Actual Sync Hub.`,
        lastSync: link.lastSyncedAt?.toISOString() ?? null,
        canSync: false,
        needsReauth: false
      };
    }

    const linkHealth = parseLinkConfig(link.configJson).health;
    if (linkHealth) {
      return toExternalSyncStatusFromHealth({
        configured: true,
        isEnabled: link.isEnabled,
        lastSync: link.lastSyncedAt?.toISOString() ?? null,
        health: linkHealth
      });
    }

    const connectionHealth = parseConnectionMetadata(link.connection.metadataJson).health;
    if (connectionHealth) {
      return toExternalSyncStatusFromHealth({
        configured: true,
        isEnabled: link.isEnabled,
        lastSync: link.lastSyncedAt?.toISOString() ?? null,
        health: connectionHealth
      });
    }

    return toExternalSyncStatusFromHealth({
      configured: true,
      isEnabled: link.isEnabled,
      lastSync: link.lastSyncedAt?.toISOString() ?? null,
      health: null
    });
  };

  const toActualBankSyncStatus = (status: InternalActualExternalSyncStatus): ActualBankSyncStatus => {
    if (status.needsReauth || status.state === "reauth_required") {
      return "reauth-required";
    }

    if (status.state === "ok") {
      return "ok";
    }

    if (status.state === "syncing") {
      return "pending";
    }

    return "attention-required";
  };

  const setActualExternalSyncStatus = async (
    actualAccountId: string,
    status: ActualBankSyncStatus,
    lastSync?: string | null
  ) => {
    const capabilities = await getActualCapabilities();
    if (!capabilities.externalSyncStatusEnabled || typeof actual.updateExternalSyncAccountStatus !== "function") {
      return;
    }

    if (lastSync === undefined) {
      await actual.updateExternalSyncAccountStatus(actualAccountId, status);
      return;
    }

    await actual.updateExternalSyncAccountStatus(actualAccountId, status, lastSync);
  };

  const setActualExternalSyncStatusFromInternal = async (
    actualAccountId: string,
    status: InternalActualExternalSyncStatus
  ) => {
    await setActualExternalSyncStatus(actualAccountId, toActualBankSyncStatus(status));
  };

  const markActualExternalSyncPending = async (actualAccountId: string) => {
    await setActualExternalSyncStatus(actualAccountId, "pending");
  };

  const markActualExternalSyncSuccess = async (actualAccountId: string, lastSync?: Date | string | null) => {
    await setActualExternalSyncStatus(actualAccountId, "ok", toActualLastSyncValue(lastSync ?? null));
  };

  const markActualExternalSyncFailure = async (actualAccountId: string) => {
    await setActualExternalSyncStatusFromInternal(actualAccountId, await getActualExternalSyncStatus(actualAccountId));
  };

  const runRequestedExternalSync = async (actualAccountId: string) => {
    const status = await getActualExternalSyncStatus(actualAccountId);
    if (!status.configured || status.needsReauth || !status.canSync) {
      await setActualExternalSyncStatusFromInternal(actualAccountId, status);
      return;
    }

    await appService.runAccountSync(actualAccountId);
  };

  const syncReviewService = createSyncReviewService({
    database,
    actual,
    currentLinkStatuses: CURRENT_LINK_STATUSES,
    getProviderAdapter,
    buildSiblingLinks,
    buildReconcileTransactions,
    syncActualExternalWriteback,
    markActualExternalSyncPending,
    markActualExternalSyncSuccess,
    markActualExternalSyncFailure,
    now
  });

  const appService: AppService = {
    async getRuntimeInfo(): Promise<RuntimeInfoDto> {
      const effectiveSettings = await getEffectiveProviderSettings();
      const actualCapabilities = await getActualCapabilities();
      const providers = await getProviderRuntimeInfo(effectiveSettings);
      const activePlaidSettings = getActivePlaidEnvironmentSettings(effectiveSettings.PLAID);
      const plaidEnabled = Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
      const activeStripeSettings = getActiveStripeEnvironmentSettings(effectiveSettings.STRIPE);
      const stripePublishableKeyConfigured = Boolean(activeStripeSettings.publishableKey.trim());
      const stripeSecretKeyConfigured = Boolean(activeStripeSettings.secretKey);
      const activeTellerSettings = getActiveTellerEnvironmentSettings(effectiveSettings.TELLER);
      const tellerEnabled = Boolean(activeTellerSettings.appId);
      const tellerMtlsConfigured =
        effectiveSettings.TELLER.environment === "sandbox" ||
        Boolean(
          ("certificatePem" in activeTellerSettings ? activeTellerSettings.certificatePem : "") &&
            ("keyPem" in activeTellerSettings ? activeTellerSettings.keyPem : "")
        );
      const plaidSandboxToolsEnabled = effectiveSettings.PLAID.environment === "sandbox";
      return {
        instanceLabel: runtime.instanceLabel,
        liveSandboxMode: runtime.liveSandboxMode,
        providers,
        settings: effectiveSettings,
        plaid: {
          enabled: plaidEnabled,
          environment: effectiveSettings.PLAID.environment,
          sandboxToolsEnabled: plaidSandboxToolsEnabled
        },
        stripe: {
          enabled: stripePublishableKeyConfigured && stripeSecretKeyConfigured,
          environment: effectiveSettings.STRIPE.environment,
          publishableKeyConfigured: stripePublishableKeyConfigured,
          secretKeyConfigured: stripeSecretKeyConfigured
        },
        teller: {
          enabled: tellerEnabled,
          environment: effectiveSettings.TELLER.environment,
          mtlsConfigured: tellerMtlsConfigured
        },
        simplefin: {
          enabled: true,
          mode: effectiveSettings.SIMPLEFIN.mode,
          requiresSetupToken: true
        },
        actual: {
          serverUrl: runtime.actualServerUrl,
          budgetSyncIdConfigured: runtime.actualBudgetSyncIdConfigured,
          externalSyncWritebackEnabled: actualCapabilities.externalSyncWritebackEnabled
        }
      };
    },

    async listConnections(): Promise<ConnectionDto[]> {
      const connections = await database.connection.findMany({
        include: {
          accounts: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      return connections.map(connection => {
        const metadata = parseConnectionMetadata(connection.metadataJson);
        const simplefinBaseUrl =
          connection.provider === "SIMPLEFIN" &&
          typeof metadata.simplefin === "object" &&
          metadata.simplefin &&
          "baseUrl" in metadata.simplefin &&
          typeof metadata.simplefin.baseUrl === "string"
            ? metadata.simplefin.baseUrl
            : null;
        const providerAccountsUrl =
          simplefinBaseUrl != null
            ? (() => {
                try {
                  const url = new URL(simplefinBaseUrl);
                  return `${url.origin}/my-account`;
                } catch {
                  return null;
                }
              })()
            : null;

        return {
          id: connection.id,
          provider: connection.provider,
          label: connection.label,
          status: connection.status,
          institutionName: connection.institutionName,
          institutionId: connection.institutionId,
          providerUserId:
            connection.provider === "TELLER" &&
                  typeof metadata.teller === "object" &&
                  metadata.teller &&
                  "userId" in metadata.teller &&
                  typeof metadata.teller.userId === "string"
                ? metadata.teller.userId
                : null,
          providerAccountsUrl,
          lastRefreshedAt: connection.lastRefreshedAt?.toISOString() ?? null,
          health: metadata.health ?? null,
          homeValues:
            connection.provider === "HOME_VALUES" &&
            typeof metadata.homeValues === "object" &&
            metadata.homeValues
              ? (metadata.homeValues as Exclude<ConnectionDto["homeValues"], undefined>)
              : null,
          vehicleValues:
            connection.provider === "VEHICLE_VALUES" &&
            typeof metadata.vehicleValues === "object" &&
            metadata.vehicleValues
              ? (metadata.vehicleValues as Exclude<ConnectionDto["vehicleValues"], undefined>)
              : null,
          accounts: connection.accounts.map(account => {
            const simplefinRaw =
              connection.provider === "SIMPLEFIN" ? parseSimpleFinAccountRawJson(account.rawJson) : null;
            return stripUndefined({
              id: account.id,
              externalAccountId: account.externalAccountId,
              name: account.name,
              officialName: account.officialName,
              mask: account.mask,
              type: account.type,
              subtype: account.subtype,
              currentBalance: account.currentBalance,
              availableBalance: account.availableBalance,
              providerConnectionId: account.providerConnectionId ?? simplefinRaw?.connId ?? null,
              providerConnectionName: account.providerConnectionName ?? simplefinRaw?.connName ?? null,
              providerInstitutionName:
                simplefinRaw?.institution ??
                simplefinRaw?.connOrgName ??
                account.providerConnectionName ??
                connection.institutionName ??
                null
            });
          })
        };
      });
    },

    async createHomeValueConnection(payload) {
      return homeValues.createConnection(payload);
    },

    async updateHomeValueConnection(connectionId, payload) {
      return homeValues.updateConnection(connectionId, payload);
    },

    async createVehicleValueConnection(payload) {
      return vehicleValues.createConnection(payload);
    },

    async updateVehicleValueConnection(connectionId, payload) {
      return vehicleValues.updateConnection(connectionId, payload);
    },

    async listActualAccounts(): Promise<ActualAccountsResponseDto> {
      await reconcileActualExternalUnlinks();
      const [actualAccounts, actualCategories, links, connections] = await Promise.all([
        actual.listAccounts(),
        actual.listCategories(),
        listCurrentSyncLinks(),
        database.connection.findMany({
          include: {
            accounts: true
          }
        })
      ]);
      const actualExternalSyncPrefsByAccountId = new Map(
        await Promise.all(
          actualAccounts.map(async account => [
            account.id,
            normalizeActualExternalSyncPrefs(await getActualExternalSyncPrefs(account.id))
          ] as const)
        )
      );

      const linksByActualId = groupLinksByActualAccountId(links);
      const options: ConnectionAccountOptionDto[] = connections.flatMap(connection =>
        connection.accounts.map(account => {
          const metadata = parseConnectionMetadata(connection.metadataJson);
          const simplefinRaw = connection.provider === "SIMPLEFIN" ? parseSimpleFinAccountRawJson(account.rawJson) : {};
          return {
            connectionId: connection.id,
            connectionLabel: connection.label,
            connectionStatus: connection.status,
            connectionHealth: metadata.health ?? null,
            connectionAccountId: account.id,
            externalAccountId: account.externalAccountId,
            provider: connection.provider,
            institutionName: connection.institutionName,
            accountName: account.name,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            providerConnectionId: account.providerConnectionId ?? simplefinRaw.connId ?? null,
            providerConnectionName: account.providerConnectionName ?? simplefinRaw.connName ?? null,
            providerInstitutionName: simplefinRaw.institution ?? simplefinRaw.connOrgName ?? null
          };
        })
      );
      const categoryOptions: ActualCategoryDto[] = actualCategories.map(category => ({
        id: category.id,
        name: category.name
      }));

      const accounts: ActualAccountDto[] = [];
      for (const account of actualAccounts) {
        const link = selectCurrentLink(linksByActualId.get(account.id) || []) ?? null;

        accounts.push({
          id: account.id,
          name: account.name,
          balance: account.balance,
          offbudget: account.offbudget ?? false,
          closed: account.closed ?? false,
          actualExternalSyncPrefs: actualExternalSyncPrefsByAccountId.get(account.id) ?? DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS,
          link: toLinkDto(link, {
            actualAccountId: account.id,
            actualAccountName: account.name
          })
        });
      }

      return {
        accounts,
        options,
        actualCategories: categoryOptions
      };
    },

    async listActualBankSyncLinks(): Promise<ActualBankSyncLinkDto[]> {
      await reconcileActualExternalUnlinks();
      const [actualBankSyncLinks, links] = await Promise.all([
        actual.listBankSyncLinks(),
        listCurrentSyncLinks()
      ]);

      const linksByActualId = groupLinksByActualAccountId(links);

      return actualBankSyncLinks.map(link => {
        const currentLink = selectCurrentLink(linksByActualId.get(link.actualAccountId) || []) ?? null;
        return {
          ...link,
          currentLinkId: currentLink?.id ?? null,
          currentLinkProvider: currentLink?.provider ?? null,
          currentLinkStatus: currentLink?.status ?? null
        };
      });
    },

    async importExistingSimpleFinLinks(connectionId: string) {
      const [connection, actualBankSyncLinks, currentLinks] = await Promise.all([
        database.connection.findUniqueOrThrow({
          where: {
            id: connectionId
          },
          include: {
            accounts: true
          }
        }),
        actual.listBankSyncLinks(),
        database.accountLink.findMany({
          where: {
            status: {
              in: [...CURRENT_LINK_STATUSES]
            }
          },
          orderBy: [
            {
              updatedAt: "desc"
            },
            {
              createdAt: "desc"
            }
          ]
        })
      ]);

      if (connection.provider !== "SIMPLEFIN") {
        throw new Error("Connection is not a SimpleFIN connection");
      }

      const linksByActualId = new Map<string, typeof currentLinks>();
      for (const link of currentLinks) {
        const group = linksByActualId.get(link.actualAccountId) || [];
        group.push(link);
        linksByActualId.set(link.actualAccountId, group);
      }

      const connectionAccountsByExternalId = new Map(
        connection.accounts.map(account => [account.externalAccountId, account])
      );

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let unmatched = 0;
      const syncedActualAccountIds = new Set<string>();

      for (const actualLink of actualBankSyncLinks.filter(link => link.accountSyncSource === "simpleFin")) {
        const connectionAccount = connectionAccountsByExternalId.get(actualLink.externalAccountId);
        if (!connectionAccount) {
          unmatched += 1;
          continue;
        }

        const currentLink = selectCurrentLink(linksByActualId.get(actualLink.actualAccountId) || []) ?? null;
        if (!currentLink) {
          await database.accountLink.create({
            data: {
              status: "ACTIVE",
              actualAccountId: actualLink.actualAccountId,
              actualAccountName: actualLink.actualAccountName,
              assetType: "BANK",
              provider: "SIMPLEFIN",
              connectionId: connection.id,
              connectionAccountId: connectionAccount.id,
              syncFrequency: "MANUAL",
              isEnabled: false,
              nextSyncAt: null,
              configJson: serializeLinkConfig({})
            }
          });
          imported += 1;
          syncedActualAccountIds.add(actualLink.actualAccountId);
          continue;
        }

        if (
          currentLink.provider === "SIMPLEFIN" &&
          currentLink.connectionId === connection.id &&
          currentLink.connectionAccountId === connectionAccount.id
        ) {
          await database.accountLink.update({
            where: {
              id: currentLink.id
            },
            data: {
              actualAccountName: actualLink.actualAccountName
            }
          });
          updated += 1;
          syncedActualAccountIds.add(actualLink.actualAccountId);
          continue;
        }

        skipped += 1;
      }

      await Promise.all(
        [...syncedActualAccountIds].map(accountId => syncActualExternalWriteback({ actualAccountId: accountId }))
      );

      return {
        imported,
        updated,
        skipped,
        unmatched
      };
    },

    async createConnectionReauthSession(connectionId: string, userId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          provider: true
        }
      });

      const adapter = getProviderAdapter(connection.provider);
      if (adapter?.createReauthSession) {
        return adapter.createReauthSession({
          connectionId,
          userId
        });
      }

      if (connection.provider === "SIMPLEFIN") {
        return {
          provider: "SIMPLEFIN",
          connectionId,
          mode: "manual",
          message: "SimpleFIN requires a new setup token. Reconnect it from the SimpleFIN Connections page."
        };
      }

      throw new Error("Reauthentication is not supported for this provider");
    },

    async disconnectConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          id: true,
          provider: true,
          metadataJson: true
        }
      });

      if (isValuationProvider(connection.provider)) {
        await database.$transaction(async tx => {
          await tx.accountLink.deleteMany({
            where: {
              connectionId: connection.id
            }
          });

          await tx.connection.delete({
            where: {
              id: connection.id
            }
          });
        });
        return;
      }

      const adapter = getProviderAdapter(connection.provider);
      if (adapter?.disconnectConnection) {
        await adapter.disconnectConnection(connectionId);
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const providerKey = connection.provider.toLowerCase();
      const healthAction =
        connection.provider === "SIMPLEFIN" || connection.provider === "STRIPE"
          ? "MANUAL_RECONNECT"
          : "REAUTH_CONNECTION";
      const providerLabel =
        connection.provider === "TELLER"
          ? "Teller"
          : connection.provider === "PLAID"
            ? "Plaid"
            : connection.provider === "STRIPE"
              ? "Stripe"
            : connection.provider === "SIMPLEFIN"
              ? "SimpleFIN"
              : "Home Values";
      const healthMessage = `${providerLabel} connection was disconnected and must be reconnected.`;

      await database.$transaction(async tx => {
        await tx.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "DISCONNECTED",
            ...(connection.provider === "SIMPLEFIN"
              ? {
                  accessTokenCiphertext: encryptString("")
                }
              : {}),
            metadataJson: JSON.stringify({
              ...metadata,
              [providerKey]: {
                ...(typeof metadata[providerKey] === "object" && metadata[providerKey]
                  ? (metadata[providerKey] as Record<string, unknown>)
                  : {}),
                disconnectedAt: now().toISOString()
              },
              health: {
                state: "REAUTH_REQUIRED",
                scope: "CONNECTION_AUTH",
                action: healthAction,
                code: "DISCONNECTED",
                message: healthMessage,
                updatedAt: now().toISOString()
              }
            })
          }
        });

        await tx.accountLink.updateMany({
          where: {
            connectionId: connection.id,
            status: {
              in: ["ACTIVE", "MIGRATING"]
            }
          },
          data: {
            isEnabled: false,
            nextSyncAt: null
          }
        });
      });
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: {
          id: connectionId
        },
        select: {
          provider: true
        }
      });

      const adapter = getProviderAdapter(connection.provider);
      if (!adapter) {
        throw new Error("No provider adapter configured");
      }

      await adapter.refreshConnection(connectionId);

      if ((await getActualCapabilities()).externalSyncWritebackEnabled) {
        const linkedAccounts = await database.accountLink.findMany({
          where: {
            connectionId,
            status: {
              in: [...CURRENT_LINK_STATUSES]
            }
          },
          select: {
            actualAccountId: true
          },
          distinct: ["actualAccountId"]
        });

        await Promise.all(
          linkedAccounts.map(link => syncActualExternalWriteback({ actualAccountId: link.actualAccountId }))
        );
      }
    },

    async refreshAllConnections() {
      const connections = await database.connection.findMany({
        select: {
          id: true,
          provider: true
        },
        orderBy: {
          createdAt: "asc"
        }
      });

      await Promise.all(
        connections.map(connection => {
          const adapter = getProviderAdapter(connection.provider);
          if (!adapter) {
            return Promise.resolve();
          }

          return adapter.refreshConnection(connection.id);
        })
      );
    },

    async upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload) {
      const currentLink = await database.accountLink.findFirst({
        where: {
          actualAccountId,
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        orderBy: [
          {
            status: "asc"
          },
          {
            updatedAt: "desc"
          },
          {
            createdAt: "desc"
          }
        ]
      });

      const mappingChanged = linkIdentityChanged(currentLink, payload);
      const existingConfig = parseLinkConfig(currentLink?.configJson);
      const normalizedSchedulePayload = await normalizeAccountLinkPayload(payload, currentLink);
      const nextConfig = stripUndefined({
        providerSyncState: mappingChanged ? undefined : existingConfig.providerSyncState,
        health: mappingChanged ? null : existingConfig.health ?? null,
        categoryMappings: mappingChanged ? [] : payload.categoryMappings,
        seenCategoryNames: mappingChanged ? [] : existingConfig.seenCategoryNames || []
      }) satisfies LinkConfigData;

      const hasHistoricalImports = currentLink
        ? (await database.importedTransaction.count({
            where: {
              accountLinkId: currentLink.id
            }
          })) > 0
        : false;
      const shouldReplaceCurrentLink =
        Boolean(currentLink) &&
        Boolean(currentLink?.provider) &&
        Boolean(payload.provider) &&
        mappingChanged &&
        (hasHistoricalImports || Boolean(currentLink?.lastSyncedAt));

      if (!currentLink) {
        const created = await database.accountLink.create({
          data: {
            status: "ACTIVE",
            actualAccountId,
            actualAccountName: normalizedSchedulePayload.actualAccountName,
            assetType: normalizedSchedulePayload.assetType,
            writeMode: normalizedSchedulePayload.writeMode,
            snapshotHistory: normalizedSchedulePayload.snapshotHistory,
            provider: toPrismaProvider(normalizedSchedulePayload.provider ?? null),
            connectionId: normalizedSchedulePayload.connectionId ?? null,
            connectionAccountId: normalizedSchedulePayload.connectionAccountId ?? null,
            syncFrequency: normalizedSchedulePayload.syncFrequency,
            syncHour: normalizedSchedulePayload.syncHour ?? null,
            syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
            isEnabled: normalizedSchedulePayload.isEnabled,
            nextSyncAt: getPersistedNextSyncAt({
              syncFrequency: normalizedSchedulePayload.syncFrequency,
              syncHour: normalizedSchedulePayload.syncHour ?? null,
              syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
              isEnabled: normalizedSchedulePayload.isEnabled,
              lastSyncedAt: null
            }),
            configJson: serializeLinkConfig(nextConfig)
          }
        });
        await syncActualExternalWriteback({ actualAccountId });
        return created;
      }

      if (!shouldReplaceCurrentLink) {
        const updated = await database.accountLink.update({
          where: {
            id: currentLink.id
          },
          data: {
            actualAccountName: normalizedSchedulePayload.actualAccountName,
            assetType: normalizedSchedulePayload.assetType,
            writeMode: normalizedSchedulePayload.writeMode,
            snapshotHistory: normalizedSchedulePayload.snapshotHistory,
            provider: toPrismaProvider(normalizedSchedulePayload.provider ?? null),
            connectionId: normalizedSchedulePayload.connectionId ?? null,
            connectionAccountId: normalizedSchedulePayload.connectionAccountId ?? null,
            syncFrequency: normalizedSchedulePayload.syncFrequency,
            syncHour: normalizedSchedulePayload.syncHour ?? null,
            syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
            isEnabled: normalizedSchedulePayload.isEnabled,
            nextSyncAt: getPersistedNextSyncAt({
              syncFrequency: normalizedSchedulePayload.syncFrequency,
              syncHour: normalizedSchedulePayload.syncHour ?? null,
              syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
              isEnabled: normalizedSchedulePayload.isEnabled,
              lastSyncedAt: currentLink.lastSyncedAt
            }),
            configJson: serializeLinkConfig(nextConfig)
          }
        });
        await syncActualExternalWriteback({ actualAccountId });
        return updated;
      }

      const timestamp = now();
      const replacement = await database.$transaction(async tx => {
        const replacement = await tx.accountLink.create({
          data: {
            status: "MIGRATING",
            actualAccountId,
            actualAccountName: normalizedSchedulePayload.actualAccountName,
            assetType: normalizedSchedulePayload.assetType,
            writeMode: normalizedSchedulePayload.writeMode,
            snapshotHistory: normalizedSchedulePayload.snapshotHistory,
            provider: toPrismaProvider(normalizedSchedulePayload.provider ?? null),
            connectionId: normalizedSchedulePayload.connectionId ?? null,
            connectionAccountId: normalizedSchedulePayload.connectionAccountId ?? null,
            syncFrequency: normalizedSchedulePayload.syncFrequency,
            syncHour: normalizedSchedulePayload.syncHour ?? null,
            syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
            isEnabled: normalizedSchedulePayload.isEnabled,
            nextSyncAt: getPersistedNextSyncAt({
              syncFrequency: normalizedSchedulePayload.syncFrequency,
              syncHour: normalizedSchedulePayload.syncHour ?? null,
              syncDayOfWeek: normalizedSchedulePayload.syncDayOfWeek ?? null,
              isEnabled: normalizedSchedulePayload.isEnabled,
              lastSyncedAt: null
            }),
            migrationStartedAt: timestamp,
            configJson: serializeLinkConfig(nextConfig)
          }
        });

        await tx.accountLink.update({
          where: {
            id: currentLink.id
          },
          data: {
            status: "INACTIVE",
            isEnabled: false,
            nextSyncAt: null,
            supersededAt: timestamp,
            replacedByLinkId: replacement.id
          }
        });

        return replacement;
      });
      await syncActualExternalWriteback({ actualAccountId });
      return replacement;
    },

    async listRequestedExternalSyncAccountIds() {
      const capabilities = await getActualCapabilities();
      if (!capabilities.externalSyncStatusEnabled || typeof actual.updateExternalSyncAccountStatus !== "function") {
        return [];
      }

      const requestedActualAccountIds = [
        ...new Set(
          (await actual.listBankSyncLinks())
            .filter(
              link => link.accountSyncSource === "external" && link.bankSyncStatus === "sync-requested"
            )
            .map(link => link.actualAccountId)
        )
      ];

      if (requestedActualAccountIds.length > 0) {
        console.info(
          `[actual-sync] Observed sync-requested for ${requestedActualAccountIds.length} account(s): ${requestedActualAccountIds.join(", ")}`,
        );
      }

      return requestedActualAccountIds;
    },

    async runRequestedExternalSync(actualAccountId: string) {
      await runRequestedExternalSync(actualAccountId);
    },

    async runRequestedExternalSyncs() {
      const requestedActualAccountIds = await appService.listRequestedExternalSyncAccountIds();

      for (const actualAccountId of requestedActualAccountIds) {
        await runRequestedExternalSync(actualAccountId);
      }

      return requestedActualAccountIds;
    },

    async runAccountSync(actualAccountId: string) {
      const link = await loadCurrentSyncLink(actualAccountId);
      const syncRun = await createSyncRunForLink(link);
      const adapter = getProviderAdapter(link.provider);
      if (!adapter) {
        await database.syncRun.update({
          where: {
            id: syncRun.id
          },
          data: {
            status: "SKIPPED",
            finishedAt: now(),
            summary: "No provider configured"
          }
        });
        return;
      }

      try {
        await markActualExternalSyncPending(link.actualAccountId);
        const syncResult = await adapter.syncAccountLink(link.id);
        return await applySyncResultToLink({
          link,
          syncRunId: syncRun.id,
          syncResult
        });
      } catch (error) {
        await markSyncRunFailure({
          link,
          syncRunId: syncRun.id,
          error
        });
        throw error;
      }
    },

    async runScheduledLinkSyncs(linkIds: string[]) {
      if (linkIds.length === 0) {
        return;
      }

      const links = await database.accountLink.findMany({
        where: {
          id: {
            in: linkIds
          },
          status: {
            in: [...CURRENT_LINK_STATUSES]
          }
        },
        include: currentLinkInclude,
        orderBy: [
          {
            provider: "asc"
          },
          {
            connectionId: "asc"
          },
          {
            updatedAt: "desc"
          }
        ]
      });

      await runLoadedLinkSyncBatch(links);
    },

    async handlePlaidWebhook(event: PlaidWebhookEvent) {
      if (event.webhook_type !== "TRANSACTIONS" || event.webhook_code !== "SYNC_UPDATES_AVAILABLE") {
        return;
      }

      if (!event.item_id) {
        return;
      }

      const connection = await database.connection.findUnique({
        where: {
          provider_providerItemId: {
            provider: "PLAID",
            providerItemId: event.item_id
          }
        }
      });

      if (!connection) {
        return;
      }

      const activeSync = activePlaidWebhookSyncs.get(connection.id);
      if (activeSync) {
        activeSync.pending = true;
        const queuedAt = now().toISOString();
        await updatePlaidWebhookMetadata({
          connectionId: connection.id,
          event,
          nowIso: queuedAt,
          extra: {
            lastWebhookSyncQueuedAt: queuedAt,
            lastWebhookSkipReason: "coalesced"
          }
        });
        return;
      }

      activePlaidWebhookSyncs.set(connection.id, {
        pending: false
      });

      try {
        while (true) {
          const startedAt = now().toISOString();
          await updatePlaidWebhookMetadata({
            connectionId: connection.id,
            event,
            nowIso: startedAt,
            extra: {
              lastWebhookSyncStartedAt: startedAt,
              lastWebhookSyncQueuedAt: null,
              lastWebhookSkipReason: null
            }
          });

          const eligibleLinks = await database.accountLink.findMany({
            where: {
              connectionId: connection.id,
              provider: "PLAID",
              status: "ACTIVE",
              isEnabled: true,
              syncFrequency: {
                not: "MANUAL"
              }
            },
            include: currentLinkInclude
          });

          if (eligibleLinks.length === 0) {
            await updatePlaidWebhookMetadata({
              connectionId: connection.id,
              event,
              nowIso: startedAt,
              extra: {
                lastWebhookSyncSkippedAt: startedAt,
                lastWebhookSkipReason: "no_eligible_links"
              }
            });
          } else {
            for (const link of eligibleLinks) {
              const syncRun = await createSyncRunForLink(link);

              try {
                const syncResult = await runWithProviderBackgroundGate("PLAID", () => plaid.syncAccountLink(link.id));
                await applySyncResultToLink({
                  link,
                  syncRunId: syncRun.id,
                  syncResult
                });
              } catch (error) {
                await markSyncRunFailure({
                  link,
                  syncRunId: syncRun.id,
                  error,
                  automatic: true
                });
              }
            }

            const latestConnection = await database.connection.findUniqueOrThrow({
              where: {
                id: connection.id
              },
              select: {
                metadataJson: true
              }
            });
            const latestMetadata = parseConnectionMetadata(latestConnection.metadataJson);
            const latestPlaidMetadata = getPlaidMetadata(latestMetadata);

            await database.connection.update({
              where: {
                id: connection.id
              },
              data: {
                metadataJson: JSON.stringify({
                  ...latestMetadata,
                  plaid: {
                    ...latestPlaidMetadata,
                    lastWebhookSyncedAt: now().toISOString()
                  }
                })
              }
            });
          }

          const nextSync = activePlaidWebhookSyncs.get(connection.id);
          if (!nextSync?.pending) {
            break;
          }

          nextSync.pending = false;
        }
      } finally {
        activePlaidWebhookSyncs.delete(connection.id);
      }
    },

    async handleTellerWebhook(event: TellerWebhookEvent) {
      if (event.type === "webhook.test") {
        return;
      }

      const enrollmentId = event.payload.enrollment_id;
      if (!enrollmentId) {
        return;
      }

      const connection = await database.connection.findUnique({
        where: {
          provider_providerItemId: {
            provider: "TELLER",
            providerItemId: enrollmentId
          }
        },
        select: {
          id: true,
          metadataJson: true
        }
      });

      if (!connection) {
        return;
      }

      if (event.type === "enrollment.disconnected") {
        const metadata = parseConnectionMetadata(connection.metadataJson);
        const disconnectReason = event.payload.reason ?? "Teller enrollment disconnected";
        const disconnectHealthState =
          disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
            ? "ATTENTION_REQUIRED"
            : "REAUTH_REQUIRED";

        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "DISCONNECTED",
            metadataJson: JSON.stringify({
              ...metadata,
              health: {
                state: disconnectHealthState,
                scope: disconnectReason.includes("credentials") || disconnectReason.includes("mfa") || disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
                  ? "BANK_AUTH"
                  : "CONNECTION_AUTH",
                action: disconnectReason.includes("credentials") || disconnectReason.includes("mfa") || disconnectReason.includes("user_action") || disconnectReason.includes("account_locked")
                  ? "REAUTH_BANK"
                  : "REAUTH_CONNECTION",
                code: "DISCONNECTED",
                message: disconnectReason,
                updatedAt: event.timestamp
              },
              teller: {
                ...(typeof metadata.teller === "object" && metadata.teller ? (metadata.teller as object) : {}),
                lastDisconnectReason: event.payload.reason ?? null,
                lastWebhookAt: event.timestamp
              }
            })
          }
        });

        await database.accountLink.updateMany({
          where: {
            connectionId: connection.id,
            status: {
              in: ["ACTIVE", "MIGRATING"]
            }
          },
          data: {
            isEnabled: false,
            nextSyncAt: null
          }
        });
        return;
      }

      if (event.type !== "transactions.processed") {
        return;
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const tellerMetadata = getTellerMetadata(metadata);
      const nowIso = now().toISOString();
      const lastWebhookSyncStartedAt =
        typeof tellerMetadata.lastWebhookSyncStartedAt === "string" ? tellerMetadata.lastWebhookSyncStartedAt : null;
      const effectiveSettings = await getEffectiveProviderSettings();
      if (effectiveSettings.TELLER.webhookSyncDebounceSeconds > 0 && lastWebhookSyncStartedAt) {
        const debounceMs = effectiveSettings.TELLER.webhookSyncDebounceSeconds * 1000;
        const lastSyncMs = Date.parse(lastWebhookSyncStartedAt);
        if (Number.isFinite(lastSyncMs) && now().getTime() - lastSyncMs < debounceMs) {
          await database.connection.update({
            where: {
              id: connection.id
            },
            data: {
              metadataJson: JSON.stringify({
                ...metadata,
                teller: {
                  ...tellerMetadata,
                  lastWebhookAt: event.timestamp,
                  lastWebhookSkippedAt: nowIso,
                  lastWebhookSkipReason: "debounced"
                }
              })
            }
          });
          return;
        }
      }

      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          metadataJson: JSON.stringify({
            ...metadata,
            teller: {
              ...tellerMetadata,
              lastWebhookAt: event.timestamp,
              lastWebhookSyncStartedAt: nowIso
            }
          })
        }
      });

      const eligibleLinks = await database.accountLink.findMany({
        where: {
          connectionId: connection.id,
          provider: "TELLER",
          status: "ACTIVE",
          isEnabled: true,
          syncFrequency: {
            not: "MANUAL"
          }
        },
        select: {
          id: true
        }
      });

      await this.runScheduledLinkSyncs(eligibleLinks.map(link => link.id));
    },

    async handleStripeWebhook(event: Stripe.Event) {
      if (!event.type.startsWith("financial_connections.account.")) {
        return;
      }

      const account = event.data.object;
      if (!account || typeof account !== "object" || !("object" in account) || account.object !== "financial_connections.account") {
        return;
      }

      const connection = await findStripeConnectionForWebhook(account);
      if (!connection) {
        return;
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const stripeMetadata = getStripeMetadata(metadata);
      const existingAccountIds = Array.isArray(stripeMetadata.accountIds)
        ? stripeMetadata.accountIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      const nextAccountIds = account.id ? [...new Set([...existingAccountIds, account.id])] : existingAccountIds;
      const webhookTimestamp = getStripeWebhookTimestamp(event);
      const nextStripeMetadata = {
        ...stripeMetadata,
        accountIds: nextAccountIds,
        authorizationId:
          typeof account.authorization === "string"
            ? account.authorization
            : typeof stripeMetadata.authorizationId === "string"
              ? stripeMetadata.authorizationId
              : connection.providerItemId ?? null,
        lastWebhookAt: webhookTimestamp,
        lastWebhookEventId: event.id,
        lastWebhookType: event.type
      };

      if (event.type === "financial_connections.account.deactivated") {
        const authorization =
          typeof account.authorization === "string" ? await stripe.getAuthorization(account.authorization) : null;
        const relinkRequired =
          authorization?.status === "inactive" &&
          authorization.status_details.inactive?.action === "relink_required";

        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...nextStripeMetadata,
                lastDeactivatedAt: webhookTimestamp
              },
              health: {
                state: relinkRequired ? "REAUTH_REQUIRED" : "ATTENTION_REQUIRED",
                scope: "BANK_AUTH",
                action: "MANUAL_RECONNECT",
                code: relinkRequired ? "ACCOUNT_RELINK_REQUIRED" : "ACCOUNT_INACTIVE",
                message: relinkRequired
                  ? "Stripe account needs to be reauthenticated."
                  : "Stripe Financial Connections account became inactive.",
                updatedAt: webhookTimestamp
              }
            })
          }
        });
        return;
      }

      if (event.type === "financial_connections.account.reactivated") {
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "ACTIVE",
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...nextStripeMetadata,
                lastReactivatedAt: webhookTimestamp
              },
              health: clearSyncHealth()
            })
          }
        });
        return;
      }

      if (event.type === "financial_connections.account.disconnected") {
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            status: "DISCONNECTED",
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...nextStripeMetadata,
                lastDisconnectedAt: webhookTimestamp
              },
              health: {
                state: "REAUTH_REQUIRED",
                scope: "CONNECTION_AUTH",
                action: "MANUAL_RECONNECT",
                code: "ACCOUNT_DISCONNECTED",
                message: "Stripe Financial Connections account was disconnected.",
                updatedAt: webhookTimestamp
              }
            })
          }
        });

        await database.accountLink.updateMany({
          where: {
            connectionId: connection.id,
            status: {
              in: ["ACTIVE", "MIGRATING"]
            }
          },
          data: {
            isEnabled: false,
            nextSyncAt: null
          }
        });
        return;
      }

      if (event.type === "financial_connections.account.created") {
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...nextStripeMetadata,
                lastCreatedAt: webhookTimestamp
              }
            })
          }
        });
        return;
      }

      const refreshMetadata =
        event.type === "financial_connections.account.refreshed_balance"
          ? {
              lastBalanceRefreshWebhookAt: webhookTimestamp,
              lastBalanceRefreshStatus: account.balance_refresh?.status ?? null
            }
          : event.type === "financial_connections.account.refreshed_ownership"
            ? {
                lastOwnershipRefreshWebhookAt: webhookTimestamp,
                lastOwnershipRefreshStatus: account.ownership_refresh?.status ?? null
              }
            : event.type === "financial_connections.account.refreshed_transactions"
              ? {
                  lastTransactionRefreshWebhookAt: webhookTimestamp,
                  lastTransactionRefreshId: account.transaction_refresh?.id ?? null,
                  lastTransactionRefreshStatus: account.transaction_refresh?.status ?? null
                }
              : null;

      if (!refreshMetadata) {
        return;
      }

      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          metadataJson: JSON.stringify({
            ...metadata,
            stripe: {
              ...nextStripeMetadata,
              ...refreshMetadata
            }
          })
        }
      });

      if (event.type !== "financial_connections.account.refreshed_transactions" || account.transaction_refresh?.status !== "succeeded") {
        return;
      }

      const refreshId = account.transaction_refresh?.id ?? null;
      if (!refreshId) {
        return;
      }

      const eligibleLinks = await database.accountLink.findMany({
        where: {
          connectionId: connection.id,
          provider: "STRIPE",
          status: "ACTIVE",
          isEnabled: true,
          syncFrequency: {
            not: "MANUAL"
          },
          connectionAccount: {
            is: {
              externalAccountId: account.id
            }
          }
        },
        include: currentLinkInclude
      });

      const pendingLinks = eligibleLinks.filter(link => parseLinkConfig(link.configJson).providerSyncState?.cursor !== refreshId);
      if (pendingLinks.length === 0) {
        await database.connection.update({
          where: {
            id: connection.id
          },
          data: {
            metadataJson: JSON.stringify({
              ...metadata,
              stripe: {
                ...nextStripeMetadata,
                ...refreshMetadata,
                lastTransactionWebhookSyncSkippedAt: now().toISOString(),
                lastTransactionWebhookSyncSkipReason: "cursor_already_applied"
              }
            })
          }
        });
        return;
      }

      const webhookSyncStartedAt = now().toISOString();
      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          metadataJson: JSON.stringify({
            ...metadata,
            stripe: {
              ...nextStripeMetadata,
              ...refreshMetadata,
              lastTransactionWebhookSyncStartedAt: webhookSyncStartedAt,
              lastTransactionWebhookSyncRefreshId: refreshId
            }
          })
        }
      });

      for (const link of pendingLinks) {
        const syncRun = await createSyncRunForLink(link);

        try {
          const syncResult = await runWithProviderBackgroundGate("STRIPE", () => stripe.syncAccountLinkFromWebhook(link.id));
          await applySyncResultToLink({
            link,
            syncRunId: syncRun.id,
            syncResult
          });
        } catch (error) {
          await markSyncRunFailure({
            link,
            syncRunId: syncRun.id,
            error,
            automatic: true
          });
        }
      }

      const latestConnection = await database.connection.findUniqueOrThrow({
        where: {
          id: connection.id
        },
        select: {
          metadataJson: true
        }
      });
      const latestMetadata = parseConnectionMetadata(latestConnection.metadataJson);

      await database.connection.update({
        where: {
          id: connection.id
        },
        data: {
          metadataJson: JSON.stringify({
            ...latestMetadata,
            stripe: {
              ...getStripeMetadata(latestMetadata),
              lastTransactionWebhookSyncedAt: now().toISOString(),
              lastTransactionWebhookSyncRefreshId: refreshId
            }
          })
        }
      });
    },

    previewAccountSyncReview: syncReviewService.previewAccountSyncReview,

    commitAccountSyncReview: syncReviewService.commitAccountSyncReview,

    async listSyncRuns(limit = 20): Promise<SyncRunDto[]> {
      const runs = await database.syncRun.findMany({
      orderBy: {
        startedAt: "desc"
      },
      take: limit
    });

      return runs.map(run => ({
      id: run.id,
      accountLinkId: run.accountLinkId,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      summary: run.summary,
      error: run.error
      }));
    }
  };

  return appService;
}

export const appService = createAppService();
