import type { AccountLinkStatus, CategoryMappingDto, LinkConfigDto } from "@actual-sync/shared";
import type { UpdateAccountLinkPayload } from "@actual-sync/shared";

export interface LinkConfigData {
  plaidCursor?: string;
  categoryMappings?: CategoryMappingDto[];
  seenCategoryNames?: string[];
}

export const CURRENT_LINK_STATUSES = ["ACTIVE", "MIGRATING"] as const satisfies AccountLinkStatus[];

export type CurrentLinkStatus = (typeof CURRENT_LINK_STATUSES)[number];

export function parseLinkConfig(configJson: string | null | undefined): LinkConfigData {
  if (!configJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(configJson) as LinkConfigData;
    return {
      plaidCursor: parsed.plaidCursor,
      categoryMappings: (parsed.categoryMappings || []).filter(
        mapping => Boolean(mapping?.sourceCategory) && Boolean(mapping?.actualCategoryId)
      ),
      seenCategoryNames: (parsed.seenCategoryNames || []).filter(Boolean)
    };
  } catch {
    return {};
  }
}

export function serializeLinkConfig(config: LinkConfigData) {
  const nextConfig: LinkConfigData = {
    plaidCursor: config.plaidCursor || undefined,
    categoryMappings: (config.categoryMappings || []).filter(
      mapping => Boolean(mapping.sourceCategory) && Boolean(mapping.actualCategoryId)
    ),
    seenCategoryNames: [...new Set((config.seenCategoryNames || []).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right)
    )
  };

  return JSON.stringify(nextConfig);
}

export function isCurrentLinkStatus(status: AccountLinkStatus): status is CurrentLinkStatus {
  return CURRENT_LINK_STATUSES.includes(status as CurrentLinkStatus);
}

export function selectCurrentLink<T extends { status: AccountLinkStatus; updatedAt: Date; createdAt: Date }>(links: T[]) {
  const current = links.filter(link => isCurrentLinkStatus(link.status));
  if (current.length === 0) {
    return null;
  }

  return current.sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === "ACTIVE" ? -1 : 1;
    }

    return right.updatedAt.getTime() - left.updatedAt.getTime() || right.createdAt.getTime() - left.createdAt.getTime();
  })[0] ?? null;
}

export function linkIdentityChanged(
  existing: {
    provider: "PLAID" | null;
    connectionId: string | null;
    connectionAccountId: string | null;
  } | null,
  payload: UpdateAccountLinkPayload
) {
  return (
    existing?.provider !== (payload.provider ?? null) ||
    existing?.connectionId !== (payload.connectionId ?? null) ||
    existing?.connectionAccountId !== (payload.connectionAccountId ?? null)
  );
}

export function toLinkDto(
  link: {
    id: string;
    status: AccountLinkStatus;
    actualAccountId: string;
    actualAccountName: string;
    assetType: "BANK";
    provider: "PLAID" | null;
    connectionId: string | null;
    connectionAccountId: string | null;
    syncFrequency: "MANUAL" | "HOURLY" | "DAILY" | "WEEKLY";
    syncHour: number | null;
    syncDayOfWeek: number | null;
    isEnabled: boolean;
    lastSyncedAt: Date | null;
    migrationStartedAt: Date | null;
    migrationCompletedAt: Date | null;
    supersededAt: Date | null;
    replacedByLinkId: string | null;
    configJson?: string | null;
  } | null,
  fallback: { actualAccountId: string; actualAccountName: string }
): LinkConfigDto {
  const config = parseLinkConfig(link?.configJson);
  return {
    linkId: link?.id ?? null,
    status: link?.status ?? "ACTIVE",
    actualAccountId: fallback.actualAccountId,
    actualAccountName: link?.actualAccountName ?? fallback.actualAccountName,
    assetType: link?.assetType ?? "BANK",
    provider: link?.provider ?? null,
    connectionId: link?.connectionId ?? null,
    connectionAccountId: link?.connectionAccountId ?? null,
    syncFrequency: link?.syncFrequency ?? "MANUAL",
    syncHour: link?.syncHour ?? null,
    syncDayOfWeek: link?.syncDayOfWeek ?? null,
    isEnabled: link?.isEnabled ?? false,
    lastSyncedAt: link?.lastSyncedAt?.toISOString() ?? null,
    migrationStartedAt: link?.migrationStartedAt?.toISOString() ?? null,
    migrationCompletedAt: link?.migrationCompletedAt?.toISOString() ?? null,
    supersededAt: link?.supersededAt?.toISOString() ?? null,
    replacedByLinkId: link?.replacedByLinkId ?? null,
    categoryMappings: config.categoryMappings || [],
    seenCategoryNames: config.seenCategoryNames || []
  };
}
