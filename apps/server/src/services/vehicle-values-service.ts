import { randomUUID } from "node:crypto";
import type {
  ConnectionDto,
  ProviderConnectResult,
  UpsertVehicleValueConnectionPayload,
  VehicleValueConnectionDetailsDto,
  VehicleValueSource
} from "@actual-sync/shared";
import { prisma } from "../db.js";
import { encryptString } from "../lib/crypto.js";
import { stripUndefined } from "../lib/strip-undefined.js";
import { parseConnectionMetadata } from "./connection-metadata.js";
import { sanitizeProviderSyncResult } from "./provider-sync-helpers.js";
import type { ProviderAdapter, ProviderSyncResult } from "./provider-adapter.js";
import { clearSyncHealth, toSyncHealth } from "./sync-health.js";

type DatabaseClient = typeof prisma;

type VehicleValuesMetadata = {
  vehicleValues?: VehicleValueConnectionDetailsDto | null;
  health?: ConnectionDto["health"] | null;
} & Record<string, unknown>;

const sourceConfig = [
  {
    source: "KBB" as const,
    key: "kbb" as const,
    valueField: "kbbValue" as const
  },
  {
    source: "EDMUNDS" as const,
    key: "edmunds" as const,
    valueField: "edmundsValue" as const
  },
  {
    source: "CARMAX" as const,
    key: "carmax" as const,
    valueField: "carmaxValue" as const
  },
  {
    source: "HAGERTY" as const,
    key: "hagerty" as const,
    valueField: "hagertyValue" as const
  }
];

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
}

function normalizeVehicleValuesPayload(payload: UpsertVehicleValueConnectionPayload): UpsertVehicleValueConnectionPayload {
  return {
    label: normalizeOptionalString(payload.label),
    vin: normalizeOptionalString(payload.vin)?.toUpperCase() ?? null,
    year:
      typeof payload.year === "number" && Number.isInteger(payload.year) && payload.year >= 1886 ? payload.year : null,
    make: payload.make.trim(),
    model: payload.model.trim(),
    trim: normalizeOptionalString(payload.trim),
    mileage: typeof payload.mileage === "number" && Number.isFinite(payload.mileage) ? Math.max(0, payload.mileage) : 0,
    zipCode: payload.zipCode.trim(),
    condition: payload.condition,
    source: payload.source,
    kbbValue: normalizeOptionalNumber(payload.kbbValue),
    edmundsValue: normalizeOptionalNumber(payload.edmundsValue),
    carmaxValue: normalizeOptionalNumber(payload.carmaxValue),
    hagertyValue: normalizeOptionalNumber(payload.hagertyValue)
  };
}

function sourceLabel(source: VehicleValueSource) {
  switch (source) {
    case "KBB":
      return "Kelley Blue Book";
    case "EDMUNDS":
      return "Edmunds";
    case "CARMAX":
      return "CarMax";
    case "HAGERTY":
      return "Hagerty";
    case "AVERAGE":
      return "Average";
  }
}

function validateVehicleValuePayload(payload: UpsertVehicleValueConnectionPayload) {
  if (!payload.make) {
    throw new Error("Make is required.");
  }
  if (!payload.model) {
    throw new Error("Model is required.");
  }
  if (!payload.zipCode) {
    throw new Error("ZIP code is required.");
  }
  if (!Number.isFinite(payload.mileage) || payload.mileage < 0) {
    throw new Error("Mileage must be zero or greater.");
  }

  const availableValues = sourceConfig
    .map(config => payload[config.valueField])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (payload.source === "AVERAGE") {
    if (availableValues.length === 0) {
      throw new Error("At least one source value is required when Average is the selected source.");
    }
    return;
  }

  const selectedConfig = sourceConfig.find(config => config.source === payload.source);
  if (!selectedConfig) {
    throw new Error("Selected source is invalid.");
  }
  if (payload[selectedConfig.valueField] == null) {
    throw new Error(`${sourceLabel(payload.source)} value is required when ${sourceLabel(payload.source)} is the selected source.`);
  }
}

