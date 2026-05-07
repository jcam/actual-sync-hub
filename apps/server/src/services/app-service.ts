import type {
  ActualAccountDto,
  ActualBankSyncLinkDto,
  ActualCategoryDto,
  ActualExternalSyncStatusDto,
  CommitMigrationPayload,
  ConnectionReauthSessionDto,
  ConnectionAccountOptionDto,
  ConnectionDto,
  ExternalSyncBridgeSyncResponseDto,
  MigrationPreviewDto,
  Provider,
  RuntimeInfoDto,
  SyncRunDto,
  UpsertHomeValueConnectionPayload,
  UpdateAccountLinkPayload
} from "@actual-sync/shared";
import {
  getActivePlaidEnvironmentSettings,
  getActiveSimpleFinModeSettings,
  getActiveTellerEnvironmentSettings
} from "@actual-sync/shared";
import type { Prisma, Provider as PrismaProvider } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { encryptString } from "../lib/crypto.js";
import { actualService } from "./actual-service.js";
import type {
  ActualExternalSyncMetadataInput,
  ReconcileTransactionInput
} from "./actual-service.js";
import { getTellerMetadata, parseConnectionMetadata } from "./connection-metadata.js";
import { learnCategoryMappingsFromHistory, pruneImportedTransactionLedger } from "./imported-transaction-ledger.js";
import { CURRENT_LINK_STATUSES, linkIdentityChanged, parseLinkConfig, selectCurrentLink, serializeLinkConfig, toLinkDto } from "./link-config.js";
import type { LinkConfigData } from "./link-config.js";
import { plaidService } from "./plaid-service.js";
import type { PlaidService } from "./plaid-service.js";
import {
  applyActualExternalSyncPrefsToProviderSyncResult,
  DEFAULT_ACTUAL_EXTERNAL_SYNC_PREFS,
  getPrimarySourceCategory,
  normalizeActualExternalSyncPrefs,
  resolveTransactionCategoryId,
  resolveTransferActualAccountId
} from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import { parseSimpleFinAccountRawJson } from "./simplefin-native-metadata.js";
import { simplefinService } from "./simplefin-service.js";
import type { SimpleFinService } from "./simplefin-service.js";
import { createSyncReviewService } from "./sync-review-service.js";
import { tellerService } from "./teller-service.js";
import type { TellerService, TellerWebhookEvent } from "./teller-service.js";
import type { ProviderAdapter, ProviderSyncOutcome, ProviderSyncResult, ProviderSyncTransaction } from "./provider-adapter.js";
import { clearSyncHealth, isBlockingSyncHealth, isRateLimitedSyncError, toSyncHealth } from "./sync-health.js";
import { homeValuesService } from "./home-values-service.js";
import type { HomeValuesService } from "./home-values-service.js";

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

