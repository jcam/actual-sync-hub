# Home Values

## Official docs or sources

There is no third-party developer dashboard or paid API plan behind this provider.

This repo currently supports public property pages from:

- Redfin
- Movoto
- Homes.com
- Trulia

## Best hobbyist mode for real data

Home Values is already the low-cost hobbyist mode.

Why:

- there is no paid aggregation subscription
- there are no bank credentials to manage
- it is useful for off-budget net-worth tracking when you only need periodic property valuations

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- external provider cost: `$0`

There is no third-party pay-as-you-go or flat provider subscription here.

Practical estimate:

- `5` tracked properties: about `$0/month`
- `10` tracked properties: about `$0/month`

Important caveat:

- this excludes your own hosting costs
- source sites can change their markup or block certain fetch methods, so operational reliability is not the same thing as API-backed bank aggregation

## Important gotchas

- Home Values is scrape- and page-structure-dependent, not API-contract-dependent.
- A source can break even when nothing in this repo changed, simply because the upstream site changed markup or anti-bot behavior.
- Frequent refreshes across many properties are more likely to trigger bot blocking or other rate-limiting behavior from source sites.
- Treat it as low-cost net-worth tracking, not as a bank-grade connectivity surface.

## Where to get credentials

No third-party credentials are required.

You configure Home Values entirely from this app's UI:

- property URLs
- chosen source
- fetch method per source in Provider Settings

## Best hobbyist advice

- Use Home Values when you want low-friction property tracking without paying for another provider.
- Prefer it for off-budget asset tracking, not for transaction ingestion.

## Development and test mode

Home Values does not need provider credentials for development or tests.

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:home-values
```

That command only helps initialize the base `.env`; there are no required Home Values provider secrets.

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Home Values page, add properties, and choose the source URLs you want to use.