function buildVehicleLabel(details: VehicleValueConnectionDetailsDto) {
  return [details.year ?? null, details.make, details.model, details.trim ?? null].filter(Boolean).join(" ");
}

function buildSourceStates(
  payload: UpsertVehicleValueConnectionPayload,
  existingDetails?: VehicleValueConnectionDetailsDto | null,
  timestamp?: string
) {
  return {
    kbb: {
      ...(existingDetails?.sources?.kbb ?? {}),
      estimate: payload.kbbValue ?? null,
      lastFetchedAt: payload.kbbValue != null ? timestamp ?? existingDetails?.sources?.kbb?.lastFetchedAt ?? null : null,
      lastSuccessfulAt:
        payload.kbbValue != null ? timestamp ?? existingDetails?.sources?.kbb?.lastSuccessfulAt ?? null : null,
      lastFailedAt: null,
      lastFailureMessage: null,
      usingCachedEstimate: false,
      stale: false
    },
    edmunds: {
      ...(existingDetails?.sources?.edmunds ?? {}),
      estimate: payload.edmundsValue ?? null,
      lastFetchedAt:
        payload.edmundsValue != null ? timestamp ?? existingDetails?.sources?.edmunds?.lastFetchedAt ?? null : null,
      lastSuccessfulAt:
        payload.edmundsValue != null ? timestamp ?? existingDetails?.sources?.edmunds?.lastSuccessfulAt ?? null : null,
      lastFailedAt: null,
      lastFailureMessage: null,
      usingCachedEstimate: false,
      stale: false
    },
    carmax: {
      ...(existingDetails?.sources?.carmax ?? {}),
      estimate: payload.carmaxValue ?? null,
      lastFetchedAt:
        payload.carmaxValue != null ? timestamp ?? existingDetails?.sources?.carmax?.lastFetchedAt ?? null : null,
      lastSuccessfulAt:
        payload.carmaxValue != null ? timestamp ?? existingDetails?.sources?.carmax?.lastSuccessfulAt ?? null : null,
      lastFailedAt: null,
      lastFailureMessage: null,
      usingCachedEstimate: false,
      stale: false
    },
    hagerty: {
      ...(existingDetails?.sources?.hagerty ?? {}),
      estimate: payload.hagertyValue ?? null,
      lastFetchedAt:
        payload.hagertyValue != null ? timestamp ?? existingDetails?.sources?.hagerty?.lastFetchedAt ?? null : null,
      lastSuccessfulAt:
        payload.hagertyValue != null ? timestamp ?? existingDetails?.sources?.hagerty?.lastSuccessfulAt ?? null : null,
      lastFailedAt: null,
      lastFailureMessage: null,
      usingCachedEstimate: false,
      stale: false
    }
  };
}

function calculateVehicleValue(payload: UpsertVehicleValueConnectionPayload) {
  if (payload.source === "AVERAGE") {
    const values = sourceConfig
      .map(config => payload[config.valueField])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) {
      throw new Error("At least one source value is required to calculate an average.");
    }
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  }

  const selectedConfig = sourceConfig.find(config => config.source === payload.source);
  const value = selectedConfig ? payload[selectedConfig.valueField] : null;
  if (value == null) {
    throw new Error(`${sourceLabel(payload.source)} value is required to calculate the selected source.`);
  }
  return Number(value.toFixed(2));
}

function toPersistedDetails(
  payload: UpsertVehicleValueConnectionPayload,
  existingDetails?: VehicleValueConnectionDetailsDto | null,
  now = new Date()
): VehicleValueConnectionDetailsDto {
  const timestamp = now.toISOString();
  return {
    vin: payload.vin ?? null,
    year: payload.year ?? null,
    make: payload.make,
    model: payload.model,
    trim: payload.trim ?? null,
    mileage: payload.mileage,
    zipCode: payload.zipCode,
    condition: payload.condition,
    source: payload.source,
    kbbValue: payload.kbbValue ?? null,
    edmundsValue: payload.edmundsValue ?? null,
    carmaxValue: payload.carmaxValue ?? null,
    hagertyValue: payload.hagertyValue ?? null,
    sources: buildSourceStates(payload, existingDetails, timestamp),
    calculatedValue: calculateVehicleValue(payload),
    lastCalculatedAt: timestamp
  };
}

