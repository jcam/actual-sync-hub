# Actual Mainline External Sync PR Checklist

This document captures the smallest upstream Actual change set that would let this app integrate as a generic external sync bridge without teaching Actual about Plaid, Teller, or SimpleFIN.

## TODOs In This Repo

- TODO: when syncing through this bridge, read and honor Actual account-level synced prefs for non-mapping bank-sync options where practical:
  - `sync-import-pending-${accountId}`
  - `sync-import-notes-${accountId}`
  - `sync-reimport-deleted-${accountId}`
  - `sync-import-transactions-${accountId}` (`Investment Account`)
  - `sync-update-dates-${accountId}`
- TODO: do not attempt to support `custom-sync-mappings-${accountId}` unless the bridge also adopts Actual-native raw bank-sync payload conventions, including `raw_synced_data`.

## Rollout Phases

### Phase 1: Accept external linkage metadata

Goal:

- let Actual tolerate `account_sync_source = 'external'`
- allow a supported API to write native external sync metadata onto accounts
- make the desktop/mobile client render linked external accounts safely

Phase 1 intentionally does not include:

- external status polling
- manual sync trigger through Actual
- provider-specific setup or reauth flows

This is the lowest-risk upstream slice and the best first PR candidate.

### Phase 2: External status and manual sync bridge

Goal:

- let Actual query an external bridge for sync status
- let Actual trigger a manual sync through the external bridge

This depends on Phase 1 but can be proposed separately if needed.

## Goal

Add a generic `external` sync source in Actual that can:

- mark an account as externally synced
- store native sync metadata through supported APIs
- fetch account sync status from an external bridge
- trigger a manual sync through an external bridge

The external bridge would be this app. Actual should not own provider-specific auth, account discovery, or sync implementation details.

## Scope

In scope:

- add `external` as a supported `account_sync_source`
- add a dedicated API for native sync metadata writeback
- add generic status and manual-sync bridge endpoints
- update desktop/mobile client code to tolerate and display `external`

Out of scope:

- provider-specific setup flows
- provider-specific secrets in Actual
- provider-specific account discovery in Actual
- plugin architecture
- teaching Actual about Plaid, Teller, or SimpleFIN

## Public API Additions

Add these new `@actual-app/api` handlers:

### `api/account-external-sync-link`

Request:

```ts
type ExternalSyncMetadataInput = {
  syncSource: 'external';
  providerAccountId: string;
  institutionName: string;
  institutionExternalId?: string | null;
  mask?: string | null;
  officialName?: string | null;
  balanceCurrent?: number | null;
  balanceAvailable?: number | null;
  balanceLimit?: number | null;
  lastSync?: string | null; // ISO timestamp
};
```

```ts
'api/account-external-sync-link': (arg: {
  id: string;
  metadata: ExternalSyncMetadataInput;
}) => Promise<void>;
```

Behavior:

- set `accounts.account_sync_source = 'external'`
- set `accounts.account_id = providerAccountId`
- create or find a `banks` row from `institutionName` and `institutionExternalId`
- set `accounts.bank = banks.id`
- set `mask`
- set `official_name`
- optionally set balances
- optionally set `last_sync`

### `api/account-external-sync-unlink`

```ts
'api/account-external-sync-unlink': (arg: {
  id: string;
}) => Promise<void>;
```

Behavior:

- clear `account_sync_source`
- clear `account_id`
- clear `bank`
- clear `mask`
- clear `official_name`
- clear `last_sync`
- decide whether to preserve or clear sync-derived balances

### `api/external-sync-status`

```ts
type ExternalSyncState =
  | 'ok'
  | 'syncing'
  | 'error'
  | 'reauth_required'
  | 'not_configured';

type ExternalSyncStatus = {
  accountId: string;
  configured: boolean;
  state: ExternalSyncState;
  message?: string | null;
  lastSync?: string | null;
  canSync: boolean;
  needsReauth: boolean;
};
```

```ts
'api/external-sync-status': (arg?: {
  accountId?: string;
}) => Promise<ExternalSyncStatus[]>;
```

### `api/external-sync`

```ts
type ExternalSyncRunResult = {
  accountId: string;
  state: 'ok' | 'syncing' | 'error' | 'reauth_required';
  message?: string | null;
  newTransactions?: number;
  matchedTransactions?: number;
  updatedAccounts?: string[];
};
```

```ts
'api/external-sync': (arg: {
  accountId: string;
}) => Promise<ExternalSyncRunResult>;
```

## Phase 1 Exact Scope

If we want the absolute smallest upstream PR, Phase 1 should include only:

- widen `AccountSyncSource` to include `external`
- add `api/account-external-sync-link`
- add `api/account-external-sync-unlink`
- add internal handlers for those two operations
- update desktop/mobile client code to tolerate and display `external`

Phase 1 should not include:

- `api/external-sync-status`
- `api/external-sync`
- external bridge server config
- HTTP calls from Actual to an external system

## Internal Handler Additions

Add generic internal handlers in `loot-core` beside the existing bank-sync handlers:

- `account-external-sync-link`
- `account-external-sync-unlink`
- `external-sync-status`
- `external-sync`

These should remain generic and should not know anything about specific external providers.

For Phase 1, only the first two handlers are required.

## External Bridge Contract

Actual would call this app over HTTP using server-side configuration.

Suggested config:

- `EXTERNAL_SYNC_BASE_URL`
- `EXTERNAL_SYNC_TOKEN`

