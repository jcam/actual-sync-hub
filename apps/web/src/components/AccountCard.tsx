import { useState } from "react";
import { Link } from "react-router-dom";
import type { ActualAccountDto, SyncFrequency, UpdateAccountLinkPayload } from "@actual-sync/shared";
import { api } from "../api";
import { getDisplayErrorMessage } from "../lib/errors";
import { getAutomaticSyncPauseSummary } from "../lib/provider-ui";
import { SyncHealthPanel } from "./SyncHealthPanel";

const scheduleOptions: SyncFrequency[] = ["MANUAL", "HOURLY", "DAILY", "WEEKLY"];

export function AccountCard({
  account,
  onRefresh
}: {
  account: ActualAccountDto;
  onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<Pick<
    UpdateAccountLinkPayload,
    "provider" | "connectionId" | "connectionAccountId" | "syncFrequency" | "syncHour" | "syncDayOfWeek" | "isEnabled"
  >>({
    provider: account.link.provider ?? null,
    connectionId: account.link.connectionId ?? null,
    connectionAccountId: account.link.connectionAccountId ?? null,
    syncFrequency: account.link.syncFrequency,
    syncHour: account.link.syncHour ?? 6,
    syncDayOfWeek: account.link.syncDayOfWeek ?? 1,
    isEnabled: account.link.isEnabled
  });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredOptions = account.options.filter(option => option.connectionId === form.connectionId);
  const selectedConnection = account.options.find(option => option.connectionId === form.connectionId);
  const activeConnectionOption = account.options.find(option => option.connectionId === account.link.connectionId);
  const automaticSyncPauseSummary =
    form.isEnabled && form.syncFrequency !== "MANUAL" ? getAutomaticSyncPauseSummary(account.link) : null;
  const blockingConnectionState =
    activeConnectionOption?.connectionStatus !== "ACTIVE" ||
    activeConnectionOption?.connectionHealth?.state === "REAUTH_REQUIRED" ||
    activeConnectionOption?.connectionHealth?.state === "ATTENTION_REQUIRED";
  const savedLinkReadyForSyncReview =
    account.link.status !== "MIGRATING" &&
    Boolean(account.link.connectionId) &&
    Boolean(account.link.connectionAccountId) &&
    Boolean(account.link.provider) &&
    !blockingConnectionState;
  const savedLinkReadyForImmediateSync =
    account.link.status !== "MIGRATING" &&
    Boolean(account.link.connectionId) &&
    Boolean(account.link.connectionAccountId) &&
    !blockingConnectionState;
  const buildPayload = (): UpdateAccountLinkPayload => ({
    actualAccountName: account.link.actualAccountName,
    assetType: account.link.assetType,
    provider: form.connectionId ? selectedConnection?.provider ?? form.provider ?? null : null,
    connectionId: form.connectionId ?? null,
    connectionAccountId: form.connectionAccountId ?? null,
    syncFrequency: form.syncFrequency,
    syncHour: form.syncHour ?? null,
    syncDayOfWeek: form.syncDayOfWeek ?? null,
    isEnabled: form.isEnabled,
    categoryMappings: account.link.categoryMappings
  });

  return (
    <article className="account-card">
      <div className="account-header">
        <div>
          <p className="eyebrow">Actual account</p>
          <h3>{account.name}</h3>
          <p className="balance">${account.balance.toFixed(2)}</p>
        </div>
        <div className="status-row">
          {account.link.status === "MIGRATING" ? <span className="pill">Migrating</span> : null}
          {account.closed ? <span className="pill muted-pill">Closed</span> : null}
          {account.offbudget ? <span className="pill">Off budget</span> : null}
        </div>
      </div>

      <div className="grid account-settings-grid">
        <label>
          <span>Connection</span>
          <select
            value={form.connectionId ?? ""}
            onChange={event => {
              const connectionId = event.target.value || null;
              const provider =
                account.options.find(option => option.connectionId === connectionId)?.provider ?? null;
              setForm(current => ({
                ...current,
                provider,
                connectionId,
                connectionAccountId: null
              }));
            }}
          >
            <option value="">Not linked</option>
            {Array.from(new Map(account.options.map(option => [option.connectionId, option])).values()).map(option => (
              <option key={option.connectionId} value={option.connectionId}>
                {option.connectionLabel}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Provider account</span>
          <select
            value={form.connectionAccountId ?? ""}
            onChange={event => setForm(current => ({ ...current, connectionAccountId: event.target.value || null }))}
            disabled={!form.connectionId}
          >
            <option value="">Choose account</option>
            {filteredOptions.map(option => (
              <option key={option.connectionAccountId} value={option.connectionAccountId}>
                {option.accountName} {option.mask ? `••${option.mask}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Schedule</span>
          <select
            value={form.syncFrequency}
            onChange={event => setForm(current => ({ ...current, syncFrequency: event.target.value as SyncFrequency }))}
          >
            {scheduleOptions.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Enabled</span>
          <select
            value={form.isEnabled ? "yes" : "no"}
            onChange={event => setForm(current => ({ ...current, isEnabled: event.target.value === "yes" }))}
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        {(form.syncFrequency === "DAILY" || form.syncFrequency === "WEEKLY") ? (
          <label>
            <span>Hour</span>
            <input
              type="number"
              min={0}
              max={23}
              value={form.syncHour ?? 6}
              onChange={event => setForm(current => ({ ...current, syncHour: Number(event.target.value) }))}
            />
          </label>
        ) : null}

        {form.syncFrequency === "WEEKLY" ? (
          <label>
            <span>Day of week</span>
            <select
              value={form.syncDayOfWeek ?? 1}
              onChange={event => setForm(current => ({ ...current, syncDayOfWeek: Number(event.target.value) }))}
            >
              <option value={0}>Sunday</option>
              <option value={1}>Monday</option>
              <option value={2}>Tuesday</option>
              <option value={3}>Wednesday</option>
              <option value={4}>Thursday</option>
              <option value={5}>Friday</option>
              <option value={6}>Saturday</option>
            </select>
          </label>
        ) : null}
      </div>

      <section className="category-summary-panel">
        <div>
          <p className="eyebrow">Category mapping</p>
          <p className="muted">
            {account.link.categoryMappings.length} explicit mapping{account.link.categoryMappings.length === 1 ? "" : "s"} ·{" "}
            {account.link.seenCategoryNames.length} recent provider categor{account.link.seenCategoryNames.length === 1 ? "y" : "ies"}
          </p>
        </div>
        <Link className="ghost-button inline-link-button" to={`/accounts/${account.id}/mappings`}>
          Edit category mappings
        </Link>
      </section>

      {account.link.health ? (
        <SyncHealthPanel
          eyebrow="Account sync status"
          health={account.link.health}
          provider={account.link.provider}
          scope="account"
          connectionId={account.link.connectionId}
          onReauthenticated={onRefresh}
        />
      ) : null}

      {activeConnectionOption?.connectionHealth ? (
        <SyncHealthPanel
          eyebrow="Connection status"
          health={activeConnectionOption.connectionHealth}
          provider={activeConnectionOption.provider}
          scope="connection"
          connectionId={activeConnectionOption.connectionId}
          onReauthenticated={onRefresh}
        />
      ) : null}

      {automaticSyncPauseSummary ? (
        <section className="automatic-sync-pause-panel">
          <div>
            <p className="eyebrow">Automatic sync paused</p>
            <p className="muted">{automaticSyncPauseSummary}</p>
          </div>
        </section>
      ) : null}

      {account.link.status === "MIGRATING" ? (
        <section className="migration-summary-panel">
          <div>
            <p className="eyebrow">Provider migration</p>
            <p className="muted">
              This account has a replacement provider link waiting for review. Preview the migration before the new
              provider becomes the active source of truth.
            </p>
          </div>
          <Link className="primary-button inline-link-button" to={`/accounts/${account.id}/migration`}>
            Review migration
          </Link>
        </section>
      ) : savedLinkReadyForSyncReview ? (
        <section className="migration-summary-panel">
          <div>
            <p className="eyebrow">Manual sync review</p>
            <p className="muted">
              Review what Actual would add or merge before committing a manual sync. You can also run the sync
              directly from this card.
            </p>
          </div>
          <Link className="ghost-button inline-link-button" to={`/accounts/${account.id}/sync-review`}>
            Review sync
          </Link>
        </section>
      ) : null}

      <div className="button-row">
        <button
          className="primary-button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.updateAccountLink(account.id, buildPayload());
              await onRefresh();
            } catch (saveError) {
              setError(
                getDisplayErrorMessage(saveError, "Failed to save this account link.", {
                  serverUnavailableMessage: "Could not reach the API server to save this account link."
                })
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving..." : "Save link"}
        </button>
        {account.link.status === "MIGRATING" ? null : (
          <button
            className="ghost-button"
            disabled={syncing || !savedLinkReadyForImmediateSync}
            onClick={async () => {
              setSyncing(true);
              setError(null);
              try {
                await api.runSync(account.id);
                await onRefresh();
              } catch (syncError) {
                setError(
                  getDisplayErrorMessage(syncError, "Failed to run this sync.", {
                    serverUnavailableMessage: "Could not reach the API server to run this sync."
                  })
                );
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? "Syncing..." : "Sync immediately"}
          </button>
        )}
      </div>
      {error ? <p className="error-text">{error}</p> : null}
    </article>
  );
}
