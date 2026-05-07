# Home Values

## Best low-cost mode

This provider is the cheapest one in the repo because it does **not** need a paid aggregation account.

It works by:

- taking property URLs from supported public sites
- fetching the current estimate
- writing a synthetic valuation transaction into Actual

There is no separate provider dashboard to sign into.

## Current source model

This repo currently supports these Home Values sources:

- `Redfin`
- `Movoto`
- `Homes.com`
- `Trulia`

Fetch methods are configured per site in the app settings:

- `curl`
- `wget`
- `node fetch`
- `disabled`

Current defaults in this repo:

- Redfin: `curl`
- Movoto: `curl`
- Homes.com: `wget`
- Trulia: `wget`

## Best hobbyist advice

Use Home Values when you want:

- simple net-worth tracking
- no paid bank-aggregation subscription
- no extra provider account setup

## Development and test mode

Home Values does not need provider credentials for development.

## Generate development/test `.env`

There are no provider-specific `.env` keys required for Home Values.

You can still run:

```bash
npm run dev:env:init:home-values
```

That command simply ensures your base `.env` exists and reminds you that Home Values is configured from the UI.

## Start it for development

```bash
npm run dev:live-sandbox
```

Then:

1. open the Home Values page
2. add one or more properties
3. choose the source
4. paste the property URLs
5. adjust per-site fetch methods in Provider Settings if a site blocks one client but allows another
