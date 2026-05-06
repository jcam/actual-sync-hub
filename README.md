# Actual Sync Hub

`Actual Sync Hub` is a TypeScript service and web app for syncing Actual Budget accounts against external providers. It manages provider connections, account links, review-first imports, scheduled sync, and connection health for Plaid, Teller.io, and SimpleFIN.

## Stack

- Backend: Fastify, Prisma, SQLite, `@actual-app/api`, Plaid Node SDK
- Frontend: React, Vite, React Router
- Auth: local username/password session
- Scheduling: in-process scheduler with hourly/daily/weekly account sync policies

## Architecture

- `apps/server`: API server, auth, scheduler, Actual client, provider adapters
- `apps/web`: protected frontend for account mapping plus separate Plaid, Teller.io, and SimpleFIN connection surfaces
- `packages/shared`: shared DTOs and enums used by both apps
- `prisma/schema.prisma`: persistence model for users, provider connections, linked accounts, and sync runs

The scheduler runs inside a single Node process that polls for due links and executes sync jobs. This keeps deployment to one container while still allowing account-level schedules.

## Actual integration

- The app syncs transactions into Actual through `@actual-app/api`.
- Native Actual external-sync metadata writeback is optional and disabled by default.
- Enable it with `ACTUAL_EXTERNAL_SYNC_WRITEBACK_ENABLED=1` only when the connected Actual runtime exposes the external-sync account APIs, such as the `external-sync` branch currently checked out in the sibling `actual/` repo.
- When enabled, linked provider accounts are written back into Actual as native `external` sync links so Actual can reflect that ownership in its own account metadata.
- The app also exposes `/external-sync/status` and `/external-sync/sync` for an external-sync-capable Actual runtime to call when it wants native status or manual sync execution from this bridge.

## Live sandbox mode

For interactive exploration against a real Actual server and real Plaid Sandbox Items, run:

```bash
npm run dev:live-sandbox
```

This boots a temporary Dockerized Actual server, seeds an Actual budget with multiple bank accounts, points the app at that budget, and enables sandbox-only Plaid controls in the web UI.

What you get in this mode:

- Accounts page backed by a real Actual Docker container
- Plaid Connections page backed by real Plaid Sandbox APIs
- Extra Plaid sandbox buttons to seed additional test bank connections
- Extra Plaid sandbox buttons to seed additional test transactions on a connection
- Separate Teller.io Connections page for enrollment, account discovery, and connection management

## Configuration model

- Core runtime wiring stays in `.env`.
- Provider credentials and sync tuning live in the web UI on each provider page.
- The optional provider env vars in `.env.example` are only for live-sandbox and live-test injection helpers.

## Plaid

- Plaid connections are created through Plaid Link.
- Linked accounts are stored as provider account options for Actual accounts.
- Link token creation explicitly requests a configurable transaction-history window, defaulting to 365 days.
- Transactions sync explicitly requests Plaid Personal Finance Categories v2 by default.
- Sync imports posted transactions into Actual through `importTransactions`.
- Pending transaction handling follows Plaid's `pending_transaction_id` model, and removed Plaid transactions are reconciled back out of Actual by `imported_id`.
- In sandbox-enabled development mode, Plaid connections can also be created directly through `/sandbox/public_token/create`, and custom test transactions can be added through `/sandbox/transactions/create`.
- Plaid API credentials are saved in the app settings UI rather than read from runtime env.

## Teller.io

- Teller has a separate top-level `Teller.io Connections` page.
- Teller Connect enrollment is wired end to end through the app.
- Successful Teller enrollments are persisted as reusable provider connections and hydrated from Teller `/accounts` plus per-account `/balances`.
- Teller transaction sync uses a date-window model with a configurable initial lookback plus overlap on later syncs.
- Teller application credentials, environment, and mTLS PEM values are saved in the app settings UI.
- Development and production Teller API access use mTLS credentials; sandbox does not require them.
- Teller webhook consumption is supported at `POST /api/webhooks/teller` when webhook signing secrets are saved in settings.
- `transactions.processed` webhooks refresh Teller connections and auto-sync only enabled non-manual Teller links.
- `enrollment.disconnected` webhooks mark the connection as disconnected and disable current links tied to that enrollment.
- Optional local provider-fixture caching can persist the last successful Teller enrollment and SimpleFIN credentials for reuse in manual dev/live workflows.

