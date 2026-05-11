# Belvo

## Current repo stance

This repo's Belvo integration currently uses the official Belvo Node SDK on the server and a manual link-import flow in the UI.

That means:

- create or manage the Belvo link through Belvo first
- paste the resulting `link.id` into the Belvo Connections page
- let `actual-sync-hub` use the SDK to refresh accounts and retrieve transactions

## Current Belvo versions checked for this repo

Verified on May 11, 2026:

- Belvo API docs version: `1.223.0`
- current npm package: `belvo@0.28.0`
- npm `latest` publish date for `belvo@0.28.0`: June 21, 2023

Important note:

- the official SDK exists, but it is older than the current API docs
- for this repo, we intentionally use the SDK only for the current core link, account, and transaction endpoints that still align with the live docs

Official docs:

- [Belvo API reference](https://developers.belvo.com/apis/belvoopenapispec)
- [Links](https://developers.belvo.com/reference/detaillink)
- [Retrieve accounts for a link](https://developers.belvo.com/apis/belvoopenapispec/accounts/retrieveaccounts)
- [Retrieve transactions for a link](https://developers.belvo.com/apis/belvoopenapispec/transactions/retrievetransactions)
- [Widget access token](https://developers.belvo.com/apis/belvoopenapispec/widget-access-token)
- [belvo-js GitHub repo](https://github.com/belvo-finance/belvo-js)
- [belvo npm package](https://www.npmjs.com/package/belvo)

## Environments

As of the current Belvo docs, the supported public API environments are:

- `sandbox`
- `production`

For this repo's provider settings page, use those exact values.

## Credentials you need

In Belvo, collect:

- your Belvo `secret ID`
- your Belvo `secret password`

Then store them in the app's Belvo provider settings page.

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:belvo
```

That script will ask for:

- Belvo environment: `sandbox` or `production`
- `BELVO_TEST_SECRET_ID`
- `BELVO_TEST_SECRET_PASSWORD`
- optional `BELVO_TEST_LINK_ID`

It writes:

```dotenv
BELVO_TEST_RUN_LIVE=1
BELVO_TEST_ENV=sandbox
BELVO_TEST_SECRET_ID=...
BELVO_TEST_SECRET_PASSWORD=...
BELVO_TEST_LINK_ID=
```

## Manual `.env` example

```dotenv
BELVO_TEST_RUN_LIVE=1
BELVO_TEST_ENV=sandbox
BELVO_TEST_SECRET_ID=your-belvo-secret-id
BELVO_TEST_SECRET_PASSWORD=your-belvo-secret-password
BELVO_TEST_LINK_ID=
BELVO_TEST_ACCOUNT_ID=
```

## Live sandbox test

This repo now has a gated Belvo live test:

```bash
npm run test:belvo-live
```

It only runs when all of these are set:

- `BELVO_TEST_RUN_LIVE=1`
- `BELVO_TEST_SECRET_ID`
- `BELVO_TEST_SECRET_PASSWORD`
- `BELVO_TEST_LINK_ID`

Optional:

- `BELVO_TEST_ACCOUNT_ID`

What it does:

1. imports the existing sandbox `link.id` through the Belvo adapter
2. refreshes the imported connection
3. creates an Actual account link against one Belvo account
4. runs `syncAccountLink`

Notes:

- Belvo's sandbox data resets on the first day of each month, so an old `BELVO_TEST_LINK_ID` can go stale.
- If you do not already have a sandbox `link.id`, create one in Belvo first, then reuse it here.

## Current app flow

1. Save Belvo credentials in the app settings.
2. Create or identify a Belvo `link.id`.
3. Open the Belvo Connections page in this app.
4. Import that `link.id`.
5. Map Belvo accounts to Actual accounts from the Accounts page.

## What is not implemented yet

- an in-app Belvo Hosted Widget flow
- OTP or MFA resume flows for Belvo `428 Token Required` sessions

If a Belvo link needs a challenge or repair, the current app surfaces that as a manual reconnect path.
