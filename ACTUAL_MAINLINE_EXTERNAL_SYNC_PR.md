# Actual Mainline External Sync PR Notes

This document tracks the slimmer upstream Actual change set we actually kept.

The final direction is:

- let Actual understand and store external linkage metadata on accounts
- expose a small external-sync CRUD-style API surface for that metadata
- expose the existing account-level bank-sync preference flags through the external-sync read API

We explicitly did **not** keep the broader follow-on ideas around:

- external status polling
- manual sync trigger through Actual
- external sync completion/update signaling
- cross-client updated-account event propagation

## Goal

Make it possible for an external bridge to manage Actual-linked accounts through supported APIs without teaching Actual about Plaid, Teller, SimpleFIN, or any other provider-specific transport.

Actual should:

- tolerate `account_sync_source = 'external'`
- store native linkage metadata on accounts
- let a caller read that linkage metadata back
- let a caller clear that linkage
- expose the normal synced-account option flags the bridge may need to honor

Actual should **not**:

- call the bridge over HTTP
- own external provider auth or discovery
- trigger manual external sync
- own external sync runtime status

## What We Built Upstream

### 1. External linkage metadata support

Actual now has a neutral `external` sync source that can be written through supported APIs.

This includes:

- `account_sync_source = 'external'`
- native metadata writeback onto Actual accounts
- safe client rendering for externally linked accounts

### 2. External metadata read API

Actual now has a dedicated `get` API for the external-sync metadata instead of requiring callers to rely on widened generic account reads.

That API returns:

- linkage state
- provider account id
- institution info
- mask / official name
- stored balances
- `last_sync`
- synced-account preference flags

### 3. External unlink API

Actual exposes a narrow unlink API for externally linked accounts that reuses the existing native unlink semantics.

## Current Public API Shape

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
  lastSync?: string | null;
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

This is effectively the upsert/update call for durable external metadata.

### `api/account-external-sync-get`

Request:

```ts
type ExternalSyncAccountInfo = {
  id: string;
  linked: boolean;
  syncSource: 'external' | null;
  providerAccountId: string | null;
  institutionName: string | null;
  institutionExternalId: string | null;
  mask: string | null;
  officialName: string | null;
  balanceCurrent: number | null;
  balanceAvailable: number | null;
  balanceLimit: number | null;
  lastSync: string | null;
  prefs: {
    importPending: boolean;
    importNotes: boolean;
    reimportDeleted: boolean;
    importTransactions: boolean;
    updateDates: boolean;
  };
};
```

```ts
'api/account-external-sync-get': (arg: {
  id: string;
}) => Promise<ExternalSyncAccountInfo>;
```

Behavior:

- return the stored external linkage metadata for an account
- return `linked: false` with `null` external fields when the account is not externally linked
- return the current account-level synced-account option flags:
  - `Import pending transactions`
  - `Import transaction notes`
  - `Reimport deleted transactions`
  - `Investment Account`
  - `Update Dates`
- avoid widening `api/accounts-get` just to expose external-sync details

### `api/account-external-sync-unlink`

```ts
'api/account-external-sync-unlink': (arg: {
  id: string;
}) => Promise<void>;
```

Behavior:

- clear external link metadata using Actual's existing unlink semantics
- only allow this API for externally linked accounts

## Current API Model

The external-sync surface is intentionally small:

- create or refresh durable metadata:
  - `api/account-external-sync-link`
- read durable metadata and synced-account prefs:
  - `api/account-external-sync-get`
- clear durable metadata:
  - `api/account-external-sync-unlink`

We are deliberately treating `link` as the durable metadata upsert.

We are **not** adding a separate external-sync `update` or `complete` API in the slimmed-down branch.

## Internal Handler Additions

Current handlers added in `loot-core`:

- `account-external-sync-link`
- `account-external-sync-get`
- `account-external-sync-unlink`

We did **not** keep the earlier proposed handlers:

- `account-external-sync-complete`
- `external-sync-status`
- `external-sync`

