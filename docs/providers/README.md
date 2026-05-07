# Provider Setup Docs

These notes are for this repo, not for the providers' own sample apps.

The goal here is not just to poke at sandboxes. The goal is to run `actual-sync-hub` as a self-hosted sync companion next to Actual Budget, then use these docs to choose the right provider, credential flow, and low-cost path for that setup.

Use these docs when you want to:

- decide which provider is the best fit for a self-hosted Actual setup
- separate real-data guidance from development-only sandbox modes
- learn which dashboard page to visit for credentials
- generate the right `.env` keys for this repo's development, live-sandbox, and live test flows

## Quick commands

Interactive development/test env setup:

```bash
npm run dev:env:init
```

Provider-specific shortcuts:

```bash
npm run dev:env:init:plaid
npm run dev:env:init:teller
npm run dev:env:init:simplefin
npm run dev:env:init:saltedge
npm run dev:env:init:home-values
```

What the script does:

- creates `.env` from `.env.example` if `.env` does not exist yet
- prompts only for the keys that matter for the chosen provider
- updates just that provider's `*_TEST_*` vars in `.env`
- for SimpleFIN, it can exchange a one-time setup token into a durable access key for you

Important scope note:

- these `.env` values are for this repo's development workflows:
  - live tests
  - `npm run dev:live-sandbox`
  - repeatable local integration work
- normal provider settings for the running app still live in the UI

For a real self-hosted deployment, expect this split:

- `.env` for core app/runtime wiring
- provider credentials and provider behavior in the UI
- provider docs used mainly to get the initial credentials and understand which mode you actually want

## Providers

- [Plaid](./plaid.md)
- [Teller](./teller.md)
- [SimpleFIN](./simplefin.md)
- [Salt Edge](./salt-edge.md)
- [Home Values](./home-values.md)
