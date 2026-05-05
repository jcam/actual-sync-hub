import type { SyncHealthDto } from "@actual-sync/shared";
import { getSyncHealthBadge } from "../lib/provider-ui";

export function SyncHealthBadge({
  health,
  compact = false
}: {
  health: SyncHealthDto;
  compact?: boolean;
}) {
  const badge = getSyncHealthBadge(health);

  return (
    <span
      className={[
        "sync-health-badge",
        `sync-health-badge-${badge.tone}`,
        compact ? "sync-health-badge-compact" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {badge.label}
    </span>
  );
}
