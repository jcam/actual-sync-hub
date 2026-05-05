# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-05-05

### Added
- Better provider category coverage across non-Plaid providers, including Teller-oriented category aliases and SimpleFIN `extra.category` import support when the upstream server provides it.

### Changed
- Cleaned up docs and frontend labels so they describe the current product directly instead of explaining the app's growth over time.
- Renamed and normalized lingering Plaid-shaped helper/test language that no longer matched the multi-provider implementation.
- Split shared DTOs by domain, split route and automatic-sync tests by area, and extracted more server subservices to reduce the size and coupling of the main orchestration files.
- Removed stale imports and dead constants surfaced by a strict unused-symbol pass.

## [0.8.0] - 2026-05-05

### Added
- Provider-aware batch sync support for scheduled and background work, with SimpleFIN connection-level batching as the first concrete implementation.
- Automatic sync backoff, provider concurrency limits, and stronger rate-limit-aware retry behavior.
- Teller webhook debouncing to collapse repeated `transactions.processed` bursts into a single background sync.
- Account-card visibility for paused automatic sync, including more specific messaging for rate-limit pauses.

### Changed
- Separated link-time identity/account refresh behavior from transaction-sync behavior more clearly inside the provider layer.
- Skipped automatic sync for links and connections already blocked on reauthentication or provider attention, while still retrying transient backend/pipeline failures.
- Reduced unnecessary Teller API traffic by removing eager full-connection refreshes ahead of webhook-triggered transaction sync runs.

## [0.7.0] - 2026-05-05

### Added
- Optional local provider fixture caching for Teller and SimpleFIN, backed by a flat file at `.local/provider-fixtures.json`.
- Reuse flows in the UI and API for cached Teller and SimpleFIN sandbox/dev credentials during manual live validation.
- Unified frontend startup and action-failure handling for remaining account, category-mapping, Plaid, Teller, and session-bootstrap flows.
- Expanded negative-path coverage for provider error classification, frontend action failures, and Actual-backend failure persistence.

### Changed
- Centralized more frontend error presentation around shared `ApiError` and display-formatting helpers.
- Kept automated tests fresh-by-default while making cached-provider reuse explicitly opt-in for manual workflows.

## [0.6.0] - 2026-05-05

### Added
- SimpleFIN as a first-class provider with its own top-level connections page.
- SimpleFIN setup-token connect flow, refresh/disconnect behavior, and date-window transaction sync.
- Actual bank-sync introspection to discover existing native `simpleFin` links from the loaded budget.
- Import flow for existing Actual SimpleFIN-linked accounts into app-managed account links.
- Unified persisted sync-health scopes, actions, badges, and reauthentication UX across account and connection surfaces.
- Provider-specific reconnect flows for Plaid update mode and Teller repair mode.

### Changed
- Separated provider-connection auth failures, bank-auth failures, Actual-backend failures, and generic sync-pipeline failures in persisted health state.

## [0.5.0] - 2026-05-05

### Added
- Teller as a first-class provider with its own top-level connections page.
- Teller Connect enrollment flow, sandbox seeding helper, reusable account hydration, and provider adapter integration.
- Teller transaction sync with configurable initial and overlap windows.
- Teller webhook support for `transactions.processed` and `enrollment.disconnected`.

### Changed
- Generalized provider orchestration so Plaid and Teller run through the same adapter boundary.

## [0.4.0] - 2026-05-04

### Added
- Manual sync review and migration review flows backed by Actual dry-run reconciliation previews.
- Dedicated sync-review and category-mapping pages to keep account cards compact.
- Imported-transaction ledger with learned category-mapping support and pruning.
- Provider replacement and migration lifecycle support for switching sync ownership safely.
- Removed-transaction handling by `imported_id`.

### Changed
- Moved category overrides and review-heavy flows out of crowded account cards into focused pages.
- Introduced a persistent Actual worker/session model with incremental `sync()` semantics instead of repeated full budget downloads.

## [0.3.0] - 2026-05-04

### Added
- Interactive `dev:live-sandbox` mode that boots a real Actual Docker instance on a fixed test port, seeds a budget, and enables sandbox-only provider tooling.
- Live Docker-backed Actual integration tests and full live Plaid -> app -> Actual end-to-end sync coverage.
- Plaid sandbox helpers in the UI for seeding connections and transactions.

### Changed
- Stabilized the live Actual integration around one authenticated budget session and worker isolation.

## [0.2.0] - 2026-05-04

### Added
- Actual Budget integration via `@actual-app/api`.
- Plaid integration with reusable provider connections, account linking, and optional live sandbox tests.
- Account-link scheduling, manual sync, and sync-run history.

### Changed
- Updated Plaid sync defaults to request Personal Finance Categories v2 and a configurable transaction-history window.
- Modernized the main toolchain and SDKs, including Vitest 4, Prisma 7, TypeScript 6, Vite 8, `@vitejs/plugin-react` 6, Plaid 42, `jsdom` 29, `zod` 4, and `@actual-app/api` 26.5.0.
- Added an `@hono/node-server` override to resolve a Prisma transitive audit finding; the only remaining audit exception is the upstream `@actual-app/api -> @actual-app/crdt -> uuid` chain.

## [0.1.0] - 2026-05-04

### Added
- Initial monorepo scaffold with a Fastify server, React web app, shared TypeScript package, Prisma schema, and Docker support.
- Local username/password auth, SQLite persistence, and basic protected web UI.
- Repository hygiene files, including `.gitignore`, `.dockerignore`, `LICENSE`, `CHANGELOG.md`, and `THIRD_PARTY_NOTICES.md`.

## [Unreleased]

- No unreleased changes yet.
