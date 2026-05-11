# Belvo

## Official docs

- [Belvo plans and pricing](https://belvo.com/plans-and-pricing/)
- [Belvo API reference](https://developers.belvo.com/apis/belvoopenapispec)
- [Belvo widget access token](https://developers.belvo.com/apis/belvoopenapispec/widget-access-token)
- [Belvo Connect widget for web](https://developers.belvo.com/developer_resources/web-widget-for-web)
- [Belvo widget update mode](https://developers.belvo.com/developer_resources/web-connect-widget-update-mode)
- [Belvo asynchronous workflows](https://developers.belvo.com/developer_resources/resources-asynchronous-workflows)
- [Belvo aggregation webhooks](https://developers.belvo.com/developer_resources/resources-webhooks-aggregation)
- [Belvo links overview](https://developers.belvo.com/developer_resources/resources-links-overview)

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted deployment, the cheapest real-data Belvo path is its free `Test` plan if it is available for your use case.

Why:

- Belvo's public pricing page says the `Test` plan is free
- it includes sandbox access
- it also allows testing live data for up to `25` real data links

Important caveat:

- Belvo is still a business-oriented provider, not a hobbyist-first personal sync product
- after the free `Test` tier, Belvo's public entry plan jumps to `Launch` at `$1,000/month`

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- `Test`: free, including sandbox access and up to `25` real data links
- `Launch`: `$1,000/month`
- `Growth`: custom pricing

Practical hobbyist estimate on the cheapest public real-data path:

- `5` linked institutions / links: about `$0/month`
- `10` linked institutions / links: about `$0/month`

If you need to go past the free public tier:

- `5` linked institutions / links on `Launch`: about `$1,000/month`
- `10` linked institutions / links on `Launch`: about `$1,000/month`

Important caveats:

- Belvo's public pricing is much more flat-plan oriented than pay-as-you-go oriented for aggregation use
- there is no public low-cost incremental pay-as-you-go aggregation plan on the main pricing page comparable to Plaid or Stripe
- the free public `Test` tier can look attractive for hobbyist use, but the next public step up is a large jump

## Important gotchas

- Belvo's cleanest data flow is asynchronous and webhook-driven. Their docs recommend waiting for webhook notifications before retrieving newly available historical data.
- This repo currently does not implement Belvo webhook ingestion, so a newly connected link can require manual refreshes before accounts or transactions are visible here.
- Belvo recurrent links are not just a one-time connect. Their docs describe periodic provider-side refreshes and recommend informing users that their credentials will be used to keep data up to date.
- Production access is not just a key flip. Belvo's docs describe a production access request and certification process before full live use.
- This repo uses the hosted widget for both connect and reauth/update flows. That is the right path here, but it also means the Belvo integration is less self-contained than providers where all link lifecycle steps are already fully automated server-side.

## Where to get credentials

In the Belvo dashboard:

1. generate your API keys for the environment you want to use
2. copy:
   - `secretId`
   - `secretPassword`

Important note:

- Belvo's docs indicate the `secretPassword` is only shown once when generated, so store it securely
- if you lose the `secretPassword`, you should expect to rotate or reset the API keys

For production:

1. request production access
2. complete Belvo's certification process
3. switch your base URL and use your production keys

For webhooks:

1. open the data webhooks section in the Belvo dashboard
2. create the webhook endpoint there
3. optionally configure additional authentication for webhook delivery

## Best hobbyist advice

- Treat Belvo as region-coverage-driven, not price-driven.
- Use it if you specifically need Belvo's LATAM coverage or product surface.
- If you can stay inside the free `Test` tier, Belvo can be reasonable for a small self-hosted experiment.
- If you expect to need the paid tier, budget for Belvo as a business product rather than a casual hobbyist sync option.

## Development and test mode

For this repo's repeatable development and live smoke testing, the easiest mode is `sandbox`.

Why:

- sandbox keys are straightforward to generate
- this repo already has a Belvo live test path against sandbox credentials
- you can exercise the hosted widget flow and provider sync logic without immediately depending on paid production rollout

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:belvo
```

That script asks for:

- Belvo environment: `sandbox` or `production`
- `BELVO_TEST_SECRET_ID`
- `BELVO_TEST_SECRET_PASSWORD`
- optional `BELVO_TEST_LINK_ID`

Typical sandbox output:

```dotenv
BELVO_TEST_RUN_LIVE=1
BELVO_TEST_ENV=sandbox
BELVO_TEST_SECRET_ID=...
BELVO_TEST_SECRET_PASSWORD=...
BELVO_TEST_LINK_ID=
```

Important test note:

- the Belvo live test in this repo is built around reusing an existing sandbox `link.id`
- Belvo sandbox data can go stale, so an older saved `BELVO_TEST_LINK_ID` may need to be recreated

## Start it for development

```bash
npm run dev:live-sandbox
```

Then:

1. open the Belvo page in the UI
2. save your Belvo credentials in Provider Settings
3. launch the Belvo widget from Sync Hub
4. refresh the resulting link if Belvo is still asynchronously loading data
