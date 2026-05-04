# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-04

### Added
- Initial monorepo scaffold with a Fastify server, React web app, shared TypeScript package, Prisma schema, and Docker support.
- Actual Budget integration via `@actual-app/api`, including live Docker-backed integration coverage.
- Plaid integration with sandbox helpers, optional live sandbox tests, and seeded sandbox tooling in the UI.
- Account-link scheduling, manual sync, sync review, migration review, and category mapping flows.
- Imported-transaction ledger, learned category mapping support, and provider-switch lifecycle handling.
- Vitest-based unit, integration, and live test coverage for the main Actual and Plaid sync paths.

### Changed
- Upgraded the test runner to Vitest 4.
- Upgraded `@actual-app/api` to `26.5.0` and aligned the worker/version-matching logic with the current package export layout.

## [Unreleased]

- No unreleased changes yet.
