# Vehicle Values

## Official docs or sources

There is no third-party developer dashboard or paid API plan behind this provider.

This repo currently supports public valuation pages from:

- Kelley Blue Book
- Hagerty

It also supports fully manual values for:

- Edmunds
- CarMax

## Best hobbyist mode for real data

Vehicle Values is already the low-cost hobbyist mode.

Why:

- there is no paid aggregation subscription
- there are no bank credentials to manage
- it is useful for off-budget net-worth tracking when you only need valuation snapshots

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- external provider cost: `$0`

There is no third-party pay-as-you-go or flat provider subscription here.

Practical estimate:

- `5` tracked vehicles: about `$0/month`
- `10` tracked vehicles: about `$0/month`

Important caveat:

- this excludes your own hosting costs
- KBB and Hagerty page markup can change, which can break URL-backed fetching until the adapter is updated

## Important gotchas

- Vehicle Values is source-page dependent for URL-backed refreshes and therefore can break when an upstream site changes.
- Frequent refreshes across many vehicles are more likely to trigger bot blocking or other rate-limiting behavior from source sites.
- Manual values are the most stable option; URL-backed KBB or Hagerty refreshes trade stability for convenience.
- Treat it as asset valuation tracking, not as a bank-style always-on integration.

## Where to get credentials

No third-party credentials are required.

You configure Vehicle Values entirely from this app's UI:

- vehicle metadata
- manual values or supported source URLs
- fetch method settings for KBB and Hagerty in Provider Settings

## Best hobbyist advice

- Use Vehicle Values for off-budget net-worth tracking, not for bank-style transaction sync.
- Prefer manual values unless you specifically want URL-backed KBB or Hagerty refreshes.

## Development and test mode

Vehicle Values does not need provider credentials for development or tests.

## Generate development/test `.env`

There is currently no provider-specific `npm run dev:env:init:vehicle-values` helper because no provider secrets are required.

If you only need the base app `.env`, use:

```bash
npm run dev:env:init
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Vehicle Values page and add manual or URL-backed valuations.
