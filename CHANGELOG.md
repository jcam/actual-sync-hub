# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- A first-pass Vehicle Values provider with dedicated connections/settings UI, manual Kelley Blue Book/Edmunds/CarMax/Hagerty valuation entry, and snapshot-delta sync into Actual as off-budget `OTHER_ASSET` accounts.
- URL-backed Kelley Blue Book and Hagerty vehicle-value adapters, including provider-level fetch-method controls and cached-estimate fallback for scheduled valuation syncs.

### Changed
- Generalized the valuation-provider account-link behavior so snapshot-only providers can force weekly/manual valuation scheduling and provider-specific default asset types instead of hard-coding that logic only for Home Values.

## [0.27.0] - 2026-05-11

### Changed
- Tightened static quality gates by adding a `knip`-backed unused-code check to `npm run lint`, reporting unused `oxlint` disable directives, removing dead server dependencies and exports, and documenting the intentional dynamic-loading exceptions for the Actual worker and Prisma client.
- Enabled `noUncheckedIndexedAccess` across the repo and fixed the resulting unchecked array/env lookups in the imported-transaction ledger, Plaid runtime/live-test setup, and AccountCard UI tests.
- Added explicit lint restrictions against chained type assertions and inline `JSON.parse(...) as ...` casts, and moved server/test JSON parsing onto explicit unknown/object/array boundary helpers so those rules are enforceable in practice.
- Added import-boundary lint rules that block deep internal workspace imports and prevent production `src` code from reaching into test helpers, while still allowing dedicated test, integration, dev, and script entrypoints.
- Centralized Fastify route parsing behind shared request-boundary helpers and added a lint rule that forbids direct `request.body` / `request.params` / `request.query` access in route files, so HTTP validation stays explicit at the boundary.
- Added targeted Vitest coverage thresholds for the best-covered server/core service groups, so future changes have to preserve baseline test depth in the sync and service logic without immediately forcing blanket coverage across every provider adapter and UI file.
- Added focused low-coverage tests for auth, account-link scheduling, provider settings, request-boundary helpers, and server error handling to raise baseline service and boundary coverage before tightening thresholds further.
- Added direct tests for provider fixture cache persistence/clearing behavior and app-context service wiring so those remaining low-coverage server helpers are covered before tightening thresholds further.
- Fixed `createAppContext(...)` so an explicitly provided scheduler override is preserved in the returned context instead of being dropped during service composition.
- Expanded Plaid, Stripe, and Teller adapter branch coverage across reauth, disconnect, sandbox, cache, and provider-error fallback paths, and raised the Vitest per-file coverage gates to enforce those stronger adapter and boundary baselines going forward.
- Expanded web-side provider coverage for reconnect flows, provider-settings validation/saves, and the Stripe/Teller browser loaders, so the remaining low-coverage provider UI paths are exercised before tightening the next round of server-side thresholds.
- Expanded server-side route, review-service, and adapter coverage across session/logout state, static serving, reviewed-sync failure/removal paths, and additional Stripe/Teller guard branches, then raised the matching per-file Vitest thresholds so those new baselines are enforced going forward.
- Fixed reviewed sync commits to treat deselected preview items as removals, so reconcile/delete cleanup and imported-transaction ledger pruning stay aligned with the user’s final review selection.

## [0.26.0] - 2026-05-11

### Added
- Direct `actual-service` worker-path coverage for preview imports, reconcile-side payee/date mutation handling, and child-process recovery after an `out-of-sync` Actual session failure.
- Snapshot-aware account link configuration, including asset type, write mode, and snapshot-history controls in the accounts UI.
- Combined `TRANSACTIONS_AND_SNAPSHOT_DELTA` sync support so investment-style accounts can import transaction history and then apply post-transaction valuation adjustments in the same sync and sync-review flow.

### Changed
- Reworked snapshot-capable providers to return absolute balance snapshots that Sync Hub converts into synthetic ledger adjustments for Actual net worth tracking.
- Taught Sync Hub to honor Actual's account-level `importTransactions` preference as an effective write-mode override, including disabling incompatible write-mode choices in the UI.

## [0.25.0] - 2026-05-11

### Removed
- Removed the Salt Edge provider integration, including its server adapter, UI flows, tests, live-test scripts, and provider setup docs, after confirming Salt Edge no longer supports the intended self-hosted hobbyist use case.

