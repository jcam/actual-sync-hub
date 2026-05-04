# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-04

### Added
- Initial monorepo scaffold with a Fastify server, React web app, shared TypeScript package, Prisma schema, and Docker support.
- Actual Budget integration via `@actual-app/api`, including live Docker-backed integration coverage.
- Plaid integration with sandbox helpers, optional live sandbox tests, and seeded sandbox tooling in the UI.
- Interactive `dev:live-sandbox` mode that boots a real Actual Docker instance on a fixed test port, seeds a budget, and enables Plaid Sandbox controls in the UI.
- Account-link scheduling, manual sync, sync review, migration review, and category mapping flows.
- Dedicated category-mapping and sync-review pages to keep account cards compact while still supporting explicit review and override workflows.
- Imported-transaction ledger, learned category mapping support, removed-transaction handling by `imported_id`, and provider-switch lifecycle handling.
- Provider replacement and migration support, including dry-run reconciliation previews backed by Actual's `importTransactions(..., { dryRun: true })`.
- Vitest-based unit, integration, coverage, and live end-to-end test coverage for the main Actual and Plaid sync paths.
- Repository hygiene files, including `.gitignore`, `.dockerignore`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.

### Changed
- Upgraded the test runner to Vitest 4.
- Upgraded `@actual-app/api` to `26.5.0` and aligned the worker/version-matching logic with the current package export layout.
- Moved Actual sync execution to a persistent worker session that keeps one authenticated budget loaded and uses incremental `sync()` instead of repeated full downloads.
- Updated Plaid sync defaults to request Personal Finance Categories v2 and a configurable transaction-history window.
- Modernized the main toolchain and SDKs, including Prisma 7, TypeScript 6, Vite 8, `@vitejs/plugin-react` 6, Plaid 42, `jsdom` 29, `zod` 4, and current Node typings.
- Added an `@hono/node-server` override to resolve a Prisma transitive audit finding; the only remaining audit exception is the upstream `@actual-app/api -> @actual-app/crdt -> uuid` chain.

## [Unreleased]

- No unreleased changes yet.