## SimpleFIN

- SimpleFIN connections are created from one-time setup tokens.
- Imported existing Actual `simpleFin` links can be matched against app-managed SimpleFIN connections.
- SimpleFIN account refresh and transaction sync use a provider-managed date window with a configurable initial lookback.
- Connection health distinguishes reconnect problems, upstream bank issues, and downstream sync failures.
- SimpleFIN initial-window and concurrency settings are managed in the web UI.

## Cached dev fixtures

For manual live validation, Teller and SimpleFIN can optionally reuse the most recently successful sandbox/dev credentials from a local flat file instead of forcing a fresh Connect/setup-token flow every run.

Enable it with:

```bash
PROVIDER_FIXTURE_CACHE_ENABLED=1
PROVIDER_FIXTURE_CACHE_FILE=./.local/provider-fixtures.json
```

When enabled:

- successful Teller enrollments update the cached Teller fixture
- successful Teller sandbox seeding updates the cached Teller fixture
- successful SimpleFIN setup-token connects update the cached SimpleFIN fixture
- the Teller and SimpleFIN pages expose `Reuse cached ... fixture` actions

This cache is intended for manual dev/live workflows, not deterministic automated tests. By default it is disabled, and the cache file path is git-ignored.

## Getting started

1. Copy `.env.example` to `.env` and fill in the required runtime wiring values.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create the SQLite schema:

   ```bash
   npm run db:push
   ```

4. Start development mode:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:5173](http://localhost:5173) for the web UI in development, or [http://localhost:4000](http://localhost:4000) after a production build.

## Tests

Run the full suite:

```bash
npm test
```

Useful scripts:

```bash
npm run test:watch
npm run test:coverage
```

Coverage includes:

- Backend route integration tests using Fastify `inject()`
- Backend service tests with isolated temporary SQLite databases
- Scheduler unit tests for sync cadence logic
- Frontend component/page tests with React Testing Library

Plaid testing is split into two layers:

- Default mocked tests for routes and service orchestration. These are fast, deterministic, and always run in `npm test`.
- Optional live Sandbox tests for the Plaid adapter itself. These only run when `PLAID_TEST_RUN_LIVE=1` and Sandbox credentials are provided.

Run the optional live Plaid test:

```bash
npm run test:plaid-live
```

Run the full end-to-end live sync test:

```bash
npm run test:full-live
```

Environment for live Plaid tests:

- `PLAID_TEST_RUN_LIVE=1`
- `PLAID_TEST_CLIENT_ID`
- `PLAID_TEST_SECRET`
- `PLAID_TEST_ENV=sandbox`
- `FULL_SYNC_TEST_RUN_LIVE=1` for the cross-system end-to-end sync test

As of May 4, 2026, Plaid’s official guidance is to use Sandbox for automated development testing and to bypass Link in automated tests with `/sandbox/public_token/create`, rather than scripting the Link UI. For testing with real bank data, Plaid recommends Limited Production or Production instead of Sandbox.

Actual testing is split similarly:

- Default mocked tests for orchestration and route behavior
- Optional live Docker-backed tests that boot a real Actual server container and exercise `actualService` through the official `@actual-app/api` package

Run the optional live Actual test:

```bash
npm run test:actual-live
```

Environment for live Actual tests:

- `ACTUAL_TEST_RUN_LIVE=1`
- `ACTUAL_TEST_IMAGE=ghcr.io/actualbudget/actual:26.5.0-alpine`
- `ACTUAL_TEST_PASSWORD`

The default live-test image is pinned for deterministic integration runs. If you want a rolling compatibility check against newer Actual releases, override `ACTUAL_TEST_IMAGE` with `ghcr.io/actualbudget/actual:latest-alpine`.

## Production

Build and run:

```bash
npm run build
node apps/server/dist/index.js
```

For container deployment, mount `./data` or another persistent directory for the SQLite database and Actual cache.

Note: Prisma resolves SQLite paths relative to `prisma/schema.prisma`, so the default database URL uses `file:../data/sync.db`.