## [0.24.0] - 2026-05-11

### Added
- A configurable `HTTP_REQUEST_LOG_ENABLED` server flag so low-power deployments can disable Fastify request logging without code changes.
- Snapshot-backed sync review commits that apply exactly the previewed provider data, reject stale previews, and surface recoverable refresh errors in the review UI.
- Persisted `nextSyncAt` scheduling state for account links and persisted per-source Home Values fetch timestamps, so the scheduler and Home Values pacing logic can rely on indexed database fields instead of recomputing from full record scans.

### Changed
- Reduced account-management overhead by returning shared Actual account options/categories once per response and replacing full Actual account scans with targeted single-account external-link reconciliation.
- Removed repeated provider settings reads, repeated connection-metadata parsing, repeated Stripe metadata parsing, and repeated SimpleFIN link lookups across common server paths.
- Reworked the Actual worker import/reconcile flow to reuse transfer payee maps and import payload construction instead of rebuilding the same structures multiple times per command.
- Lowered peak sync-path pressure by bounding imported-transaction ledger write concurrency and removing avoidable quadratic lookups from sync application paths.
- Moved scheduled automatic syncs from a fixed one-minute global scan to one-shot next-due scheduling with a four-hour sanity fallback and explicit wakeups only where schedule state can actually change.
- Tightened the greenfield optimization paths to assume current persisted schema state rather than carrying forward compatibility workarounds for legacy `nextSyncAt` or Home Values fetch-timestamp backfills.

## [0.23.0] - 2026-05-11

### Added
- A Playwright UI regression harness with mocked API responses for login, navigation, accounts-dashboard rendering, Home Values create/edit flows, and a coarse Accounts-page timing smoke check, so browser-level regressions can be caught without live provider dependencies.
- A real browser-to-Fastify-to-SQLite Playwright settings flow that logs in through the actual server, persists provider settings, and verifies they survive a full page reload.

### Changed
- Cleaned up the remaining type-aware lint warnings and errors across Stripe reconnect UI, Stripe live-test coverage, Plaid webhook typing, and live-sandbox command parsing so `npm run lint` now passes cleanly again.
- Updated server test coverage to include Stripe and Home Values provider settings in automatic-sync fixtures and gave the Actual sync-account event assertion more headroom to reduce timing flake.
- Expanded the default test entrypoint so `npm test` now runs both the Vitest unit/integration suite and the Playwright UI suite, and fixed the web Vitest include pattern so `.test.ts` files run alongside `.test.tsx` files.

## [0.22.0] - 2026-05-11

### Added
- Plaid webhook signature verification using Plaid's verification-key flow, with raw-body hashing and route-level rejection of unverified webhook requests.
- Support for Actual's alternate public account-API external-sync surface, including status-aware external account reads and writeback without relying on Actual internals.
- Detached live-sandbox lifecycle scripts with log capture, explicit stop/remove helpers, and repo-local npm/Prisma cache defaults for more reliable local installs and test runs.

### Changed
- Switched Salt Edge connect and reconnect flows from embedded iframes to popup/new-window handling so redirect-auth and OAuth providers follow Salt Edge's recommended launch model.
- Cleaned up provider-page copy to remove stale iframe wording from Teller sandbox guidance and keep hosted-provider instructions specific to each provider.
- Reworked Actual external-sync orchestration so requested sync polling, manual syncs, scheduled syncs, and review-commit syncs all drive the same `pending` / success / failure lifecycle and update `last_sync` consistently.
- Reduced account-management sync overhead by returning shared account options/categories once per response and using targeted external-link reconciliation for single-account lookups instead of full Actual account scans.
- Removed the unused published `/status` and `/sync` bridge endpoints now that neither supported Actual external-sync surface depends on them.

## [0.21.0] - 2026-05-07

### Added
- Stripe webhook handling with signature verification, provider settings for per-environment webhook signing secrets, and route-level coverage for verified and rejected Stripe webhook requests.
- Stripe Financial Connections lifecycle handling for webhook-driven deactivation, reactivation, and disconnect events, including persisted connection health updates and automatic disabling of affected links.
- Webhook-driven incremental Stripe transaction sync that consumes successful `financial_connections.account.refreshed_transactions` events without issuing a second refresh call.

