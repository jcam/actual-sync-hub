# AGENTS.md

Guide for AI agents working in `actual-sync`.

## Project shape

This repo is a small TypeScript monorepo, not the main Actual repo.

- Package manager: `npm`
- Workspaces:
  - `apps/server` - Fastify API, Prisma, SQLite, provider adapters, Actual integration
  - `apps/web` - React + Vite frontend
  - `packages/shared` - shared DTOs/types
- Database: SQLite via Prisma
- Providers: Plaid, Teller, SimpleFIN

Do not assume `yarn`, `lage`, Playwright, Electron, i18n generation, or the main Actual repo’s package structure. Those do not apply here.

## Root commands

Run commands from `actual-sync`.

```bash
npm install
npm run build
npm run lint
npm run lint:fix
npm run format:check
npm run format:fix
npm test
npm run test:watch
npm run test:coverage
npm run dev
npm run dev:live-sandbox
npm run db:generate
npm run db:push
```

Important scripts:

- `npm run build`
  - builds `packages/shared`, then `apps/web`, then `apps/server`
- `npm run lint`
  - runs repo-wide `oxlint --type-aware`, then TypeScript type-checks in server and web
- `npm run lint:fix`
  - applies auto-fixable `oxlint` fixes
- `npm run format:check`
  - checks formatting with `oxfmt`
- `npm run format:fix`
  - formats the repo with `oxfmt`
- `npm test`
  - runs Vitest once and forces live-test flags off
- `npm run dev`
  - runs server and web together with `concurrently`
- `npm run dev:live-sandbox`
  - launches the containerized live sandbox workflow

## Workspace commands

```bash
npm run build -w packages/shared
npm run build -w apps/server
npm run build -w apps/web

npm run lint -w apps/server
npm run lint -w apps/web

npm run test -w apps/server
npm run test -w apps/web
```

## Testing

This repo uses `vitest` for everything.

### Server tests

- Fastify route tests use `app.inject()`
- Service tests use temporary SQLite databases
- There are live tests for Actual and Plaid behind env flags

Examples:

```bash
npm test
npm run test:actual-live
npm run test:plaid-live
npm run test:full-live
```

Key live-test flags:

- `ACTUAL_TEST_RUN_LIVE`
- `PLAID_TEST_RUN_LIVE`
- `FULL_SYNC_TEST_RUN_LIVE`
- `ACTUAL_TEST_*`
- `PLAID_TEST_*`
- `TELLER_TEST_*`

### Web tests

- Vitest + jsdom
- React Testing Library
- `@testing-library/user-event`

There is no Playwright test harness in this repo.

## Database and schema

- Prisma schema: [prisma/schema.prisma](actual-sync/prisma/schema.prisma)
- Prisma client output: `apps/server/src/generated/prisma`

When schema changes are made:

```bash
npm run db:push
npm run db:generate
```

For local validation against an existing DB, remember that new tables/columns will not appear until `db:push` runs or the live sandbox is restarted fresh.

## Runtime configuration

Current model:

- Core app/runtime wiring stays in `.env`
- Provider credentials and provider tuning are primarily managed through the web settings UI
- Live sandbox and live tests inject provider settings through API endpoints using `*_TEST_*` env vars

Do not reintroduce provider runtime env fallbacks unless explicitly asked.

## Build and frontend notes

- Server build: `tsc -p apps/server/tsconfig.json`
- Web build: `tsc -p apps/web/tsconfig.json && vite build`
- Shared build: `tsc -p packages/shared/tsconfig.json`

Frontend stack:

- React 19
- React Router
- Vite
- `react-plaid-link`

There is no React Native, Electron desktop app, or main-Actual component library in this repo.

## Coding expectations

- Prefer focused changes over broad refactors
- Keep imports and code style consistent with surrounding files
- Use TypeScript types from `@actual-sync/shared` where appropriate
- When touching cross-app DTOs, update `packages/shared` first and rebuild it
- When touching tests, update the relevant route/service/page tests in the same change
- The repo now has Actual-style lint pressure:
  - type-aware `oxlint` checks
  - no deep backtracked imports like `../../foo`
  - no undeclared external package imports
  - prefer `import type` where appropriate
  - no React default-import member usage like `React.useState`
  - no default exports in normal source files

## Recommended validation before finishing

For most code changes:

```bash
npm run build -w packages/shared
npx tsc -p apps/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npm test
```

For smaller scoped changes, run the most relevant Vitest files instead of the entire suite.