function fromRawDetails(rawDetails: VehicleValueConnectionDetailsDto): UpsertVehicleValueConnectionPayload {
  return normalizeVehicleValuesPayload({
    label: null,
    vin: rawDetails.vin ?? null,
    year: rawDetails.year ?? null,
    make: rawDetails.make,
    model: rawDetails.model,
    trim: rawDetails.trim ?? null,
    mileage: rawDetails.mileage,
    zipCode: rawDetails.zipCode,
    condition: rawDetails.condition,
    source: rawDetails.source,
    kbbValue: rawDetails.kbbValue ?? null,
    edmundsValue: rawDetails.edmundsValue ?? null,
    carmaxValue: rawDetails.carmaxValue ?? null,
    hagertyValue: rawDetails.hagertyValue ?? null
  });
}

function formatMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "Not available";
}

function buildVehicleValuesNotes(details: VehicleValueConnectionDetailsDto) {
  const lines = [
    `Vehicle: ${buildVehicleLabel(details)}`,
    `Condition: ${details.condition}`,
    `Mileage: ${details.mileage.toLocaleString("en-US")} miles`,
    `ZIP code: ${details.zipCode}`,
    `Selected source: ${sourceLabel(details.source)}`
  ];

  if (details.vin) {
    lines.push(`VIN: ${details.vin}`);
  }

  for (const config of sourceConfig) {
    lines.push(`${sourceLabel(config.source)} value: ${formatMoney(details[config.valueField] ?? null)}`);
  }

  if (details.calculatedValue != null) {
    lines.push(`Applied vehicle value: ${details.calculatedValue.toFixed(2)}`);
  }

  return lines.join("\n");
}

export type VehicleValuesService = ProviderAdapter & {
  createConnection(payload: UpsertVehicleValueConnectionPayload): Promise<ProviderConnectResult>;
  updateConnection(connectionId: string, payload: UpsertVehicleValueConnectionPayload): Promise<ProviderConnectResult>;
};

