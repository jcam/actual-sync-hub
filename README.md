# Actual Sync Hub

`Actual Sync Hub` is a TypeScript service and web app for syncing Actual Budget accounts against external providers. This first version focuses on Plaid-backed bank accounts, but the core model is built around providers, connections, and account links so future connectors can add investment accounts, property values, payment processors, or direct bank APIs without rewriting the app.

## Stack

- Backend: Fastify, Prisma, SQLite, `@actual-app/api`, Plaid Node SDK
- Frontend: React, Vite, React Router
- Auth: local username/password session
- Scheduling: in-process scheduler with hourly/daily/weekly account sync policies

## Architecture

- `apps/server`: API server, auth, scheduler, Actual client, provider adapters
- `apps/web`: protected frontend for account mapping and provider connections
- `packages/shared`: shared DTOs and enums used by both apps
- `prisma/schema.prisma`: persistence model for users, provider connections, linked accounts, and sync runs

The scheduler is intentionally simple: a single Node process polls for due links and executes sync jobs. This keeps deployment to one container while still allowing account-level schedules.

## Live sandbox mode

For interactive exploration against a real Actual server and real Plaid Sandbox Items, run:

```bash
npm run dev:live-sandbox
```

This bootstraps a temporary Dockerized Actual server, seeds an Actual budget with multiple bank accounts, points the app at that budget, and enables sandbox-only Plaid controls in the web UI.

What you get in this mode:

- Accounts page backed by a real Actual Docker container
- Connections page backed by real Plaid Sandbox APIs
- Extra Plaid sandbox buttons to seed additional test bank connections
- Extra Plaid sandbox buttons to seed additional test transactions on a connection

The launcher prefers `PLAID_CLIENT_ID` and `PLAID_SECRET`, but will fall back to `PLAID_TEST_CLIENT_ID` and `PLAID_TEST_SECRET` if needed.

## Current Plaid behavior

- Plaid connections are created through Plaid Link.
- Linked accounts are stored as provider account options for Actual accounts.
- Sync imports posted transactions into Actual through `importTransactions`.
- Pending transaction handling and deleted-transaction reconciliation are intentionally conservative in this MVP. Removed Plaid transactions are not deleted from Actual.
- In sandbox-enabled development mode, Plaid connections can also be created directly through `/sandbox/public_token/create`, and custom test transactions can be added through `/sandbox/transactions/create`.

## Getting started

1. Copy `.env.example` to `.env` and fill in Actual and Plaid credentials.
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

Current coverage includes:

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