## Client Behavior

For accounts with `account_sync_source === 'external'`:

- show them as linked
- label them `External`
- tolerate missing `last_sync`
- do not assume they are one of the built-in providers
- do not route them into native built-in sync actions

The client changes are intentionally minimal:

- safe grouping / labeling in bank sync UI
- safe `last_sync` display
- avoid treating external-linked accounts as built-in sync targets

## What We Explicitly Did Not Build

We are **not** currently pursuing these in the upstream PR:

- `api/external-sync-status`
- `api/external-sync`
- `api/account-external-sync-complete`
- `updatedAccountIds` additions to `sync-event`
- cross-client synced-indicator update signaling
- external bridge server config in Actual
- HTTP calls from Actual to `/external-sync/status`
- HTTP calls from Actual to `/external-sync/sync`
- native manual sync trigger for external providers inside Actual
- provider-specific setup, reauth, or discovery flows

Those were part of earlier larger plans. They are not part of the slimmed-down branch.

## TODOs In This Repo

- TODO: do not attempt to support `custom-sync-mappings-${accountId}` unless the bridge also adopts Actual-native raw bank-sync payload conventions, including `raw_synced_data`

## Type Changes

Primary type change:

- widen `AccountSyncSource` in `actual/packages/loot-core/src/types/models/account.ts`

Target shape:

```ts
export type AccountSyncSource =
  | 'simpleFin'
  | 'goCardless'
  | 'pluggyai'
  | 'external';
```

Also update the bank-sync grouping / label maps to tolerate `external`.

## Likely Files Touched Upstream

Server and types:

- `actual/packages/loot-core/src/types/models/account.ts`
- `actual/packages/loot-core/src/types/api-handlers.ts`
- `actual/packages/loot-core/src/server/accounts/app.ts`
- `actual/packages/loot-core/src/server/accounts/link.ts`
- `actual/packages/loot-core/src/server/api.ts`
- `actual/packages/loot-core/src/server/db/types/index.ts`

Desktop and mobile client:

- `actual/packages/desktop-client/src/components/banksync/AccountRow.tsx`
- `actual/packages/desktop-client/src/components/banksync/bankSyncUtils.ts`
- `actual/packages/desktop-client/src/components/accounts/Header.tsx`

SDK surface:

- `actual/packages/api/methods.ts`

Tests:

- `actual/packages/loot-core/src/server/accounts/app-external-sync.test.ts`
- `actual/packages/loot-core/src/server/accounts/app-bank-sync.test.ts`
- `actual/packages/desktop-client/src/components/banksync/bankSyncUtils.test.ts`

## Acceptance Criteria

- Actual accepts `account_sync_source = 'external'` without crashing
- a caller can mark an account as externally linked through supported APIs
- a caller can read the current external linkage metadata through a supported API
- a caller can read the current synced-account preference flags through that API
- a caller can clear that external linkage through supported APIs
- the sidebar and account views treat the account as linked when external metadata exists
- desktop/mobile bank-sync pages render a generic external state instead of assuming a built-in provider
- no provider-specific logic for Plaid, Teller, or SimpleFIN is added to Actual
- no provider transport or bridge polling is added to Actual

## Open Questions

- Should `account-external-sync-unlink` remain a narrow external-only API, or should upstream instead expose a generic public `account-unlink`?
- Should `findOrCreateExternalBank(...)` stay separate, or should upstream generalize the existing bank helper to accept an arbitrary bank key?
- Should these synced-account option flags eventually get their own explicit settings API instead of riding along on `account-external-sync-get`?
- Should unlink clear sync-derived balances, or preserve the last known values?

## Suggested PR Framing

Possible title:

- `Allow generic external account sync metadata`

Suggested framing:

- add a neutral external sync source
- add safe APIs for writing, reading, and clearing external sync metadata
- expose the existing synced-account option flags alongside the external linkage metadata
- make the client tolerate externally linked accounts without adding provider-specific integration or runtime bridge calls