### Changed
- Refactored Stripe account-link sync internals so manual/scheduled syncs and webhook-triggered syncs share the same reconciliation path while allowing the webhook flow to skip redundant provider refresh calls.

## [0.20.0] - 2026-05-07

### Added
- Stripe Financial Connections as a first-class provider, including provider settings, dedicated managed-connections UI, reusable connection/account storage, balance refresh, and transaction sync into Actual.
- Stripe preview-SDK integration pinned to the current public-preview release, so Financial Connections preview fields like authorization and relink status are available through typed SDK calls instead of a custom HTTP client.
- Inline Stripe reauthentication support using Financial Connections relink sessions, including reconnect-button launch flow, relink finalize endpoint, and focused route/UI test coverage.

### Changed
- Switched the Stripe adapter from hand-built `fetch` requests to the official Stripe Node SDK, keeping provider health mapping and sync orchestration intact while removing custom transport code.
- Updated Stripe account replacement behavior to preserve existing local account rows when possible, so relink/refresh flows do not unnecessarily break attached Actual account links.

## [0.19.0] - 2026-05-07

### Added
- Salt Edge as a first-class provider, including connection/account hydration, manual refresh, transaction sync import, and dedicated managed-connections UI.
- Salt Edge Connect and reconnect session support, including browser-driven initial auth and inline reauthentication when consent expires or bank auth needs attention.
- Optional live Salt Edge adapter smoke tests plus a Salt Edge-to-Actual live integration test, using a pre-existing Salt Edge connection ID for headless finalize/refresh/sync validation.

### Changed
- Migrated Salt Edge integration onto the current AIS `v6` API and exposed Salt Edge environment selection as `sandbox`, `test`, or `production`, with save-time correction when the chosen mode is not supported by the client state.
- Removed provider-settings shape normalization for greenfield installs so persisted provider config now uses only the current schemas instead of reshaping legacy JSON.
- Pinned SimpleFIN account fetches to protocol `version=2` and dropped the deprecated string-array `errors` fallback in favor of structured `errlist` handling.

## [0.18.0] - 2026-05-07

### Added
- Automated Home Values estimate fetching from Redfin, Movoto, Homes.com, and Trulia, with per-site fetch-method controls for `curl`, `wget`, `node fetch`, or disabled mode.
- Multi-property Home Values management with a single create/edit panel, a saved-properties list, explicit edit/disconnect actions, and per-source warning/staleness visibility.
- Weekly Home Values refresh pacing that spreads properties across the week, avoids hitting the same source more than about once an hour, and keeps cached source values in scheduled averages when a provider is temporarily failing.
- Shared API validation issue formatting so field-specific backend validation messages can surface cleanly in the UI.

### Changed
- Replaced the original manual-estimate Home Values workflow with property-URL-driven fetching and removed Zillow as a configured Home Values source.
- Made Home Values saves more tolerant by allowing average-based properties to persist when at least one provider succeeds while blocked sources are retained as warnings.
- Hardened form validation and error messaging across Home Values, provider settings, SimpleFIN setup, and account-link saves so common input mistakes are caught before the request is sent.
- Updated the live sandbox image to install `ca-certificates` so curl-based Home Values fetches work inside the container.

## [0.17.0] - 2026-05-07

### Added
- A new Home Values provider that tracks manually entered Redfin and Zillow estimates and syncs them into Actual through synthetic valuation transactions for off-budget asset accounts.
- Dedicated Home Values connection management UI for creating, editing, recalculating, and disconnecting tracked properties.

### Changed
- Extended provider settings, runtime status, account-link UI, and connection DTOs so non-transaction providers like Home Values can participate cleanly in the sync hub.

## [0.14.0] - 2026-05-07

### Added
- Optional live Teller and SimpleFIN adapter smoke tests alongside the existing Plaid live validation flow.
- A provider-sync sanitization pass that drops malformed transactions, dedupes repeated imported IDs and search/category text, and prevents removed IDs from conflicting with still-imported rows.

### Changed
- Hardened Plaid, Teller, and SimpleFIN sync result handling so provider payload quirks do not leak directly into Actual reconciliation.

## [0.15.0] - 2026-05-07

