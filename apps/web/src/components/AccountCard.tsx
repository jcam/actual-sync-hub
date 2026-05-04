import { useState } from "react";
import { Link } from "react-router-dom";
import type { ActualAccountDto, SyncFrequency, UpdateAccountLinkPayload } from "@actual-sync/shared";
import { api } from "../api";

const scheduleOptions: SyncFrequency[] = ["MANUAL", "HOURLY", "DAILY", "WEEKLY"];

export function AccountCard({
  account,
  onRefresh
}: {
  account: ActualAccountDto;
  onRefresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<UpdateAccountLinkPayload>({
    actualAccountName: account.name,
    assetType: "BANK",
    provider: account.link.provider ?? null,
    connectionId: account.link.connectionId ?? null,
    connectionAccountId: account.link.connectionAccountId ?? null,
    syncFrequency: account.link.syncFrequency,
    syncHour: account.link.syncHour ?? 6,
    syncDayOfWeek: account.link.syncDayOfWeek ?? 1,
    isEnabled: account.link.isEnabled,
    categoryMappings: account.link.categoryMappings
  });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const filteredOptions = account.options.filter(option => option.connectionId === form.connectionId);

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
              setForm(current => ({
                ...current,
                provider: connectionId ? "PLAID" : null,
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
      ) : form.connectionId && form.connectionAccountId ? (
        <section className="migration-summary-panel">
          <div>
            <p className="eyebrow">Manual sync review</p>
            <p className="muted">
              Review what Actual would add or merge before committing a manual sync. Direct sync is still available if
              you want to bypass review.
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
            try {
              await api.updateAccountLink(account.id, form);
              await onRefresh();
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
            disabled={syncing || !form.connectionId || !form.connectionAccountId}
            onClick={async () => {
              setSyncing(true);
              try {
                await api.runSync(account.id);
                await onRefresh();
              } finally {
                setSyncing(false);
              }
            }}
          >
            {syncing ? "Syncing..." : "Sync immediately"}
          </button>
        )}
      </div>
    </article>
  );
}