Suggested headers:

```http
Authorization: Bearer <EXTERNAL_SYNC_TOKEN>
Content-Type: application/json
```

### Status endpoint

Request:

```http
GET /actual/external-sync/status?accountId=<actualAccountId>
```

Response:

```json
{
  "accounts": [
    {
      "accountId": "acc_123",
      "configured": true,
      "state": "ok",
      "message": null,
      "lastSync": "2026-05-04T19:12:00.000Z",
      "canSync": true,
      "needsReauth": false
    }
  ]
}
```

### Manual sync endpoint

Request:

```http
POST /actual/external-sync/sync
```

```json
{
  "accountId": "acc_123"
}
```

Response:

```json
{
  "accountId": "acc_123",
  "state": "ok",
  "message": "Imported 14 transactions.",
  "newTransactions": 14,
  "matchedTransactions": 2,
  "updatedAccounts": ["acc_123"]
}
```

### Error shape

Use one shared error shape from the external bridge:

```json
{
  "error": {
    "code": "REAUTH_REQUIRED",
    "message": "Bank credentials need to be refreshed."
  }
}
```

Suggested error codes:

- `NOT_CONFIGURED`
- `REAUTH_REQUIRED`
- `SYNC_FAILED`
- `ACCOUNT_NOT_FOUND`
- `UNSUPPORTED`

All of the external bridge HTTP contract above is Phase 2, not Phase 1.

## Type Changes

Update Actual type unions to allow `external`.

Primary change:

- widen `AccountSyncSource` in `actual/packages/loot-core/src/types/models/account.ts`

Current:

```ts
export type AccountSyncSource = 'simpleFin' | 'goCardless' | 'pluggyai';
```

Target:

```ts
export type AccountSyncSource =
  | 'simpleFin'
  | 'goCardless'
  | 'pluggyai'
  | 'external';
```

Also update any other narrow sync-source unions and label maps in:

- `types/models/bank-sync.ts`
- desktop bank-sync screens
- mobile bank-sync screens
- selection/edit flows that assume only built-in providers

## Client Behavior

For accounts with `account_sync_source === 'external'`:

- show them as linked
- label them `External`
- show status from `api/external-sync-status`
- allow manual sync via `api/external-sync`
- do not show native provider setup or relink flows

The client should tolerate the new source without crashing anywhere that currently assumes only built-ins.

For Phase 1 specifically:

- show them as linked
- label them `External`
- do not show provider-specific setup flows
- do not require status polling or manual sync support yet

## Likely Files To Touch Upstream

Server and types:

- `actual/packages/loot-core/src/types/models/account.ts`
- `actual/packages/loot-core/src/types/models/bank-sync.ts`
- `actual/packages/loot-core/src/types/api-handlers.ts`
- `actual/packages/loot-core/src/server/accounts/app.ts`
- `actual/packages/loot-core/src/server/api.ts`
- `actual/packages/loot-core/src/server/api-models.ts` if needed

Desktop and mobile client:

- `actual/packages/desktop-client/src/components/banksync/index.tsx`
- `actual/packages/desktop-client/src/components/banksync/AccountRow.tsx`
- `actual/packages/desktop-client/src/components/mobile/banksync/MobileBankSyncPage.tsx`
- `actual/packages/desktop-client/src/components/mobile/banksync/BankSyncAccountsList.tsx`
- `actual/packages/desktop-client/src/accounts/mutations.ts`

Optional config/docs:

- sync-server or server config for external bridge URL and token
- bank-sync docs

Phase 1 likely does not need sync-server config changes.

## Acceptance Criteria

- Actual accepts `account_sync_source = 'external'` without crashing
- an external bridge can mark an account as linked through supported APIs
- the sidebar and account views treat the account as linked
- desktop/mobile bank-sync pages render a generic external state instead of assuming a built-in provider
- Actual can request external sync status for an account
- Actual can trigger a manual sync for an account
- no provider-specific logic for Plaid, Teller, or SimpleFIN is added to Actual

## Phase 1 Acceptance Criteria

- Actual accepts `account_sync_source = 'external'` without crashing
- a caller can mark an account as externally linked through supported APIs
- a caller can clear that external linkage through supported APIs
- the sidebar and account views treat the account as linked when external metadata exists
- desktop/mobile bank-sync pages render a generic external state instead of assuming a built-in provider
- no provider-specific logic for Plaid, Teller, or SimpleFIN is added to Actual

## Phase 2 Acceptance Criteria

- Actual can request external sync status for an account
- Actual can trigger a manual sync for an account

## Open Questions

- Should `api/external-sync-status` return a list or a single object when `accountId` is provided?
- Should unlink clear `balance_current`, or preserve the last known synced balance?
- Should the external bridge contract include a richer status taxonomy, or should Actual keep it intentionally coarse?
- Should the external bridge config be global server config only, or per-budget?

## Suggested PR Framing

Possible title:

- `Add generic external sync bridge support`

Possible Phase 1 title:

- `Allow generic external account sync metadata`

Suggested framing:

- add a neutral external sync source
- add a safe external sync metadata API
- add generic status and manual-sync bridge hooks
- avoid embedding third-party provider logic in Actual

Suggested Phase 1 framing:

- add a neutral external sync source
- add safe APIs for writing and clearing external sync metadata
- make the client tolerate externally linked accounts without requiring provider-specific integration