### Changed
- Added detection for native Actual `external` unlink actions so previously written-back links are disabled locally and surfaced with `ACTUAL_UNLINKED` attention state instead of silently continuing to sync.
- Replaced the `ACTUAL_EXTERNAL_SYNC_WRITEBACK_ENABLED` env flag with runtime capability detection against the installed `@actual-app/api` package.
- Reworked Actual transaction lookup and reconciliation to rely on public date-range reads plus minimal imported-transaction metadata instead of imported-id AQL queries.
- Simplified external-sync writeback so `lastSync` is carried through `linkExternalSyncAccount(...)`, removing the redundant completion callback path from the sync bridge.

## [0.16.0] - 2026-05-07

### Changed
- Taught bridge-managed sync to honor Actual account-level bank-sync prefs for pending transactions, transaction notes, deleted-transaction reimports, balance-only import mode, and date updates.
- Narrowed the remaining bridge/Actual sync-pref gap to custom field mappings instead of the simpler account-level import flags.

## [0.13.0] - 2026-05-06

### Added
- Type-aware `oxlint` plus `oxfmt` as first-class repo linting and formatting tools.
- Local `actual-sync` lint rules for dependency hygiene, React default-import avoidance, and architectural boundary enforcement.

### Changed
- Upgraded root lint scripts so `npm run lint` now performs a real code-quality pass before workspace typechecks.
- Brought the repo into compliance with stricter type, promise, import, and boundary rules modeled after the main Actual repo.
- Rewrote `AGENTS.md` so its build, test, and workflow guidance matches this repo instead of the main Actual monorepo.

## [0.12.0] - 2026-05-06

### Added
- Explicit SimpleFIN provider-subconnection and institution metadata in the app model, including institution-grouped managed-connection UI.
- Live SimpleFIN account-management links from the managed-connections view back to the provider's own `/my-account` page.
- Provider-common notes normalization that intelligently carries bank description and memo text into Actual notes without duplicating the chosen payee.

### Changed
- Saved valid SimpleFIN credentials even when upstream institutions report attention/auth problems, returning warnings instead of rejecting the whole connect flow.
- Fixed sync-review preview so it no longer advances provider sync state ahead of commit.
- Improved live SimpleFIN, Teller, and Plaid transaction handling by:
  - using Plaid `original_description`
  - mapping Teller and SimpleFIN notes through the shared normalization helper
  - grouping SimpleFIN connection health by institution instead of a single undifferentiated warning block
- Reduced the local imported-transaction store to the minimum metadata needed for sync/category learning instead of keeping a duplicate transaction ledger.

## [0.11.0] - 2026-05-06

### Added
- Provider settings as a persisted in-app configuration surface, with dedicated settings panels and readiness panels on the Plaid, Teller.io, and SimpleFIN pages.
- Mode-specific provider settings for Plaid, Teller, and SimpleFIN, including sandbox/development/production selection where applicable.
- Containerized `dev:live-sandbox` support via `Dockerfile.dev`, with scripted startup of Actual, the dev app container, and sandbox seeding.

### Changed
- Moved provider credentials and provider tuning out of runtime `.env` fallbacks and into the app-managed provider settings model.
- Updated the live sandbox launcher and live integration harnesses to inject provider settings through the API instead of configuring the app process directly through env vars.
- Shifted provider setup defaults and docs so `.env` is now primarily for app/runtime wiring, while provider behavior and credentials are managed through the web UI.

## [0.10.0] - 2026-05-05

### Added
- Optional native Actual external-sync metadata writeback when the installed `@actual-app/api` runtime exposes the external-sync account APIs.
- External-sync bridge endpoints that expose app-managed status and manual sync execution for Actual to call through the checked-out `external-sync` branch.
- Unified provider readiness surfacing across Plaid, Teller.io, and SimpleFIN, including shared readiness DTOs and frontend status panels.
- Explicit provider disconnect actions for Plaid and Teller alongside the existing SimpleFIN disconnect flow.

### Changed
- Updated provider disconnect handling so connections are retired consistently, active links are disabled, and reconnect-required health is persisted without conflating provider teardown with sync failure.
- Wired external-sync writeback into account-link save, provider refresh, sync completion, and imported SimpleFIN-link activation flows so native Actual metadata stays aligned when the feature gate is enabled.
- Documented the external-sync writeback gate and its runtime requirements in the environment template and README.

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