export function createVehicleValuesService({
  prisma: database = prisma,
  now = () => new Date()
}: {
  prisma?: DatabaseClient;
  now?: () => Date;
} = {}): VehicleValuesService {
  const persistConnectionDetails = async ({
    connectionId,
    label,
    details
  }: {
    connectionId: string;
    label?: string | null;
    details: VehicleValueConnectionDetailsDto;
  }) => {
    const derivedLabel = label?.trim() || buildVehicleLabel(details);
    await database.connection.update({
      where: { id: connectionId },
      data: {
        label: derivedLabel,
        status: "ACTIVE",
        institutionName: "Vehicle Values",
        institutionId: "vehicle-values",
        lastRefreshedAt: now(),
        metadataJson: JSON.stringify({
          vehicleValues: details,
          health: clearSyncHealth()
        } satisfies VehicleValuesMetadata),
        accounts: {
          updateMany: {
            where: {},
            data: {
              name: derivedLabel,
              officialName: buildVehicleLabel(details),
              type: "vehicle",
              subtype: "vehicle-value",
              currentBalance: details.calculatedValue ?? null,
              availableBalance: null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      }
    });
  };

  const readPersistedConnectionDetails = async (connection: {
    id: string;
    provider: string;
    metadataJson: string | null;
  }) => {
    if (connection.provider !== "VEHICLE_VALUES") {
      throw new Error("Connection is not a Vehicle Values connection");
    }

    const metadata = parseConnectionMetadata(connection.metadataJson) as VehicleValuesMetadata;
    const rawDetails = metadata.vehicleValues;
    if (!rawDetails?.make || !rawDetails.model) {
      throw new Error("Vehicle Values connection is missing make or model details.");
    }

    const details = toPersistedDetails(fromRawDetails(rawDetails), rawDetails, now());
    return {
      metadata,
      details
    };
  };

  return {
    provider: "VEHICLE_VALUES",
    isConfigured() {
      return true;
    },
    async createConnection(payload) {
      const normalizedPayload = normalizeVehicleValuesPayload(payload);
      validateVehicleValuePayload(normalizedPayload);
      const details = toPersistedDetails(normalizedPayload, null, now());
      const label = normalizedPayload.label?.trim() || buildVehicleLabel(details);

      const connection = await database.connection.create({
        data: {
          provider: "VEHICLE_VALUES",
          label,
          status: "ACTIVE",
          institutionName: "Vehicle Values",
          institutionId: "vehicle-values",
          accessTokenCiphertext: encryptString("manual-vehicle-values"),
          providerItemId: randomUUID(),
          lastRefreshedAt: now(),
          metadataJson: JSON.stringify({
            vehicleValues: details,
            health: clearSyncHealth()
          } satisfies VehicleValuesMetadata),
          accounts: {
            create: {
              externalAccountId: randomUUID(),
              name: label,
              officialName: buildVehicleLabel(details),
              type: "vehicle",
              subtype: "vehicle-value",
              currentBalance: details.calculatedValue ?? null,
              rawJson: JSON.stringify(details)
            }
          }
        }
      });

      return { connectionId: connection.id };
    },

    async updateConnection(connectionId, payload) {
      const existing = await database.connection.findUniqueOrThrow({
        where: { id: connectionId }
      });
      const existingMetadata = parseConnectionMetadata(existing.metadataJson) as VehicleValuesMetadata;
      const normalizedPayload = normalizeVehicleValuesPayload(payload);
      validateVehicleValuePayload(normalizedPayload);
      const details = toPersistedDetails(normalizedPayload, existingMetadata.vehicleValues ?? null, now());
      await persistConnectionDetails(
        stripUndefined({
          connectionId,
          label: payload.label,
          details
        })
      );
      return { connectionId };
    },

    async refreshConnection(connectionId: string) {
      const connection = await database.connection.findUniqueOrThrow({
        where: { id: connectionId }
      });

      try {
        const { details } = await readPersistedConnectionDetails(connection);
        await persistConnectionDetails({ connectionId, details });
      } catch (error) {
        const metadata = parseConnectionMetadata(connection.metadataJson) as VehicleValuesMetadata;
        await database.connection.update({
          where: { id: connectionId },
          data: {
            status: "ERROR",
            metadataJson: JSON.stringify({
              ...metadata,
              health: toSyncHealth(error, {
                scope: "SYNC_PIPELINE",
                action: "CHECK_PROVIDER"
              })
            } satisfies VehicleValuesMetadata)
          }
        });
        throw error;
      }
    },

    async syncAccountLink(linkId: string): Promise<ProviderSyncResult> {
      const link = await database.accountLink.findUniqueOrThrow({
        where: { id: linkId },
        include: {
          connection: true,
          connectionAccount: true
        }
      });

      if (!link.connection || !link.connectionAccount) {
        return { imported: 0, transactions: [], removedImportedIds: [] };
      }

      const { details } = await readPersistedConnectionDetails(link.connection);
      await persistConnectionDetails({
        connectionId: link.connection.id,
        details
      });

      return sanitizeProviderSyncResult({
        imported: 0,
        transactions: [],
        balanceSnapshot: {
          asOfDate: now().toISOString().slice(0, 10),
          currentValue: details.calculatedValue ?? 0,
          stableId: `vehicle-value:${link.connectionAccount.externalAccountId}`,
          payeeName: "Vehicle Value Adjustment",
          importedPayee: buildVehicleLabel(details),
          notes: buildVehicleValuesNotes(details),
          searchText: [
            details.vin ?? undefined,
            details.make,
            details.model,
            details.trim ?? undefined,
            details.zipCode,
            sourceLabel(details.source)
          ].filter((value): value is string => Boolean(value))
        },
        removedImportedIds: []
      });
    }
  };
}

export const vehicleValuesService = createVehicleValuesService();
