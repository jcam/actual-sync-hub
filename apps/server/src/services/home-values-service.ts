import { randomUUID } from "node:crypto";
import type {
  ConnectionDto,
  HomeValueConnectionDetailsDto,
  ProviderConnectResult,
  UpsertHomeValueConnectionPayload
} from "@actual-sync/shared";
import { prisma } from "../db.js";
import { encryptString } from "../lib/crypto.js";
import { parseConnectionMetadata } from "./connection-metadata.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import { createProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderSettingsService } from "./provider-settings-service.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { clearSyncHealth, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

type HomeValuesMetadata = {
  homeValues?: HomeValueConnectionDetailsDto | null;
  health?: ConnectionDto["health"] | null;
} & Record<string, unknown>;

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHomeValuesPayload(payload: UpsertHomeValueConnectionPayload): UpsertHomeValueConnectionPayload {
  return {
    label: normalizeOptionalString(payload.label),
    address: payload.address.trim(),
    source: payload.source,
    redfinEstimate: normalizeOptionalNumber(payload.redfinEstimate),
    redfinUrl: normalizeOptionalString(payload.redfinUrl),
    zillowEstimate: normalizeOptionalNumber(payload.zillowEstimate),
    zillowUrl: normalizeOptionalString(payload.zillowUrl)
  };
}

function calculateHomeValue(details: UpsertHomeValueConnectionPayload) {
  switch (details.source) {
    case "REDFIN":
      if (details.redfinEstimate == null) {
        throw new Error("Redfin estimate is required when Redfin is the selected source.");
      }
      return details.redfinEstimate;
    case "ZILLOW":
      if (details.zillowEstimate == null) {
        throw new Error("Zillow estimate is required when Zillow is the selected source.");
      }
      return details.zillowEstimate;
    case "AVERAGE":
      if (details.redfinEstimate == null || details.zillowEstimate == null) {
        throw new Error("Both Redfin and Zillow estimates are required when averaging sources.");
      }
      return Number(((details.redfinEstimate + details.zillowEstimate) / 2).toFixed(2));
  }
}

function buildHomeValuesNotes(details: HomeValueConnectionDetailsDto) {
  const lines = [`Address: ${details.address}`, `Selected source: ${details.source}`];

  if (details.redfinEstimate != null) {
    lines.push(`Redfin estimate: $${details.redfinEstimate.toFixed(2)}`);
  }
  if (details.redfinUrl) {
    lines.push(`Redfin URL: ${details.redfinUrl}`);
  }

  if (details.zillowEstimate != null) {
    lines.push(`Zillow estimate: $${details.zillowEstimate.toFixed(2)}`);
  }
  if (details.zillowUrl) {
    lines.push(`Zillow URL: ${details.zillowUrl}`);
  }

  if (details.calculatedValue != null) {
    lines.push(`Applied home value: $${details.calculatedValue.toFixed(2)}`);
  }

  return lines.join("\n");
}

function toPersistedDetails(payload: UpsertHomeValueConnectionPayload, timestamp: string): HomeValueConnectionDetailsDto {
  return {
    address: payload.address,
    source: payload.source,
    redfinEstimate: payload.redfinEstimate ?? null,
    redfinUrl: payload.redfinUrl ?? null,
    zillowEstimate: payload.zillowEstimate ?? null,
    zillowUrl: payload.zillowUrl ?? null,
    calculatedValue: calculateHomeValue(payload),
    lastCalculatedAt: timestamp
  };
}

async function readHomeValuesDetails(connection: {
  id: string;
  provider: string;
  metadataJson: string | null;
}) {
  if (connection.provider !== "HOME_VALUES") {
    throw new Error("Connection is not a Home Values connection");
  }

  const metadata = parseConnectionMetadata(connection.metadataJson) as HomeValuesMetadata;
  const rawDetails = metadata.homeValues;
  if (!rawDetails?.address || !rawDetails.source) {
    throw new Error("Home Values connection is missing address or source details.");
  }

  const normalizedPayload = normalizeHomeValuesPayload({
    label: null,
    address: rawDetails.address,
    source: rawDetails.source,
    redfinEstimate: rawDetails.redfinEstimate ?? null,
    redfinUrl: rawDetails.redfinUrl ?? null,
    zillowEstimate: rawDetails.zillowEstimate ?? null,
    zillowUrl: rawDetails.zillowUrl ?? null
  });
  const refreshedAt = new Date().toISOString();
  const details = toPersistedDetails(normalizedPayload, refreshedAt);

  return {
    metadata,
    details,
    refreshedAt
  };
}

export type HomeValuesService = ProviderAdapter & {
  createConnection(payload: UpsertHomeValueConnectionPayload): Promise<ProviderConnectResult>;
  updateConnection(connectionId: string, payload: UpsertHomeValueConnectionPayload): Promise<ProviderConnectResult>;
};

export function createHomeValuesService({
  prisma: database = prisma,
  providerSettings = createProviderSettingsService({ prisma: database }),
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  providerSettings?: ProviderSettingsService;
  now?: () => Date;
} = {}): HomeValuesService {
  const getEffectiveSettings = async () => {
    const settings = await providerSettings.getAll();
    return settings.HOME_VALUES ?? {
      automaticSyncConcurrency: 1
    };
  };

  const persistConnectionDetails = async ({
    connectionId,
    label,
    details
  }: {
    connectionId: string;
    label?: string | null;
    details: HomeValueConnectionDetailsDto;
  }) => {
    await database.connection.update({
      where: {
        id: connectionId
      },
      data: {
        label: label?.trim() || details.address,
        status: "ACTIVE",
        institutionName: "Home Values",
        institutionId: "home-values",
        lastRefreshedAt: now(),
        metadataJson: JSON.stringify({
          homeValues: details,
          health: clearSyncHealth()
        } satisfies HomeValuesMetadata),
        accounts: {
          updateMany: {
            where: {},
            data: {
              name: label?.trim() || details.address,
              officialName: details.address,
              type: "property",
              subtype: "home-value",
              currentBalance: details.calculatedValue ?? null,
              availableBalance: null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      }
    });
  };

  return {
    provider: "HOME_VALUES",
    isConfigured() {
      return true;
    },
    async createConnection(payload) {
      await getEffectiveSettings();
      const normalizedPayload = normalizeHomeValuesPayload(payload);
      const timestamp = now().toISOString();
      const details = toPersistedDetails(normalizedPayload, timestamp);
      const label = normalizedPayload.label?.trim() || normalizedPayload.address;

      const connection = await database.connection.create({
        data: {
          provider: "HOME_VALUES",
          label,
          status: "ACTIVE",
          institutionName: "Home Values",
          institutionId: "home-values",
          accessTokenCiphertext: encryptString("manual-home-values"),
          providerItemId: randomUUID(),
          lastRefreshedAt: now(),
          metadataJson: JSON.stringify({
            homeValues: details,
            health: clearSyncHealth()
          } satisfies HomeValuesMetadata),
          accounts: {
            create: {
              externalAccountId: randomUUID(),
              name: label,
              officialName: normalizedPayload.address,
              type: "property",
              subtype: "home-value",
              currentBalance: details.calculatedValue ?? null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      });

      return {
        connectionId: connection.id
      };
    },
    async updateConnection(connectionId, payload) {
      const normalizedPayload = normalizeHomeValuesPayload(payload);
      const details = toPersistedDetails(normalizedPayload, now().toISOString());
      await persistConnectionDetails({
        connectionId,
        label: normalizedPayload.label,
        details
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

      try {
        const { details } = await readHomeValuesDetails(connection);
        await persistConnectionDetails({
          connectionId,
          details
        });
      } catch (error) {
        const metadata = parseConnectionMetadata(connection.metadataJson) as HomeValuesMetadata;
        await database.connection.update({
          where: {
            id: connectionId
          },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health: toSyncHealth(error, {
                scope: "SYNC_PIPELINE",
                action: "CHECK_PROVIDER"
              })
            } satisfies HomeValuesMetadata)
          }
        });
        throw error;
      }
    },
    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
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
        return {
          imported: 0,
          transactions: [],
          removedImportedIds: []
        };
      }

      const { details } = await readHomeValuesDetails(link.connection);
      await persistConnectionDetails({
        connectionId: link.connection.id,
        details
      });

      return sanitizeProviderSyncResult({
        imported: 1,
        transactions: [
          {
            date: now().toISOString().slice(0, 10),
            amount: details.calculatedValue ?? 0,
            payeeName: link.connection.label,
            importedPayee: details.address,
            notes: buildHomeValuesNotes(details),
            importedId: `home-value:${link.connectionAccount.externalAccountId}`,
            cleared: true,
            searchText: [
              details.address,
              details.redfinUrl || undefined,
              details.zillowUrl || undefined
            ].filter((value): value is string => Boolean(value))
          }
        ],
        removedImportedIds: []
      });
    }
  };
}

export const homeValuesService = createHomeValuesService();