function toPrismaProvider(provider: Provider | null | undefined): PrismaProvider | null | undefined {
  return provider as PrismaProvider | null | undefined;
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

export type AppService = {
  getRuntimeInfo(): Promise<RuntimeInfoDto>;
  listConnections(): Promise<ConnectionDto[]>;
  listActualAccounts(): Promise<ActualAccountDto[]>;
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
  disconnectConnection(connectionId: string): Promise<void>;
  refreshConnection(connectionId: string): Promise<void>;
  refreshAllConnections(): Promise<void>;
  upsertAccountLink(actualAccountId: string, payload: UpdateAccountLinkPayload): Promise<unknown>;
  runAccountSync(actualAccountId: string): Promise<AppliedSyncOutcome | void>;
  runScheduledLinkSyncs(linkIds: string[]): Promise<void>;
  handleTellerWebhook(event: TellerWebhookEvent): Promise<void>;
  previewAccountSyncReview(actualAccountId: string): Promise<MigrationPreviewDto>;
  commitAccountSyncReview(actualAccountId: string, payload: CommitMigrationPayload): Promise<void>;
  listSyncRuns(limit?: number): Promise<SyncRunDto[]>;
  getExternalSyncBridgeStatus(actualAccountId?: string): Promise<ActualExternalSyncStatusDto>;
  runExternalSyncBridgeSync(actualAccountId: string): Promise<ExternalSyncBridgeSyncResponseDto>;
}

export function createAppService({
  prisma: database = prisma,
  actualService: actual = actualService,
  homeValuesService: homeValues = homeValuesService,
  plaidService: plaid = plaidService,
  providerSettingsService: settings = createProviderSettingsService({ prisma: database }),
  simplefinService: simplefin = simplefinService,
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
  plaidService?: PlaidService;
  providerSettingsService?: ProviderSettingsService;
  simplefinService?: SimpleFinService;
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
    TELLER: teller
  } satisfies Record<Provider, ProviderAdapter>;
  const providerBackgroundSyncGates = new Map<Provider, ProviderBackgroundSyncGate>();
  const getEffectiveProviderSettings = () => settings.getAll();
  let actualCapabilitiesPromise: Promise<{
    externalSyncWritebackEnabled: boolean;
  }> | null = null;

  const getActualCapabilities = () => {
    if (!actualCapabilitiesPromise) {
      actualCapabilitiesPromise = (async () => {
        if (typeof actual.getCapabilities === "function") {
          return await actual.getCapabilities();
        }

        return {
          externalSyncWritebackEnabled:
            typeof actual.linkExternalSyncAccount === "function" &&
            typeof actual.getExternalSyncAccount === "function" &&
            typeof actual.unlinkExternalSyncAccount === "function"
        };
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

  const isProviderConfigured = async (provider: Provider) => {
    const providerSettings = await getEffectiveProviderSettings();

    if (provider === "HOME_VALUES") {
      return true;
    }

    if (provider === "PLAID") {
      const activePlaidSettings = getActivePlaidEnvironmentSettings(providerSettings.PLAID);
      return Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
    }

    if (provider === "TELLER") {
      return Boolean(getActiveTellerEnvironmentSettings(providerSettings.TELLER).appId);
    }

    return true;
  };

  const getProviderRuntimeInfo = async (): Promise<RuntimeInfoDto["providers"]> => {
    const providerSettings = await getEffectiveProviderSettings();
    const plaidEnvironment = providerSettings.PLAID.environment;
    const activePlaidSettings = getActivePlaidEnvironmentSettings(providerSettings.PLAID);
    const plaidEnabled = Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
    const plaidSandboxToolsEnabled = plaidEnvironment === "sandbox";
    const activeTellerSettings = getActiveTellerEnvironmentSettings(providerSettings.TELLER);
    const tellerEnabled = Boolean(activeTellerSettings.appId);
    const tellerEnvironment = providerSettings.TELLER.environment;
    const tellerMtlsConfigured =
      tellerEnvironment === "sandbox" ||
      Boolean(
        ("certificatePem" in activeTellerSettings ? activeTellerSettings.certificatePem : "") &&
          ("keyPem" in activeTellerSettings ? activeTellerSettings.keyPem : "")
      );
    const simpleFinMode = providerSettings.SIMPLEFIN.mode;
    const simpleFinDevelopmentConfigured =
      simpleFinMode !== "development" || Boolean(getActiveSimpleFinModeSettings(providerSettings.SIMPLEFIN)?.serverUrl);

    return [
      {
        provider: "HOME_VALUES",
        label: "Home Values",
        enabled: true,
        ready: true,
        environment: null,
        issues: [],
        notes: ["Use manually entered Redfin and Zillow estimates to keep an off-budget asset account current."]
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

  const runWithProviderBackgroundGate = async <T>(provider: Provider, task: () => Promise<T>) => {
    const providerSettings = await getEffectiveProviderSettings();
    const dynamicAutomaticSyncConcurrency: AutomaticSyncConcurrencyConfig = {
      HOME_VALUES: providerSettings.HOME_VALUES?.automaticSyncConcurrency ?? 1,
      PLAID: providerSettings.PLAID.automaticSyncConcurrency,
      TELLER: providerSettings.TELLER.automaticSyncConcurrency,
      SIMPLEFIN: providerSettings.SIMPLEFIN.automaticSyncConcurrency
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

      return {
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
      };
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
    if (!(await getActualCapabilities()).externalSyncWritebackEnabled) {
      return;
    }

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

    const linksByActualId = groupLinksByActualAccountId(links);

    const trackedCurrentLinks = [...linksByActualId.values()]
      .map(group => selectCurrentLink(group))
      .filter((link): link is NonNullable<typeof link> => Boolean(link))
      .filter(link => parseLinkConfig(link.configJson).actualExternalLinked === true);

    if (trackedCurrentLinks.length === 0) {
      return;
    }

    const actualBankSyncLinks = await actual.listBankSyncLinks();
    const actualExternalLinkedAccountIds = new Set(
      actualBankSyncLinks
        .filter(link => link.accountSyncSource === "external")
        .map(link => link.actualAccountId)
    );

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

  const syncActualExternalWriteback = async ({
    actualAccountId,
    lastSync
  }: {
    actualAccountId: string;
    lastSync?: string | null;
  }): Promise<void> => {
    if (!(await getActualCapabilities()).externalSyncWritebackEnabled) {
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

    await actual.linkExternalSyncAccount(actualAccountId, {
      ...current.metadata,
      lastSync: lastSync ?? current.metadata.lastSync ?? null
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
    link: Pick<SyncableLink, "id" | "configJson">;
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
    const actualCategories = (await actual.listCategories()).map(category => ({
      id: category.id,
      name: category.name
    }));
    const actualExternalSyncPrefs = normalizeActualExternalSyncPrefs(
      await getActualExternalSyncPrefs(link.actualAccountId)
    );
    syncResult = applyActualExternalSyncPrefsToProviderSyncResult(syncResult, actualExternalSyncPrefs);
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
    const reconcileTransactions: ReconcileTransactionInput[] = buildReconcileTransactions({
      actualAccountId: link.actualAccountId,
      actualCategories,
      linkConfig,
      siblingLinks,
      transactions: syncResult.transactions
    });
    const removedImportedIds = syncResult.removedImportedIds.filter(
      importedId => !reconcileTransactions.some(transaction => transaction.imported_id === importedId)
    );
    const migrating = link.status === "MIGRATING";
    const migrationImportPayload = reconcileTransactions.map(transaction => ({
      date: transaction.date,
      amount: transaction.amount,
      payee_name: transaction.payee_name,
      imported_payee: transaction.imported_payee,
      notes: transaction.notes,
      imported_id: transaction.imported_id,
      cleared: transaction.cleared,
      category: transaction.resolved_category_id,
      transfer_actual_account_id: transaction.transfer_actual_account_id
    }));
    const migrationResult = migrating
      ? await actual.importTransactions(link.actualAccountId, migrationImportPayload, {
          reimportDeleted: actualExternalSyncPrefs.reimportDeleted,
          updateDates: actualExternalSyncPrefs.updateDates
        })
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
    const reconcileResult = !migrating && (reconcileTransactions.length || removedImportedIds.length)
      ? await actual.reconcileTransactions(
          link.actualAccountId,
          reconcileTransactions,
          removedImportedIds,
          removedActualTransactionIds,
          {
            reimportDeleted: actualExternalSyncPrefs.reimportDeleted,
            updateDates: actualExternalSyncPrefs.updateDates
          }
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
      await Promise.all(
        reconcileTransactions.map((transaction, index) =>
          database.importedTransaction.upsert({
            where: {
              accountLinkId_importedId: {
                accountLinkId: link.id,
                importedId: transaction.imported_id
              }
            },
            update: {
              transactionDate: transaction.date,
              actualTransactionId: importedTransactionByImportedId.get(transaction.imported_id)?.id ?? null,
              primarySourceCategory: getPrimarySourceCategory(syncResult.transactions[index]!),
              appliedCategoryId: transaction.resolved_category_id ?? null,
              lastSeenAt: now()
            },
            create: {
              accountLinkId: link.id,
              importedId: transaction.imported_id,
              transactionDate: transaction.date,
              actualTransactionId: importedTransactionByImportedId.get(transaction.imported_id)?.id ?? null,
              primarySourceCategory: getPrimarySourceCategory(syncResult.transactions[index]!),
              appliedCategoryId: transaction.resolved_category_id ?? null,
              observedCategoryId: transaction.resolved_category_id ?? null,
              lastSeenAt: now()
            }
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

    await pruneImportedTransactionLedger({
      database,
      accountLinkId: link.id,
      now: now()
    });

    const syncCompletedAt = now();
    await database.accountLink.update({
      where: {
        id: link.id
      },
      data: {
        status: migrating ? "ACTIVE" : link.status,
        lastSyncedAt: syncCompletedAt,
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
            ...syncResult.transactions.flatMap(transaction => transaction.categoryNames || [])
          ]
        })
      }
    });

    await syncActualExternalWriteback({
      actualAccountId: link.actualAccountId,
      lastSync: toActualLastSyncValue(syncCompletedAt)
    });

    const summary = migrating
      ? `Migration sync imported ${migrationResult?.added.length ?? 0} transactions, updated ${migrationResult?.updated.length ?? 0}, removed 0.`
      : `Imported ${reconcileResult?.added ?? 0} transactions, updated ${reconcileResult?.updated ?? 0}, removed ${reconcileResult?.removed ?? 0}.`;
    const newTransactions = migrating
      ? migrationResult?.added ?? []
      : reconcileResult?.addedIds ?? [];
    const matchedTransactions = migrating
      ? migrationResult?.updated ?? []
      : reconcileResult?.updatedIds ?? [];
    const updatedAccounts =
      newTransactions.length > 0 || matchedTransactions.length > 0 || removedImportedIds.length > 0
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
  }): ActualExternalSyncStatusDto => {
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

  const getExternalSyncBridgeStatus = async (actualAccountId?: string): Promise<ActualExternalSyncStatusDto> => {
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

  const runExternalSyncBridgeSync = async (actualAccountId: string): Promise<ExternalSyncBridgeSyncResponseDto> => {
    const status = await getExternalSyncBridgeStatus(actualAccountId);
    if (!status.configured) {
      return {
        error_code: "NOT_CONFIGURED",
        error_type: "EXTERNAL_SYNC",
        message: status.message ?? "No external sync link is configured for this account.",
        lastSync: status.lastSync ?? null,
        newTransactions: [],
        matchedTransactions: [],
        updatedAccounts: []
      };
    }

    if (status.needsReauth) {
      return {
        error_code: "REAUTH_REQUIRED",
        error_type: "EXTERNAL_SYNC",
        message: status.message ?? "Bank credentials need to be refreshed.",
        lastSync: status.lastSync ?? null,
        newTransactions: [],
        matchedTransactions: [],
        updatedAccounts: []
      };
    }

    if (!status.canSync) {
      return {
        error_code: "SYNC_FAILED",
        error_type: "EXTERNAL_SYNC",
        message: status.message ?? "External sync is not currently available for this account.",
        lastSync: status.lastSync ?? null,
        newTransactions: [],
        matchedTransactions: [],
        updatedAccounts: []
      };
    }

    try {
      const outcome = await appService.runAccountSync(actualAccountId);
      return {
        message: outcome?.summary ?? "Sync completed.",
        lastSync: outcome?.lastSync ?? status.lastSync ?? null,
        newTransactions: outcome?.newTransactions ?? [],
        matchedTransactions: outcome?.matchedTransactions ?? [],
        updatedAccounts: outcome?.updatedAccounts ?? []
      };
    } catch (error) {
      const nextStatus = await getExternalSyncBridgeStatus(actualAccountId);
      return {
        error_code: nextStatus.needsReauth ? "REAUTH_REQUIRED" : "SYNC_FAILED",
        error_type: "EXTERNAL_SYNC",
        message:
          nextStatus.message ??
          (error instanceof Error ? error.message : "External sync failed."),
        lastSync: nextStatus.lastSync ?? null,
        newTransactions: [],
        matchedTransactions: [],
        updatedAccounts: []
      };
    }
  };

  const syncReviewService = createSyncReviewService({
    database,
    actual,
    currentLinkStatuses: CURRENT_LINK_STATUSES,
    getProviderAdapter,
    buildSiblingLinks,
    buildReconcileTransactions,
    syncActualExternalWriteback,
    now
  });

  const appService: AppService = {
    async getRuntimeInfo(): Promise<RuntimeInfoDto> {
      const effectiveSettings = await getEffectiveProviderSettings();
      const actualCapabilities = await getActualCapabilities();
      const providers = await getProviderRuntimeInfo();
      const activePlaidSettings = getActivePlaidEnvironmentSettings(effectiveSettings.PLAID);
      const plaidEnabled = Boolean(activePlaidSettings.clientId && activePlaidSettings.secret);
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
          providerAccountsUrl:
            connection.provider === "SIMPLEFIN" &&
            typeof metadata.simplefin === "object" &&
            metadata.simplefin &&
            "baseUrl" in metadata.simplefin &&
            typeof metadata.simplefin.baseUrl === "string"
              ? (() => {
                  try {
                    const url = new URL(metadata.simplefin.baseUrl);
                    return `${url.origin}/my-account`;
                  } catch {
                    return null;
                  }
                })()
              : null,
          lastRefreshedAt: connection.lastRefreshedAt?.toISOString() ?? null,
          health: metadata.health ?? null,
          homeValues:
            connection.provider === "HOME_VALUES" &&
            typeof metadata.homeValues === "object" &&
            metadata.homeValues
              ? (metadata.homeValues as ConnectionDto["homeValues"])
              : null,
          accounts: connection.accounts.map(account => {
            const simplefinRaw =
              connection.provider === "SIMPLEFIN" ? parseSimpleFinAccountRawJson(account.rawJson) : {};
            return {
              id: account.id,
              externalAccountId: account.externalAccountId,
              name: account.name,
              officialName: account.officialName,
              mask: account.mask,
              type: account.type,
              subtype: account.subtype,
              currentBalance: account.currentBalance,
              availableBalance: account.availableBalance,
              providerConnectionId: account.providerConnectionId ?? simplefinRaw.connId ?? null,
              providerConnectionName: account.providerConnectionName ?? simplefinRaw.connName ?? null,
              providerInstitutionName: simplefinRaw.institution ?? simplefinRaw.connOrgName ?? null
            };
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

    async listActualAccounts(): Promise<ActualAccountDto[]> {
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

      const results: ActualAccountDto[] = [];
      for (const account of actualAccounts) {
        const link = selectCurrentLink(linksByActualId.get(account.id) || []) ?? null;

        results.push({
          id: account.id,
          name: account.name,
          balance: account.balance,
          offbudget: account.offbudget,
          closed: account.closed,
          link: toLinkDto(link, {
            actualAccountId: account.id,
            actualAccountName: account.name
          }),
          options,
          actualCategories: categoryOptions
        });
      }

      return results;
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

      const adapter = getProviderAdapter(connection.provider);
      if (adapter?.disconnectConnection) {
        await adapter.disconnectConnection(connectionId);
      }

      const metadata = parseConnectionMetadata(connection.metadataJson);
      const providerKey = connection.provider.toLowerCase();
      const healthAction =
        connection.provider === "SIMPLEFIN" || connection.provider === "HOME_VALUES"
          ? "MANUAL_RECONNECT"
          : "REAUTH_CONNECTION";
      const providerLabel =
        connection.provider === "TELLER"
          ? "Teller"
          : connection.provider === "PLAID"
            ? "Plaid"
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
            isEnabled: false
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
      const nextConfig = {
        providerSyncState: mappingChanged ? undefined : existingConfig.providerSyncState,
        health: mappingChanged ? null : existingConfig.health ?? null,
        categoryMappings: mappingChanged ? [] : payload.categoryMappings,
        seenCategoryNames: mappingChanged ? [] : existingConfig.seenCategoryNames || []
      };

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
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
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
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
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
            actualAccountName: payload.actualAccountName,
            assetType: payload.assetType,
            provider: toPrismaProvider(payload.provider ?? null),
            connectionId: payload.connectionId ?? null,
            connectionAccountId: payload.connectionAccountId ?? null,
            syncFrequency: payload.syncFrequency,
            syncHour: payload.syncHour ?? null,
            syncDayOfWeek: payload.syncDayOfWeek ?? null,
            isEnabled: payload.isEnabled,
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
            supersededAt: timestamp,
            replacedByLinkId: replacement.id
          }
        });

        return replacement;
      });
      await syncActualExternalWriteback({ actualAccountId });
      return replacement;
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
        const metadata =
          connection.metadataJson && connection.metadataJson.length > 0
            ? (JSON.parse(connection.metadataJson) as Record<string, unknown>)
            : {};
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
            isEnabled: false
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

    getExternalSyncBridgeStatus,

    runExternalSyncBridgeSync,

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
