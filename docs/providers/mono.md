# Mono

## Official docs

- [Mono pricing](https://mono.co/pricing)
- [Mono environments](https://docs.mono.co/docs/environments)
- [Mono sandbox guide](https://docs.mono.co/docs/sandbox)
- [Mono webhook introduction](https://docs.mono.co/docs/financial-data/webhook-introduction)
- [Mono definitions and dashboard keys](https://docs.mono.co/docs/definitions)
- [Mono PAYG pricing](https://support.mono.co/en/articles/11938612-pay-as-you-go-payg-pricing)
- [Mono Banka pricing](https://support.mono.co/en/articles/8899085-banka-pricing)

## Best hobbyist mode for real bank data

If you specifically need Mono's bank coverage, treat `sandbox` as the low-cost mode for development and evaluation.

For real self-hosted personal use, the honest answer is:

- Mono is available
- Mono is useful if you need its regional coverage
- Mono is not the cheapest consumer-style personal sync option in this repo

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- Mono sandbox is free
- Mono's public real-data pricing is region- and product-specific
- Mono's public site also shows a `Basic` subscription plan at `NGN 50,000/month` for up to `100` unique monthly accounts
- Mono also publishes a `Pay-As-You-Go` plan for Connect where you pay per API call instead of taking a subscription plan
- Mono also publishes monitored-account pricing for some products, and the clearest public monthly example is its Nigeria Banka pricing for advanced account monitoring:
  - Trial: free for 3 accounts
  - PAYG: `NGN 10,000` per account per month

### Flat-rate subscription example

Using the public `Basic` plan on Mono's main pricing page:

- `5` linked accounts: about `NGN 50,000/month`
- `10` linked accounts: about `NGN 50,000/month`

That plan is capped at `100` unique monthly accounts, so the monthly total does not change between `5` and `10` linked accounts.

### Per-account monthly pricing example

Using that public monitored-account example:

- `5` linked accounts: about `NGN 50,000/month`
- `10` linked accounts: about `NGN 100,000/month`

### Per-call PAYG pricing example

Mono's published PAYG call examples include:

- Authorization: `₦80`
- Account Details: `₦100`
- Data Sync: `₦100`
- Transactions: `₦150` per returned page

For this repo specifically, the current Mono sync path is closer to:

- `1` account-details call per sync, plus
- `1` or more transactions-page calls per sync

So a simple low-page-count estimate for this repo is:

- about `₦250` per synced account per run
  - `₦100` account details
  - `₦150` one returned transactions page

Approximate recurring PAYG cost for automatic sync, assuming `1` transactions page per run and a `30` day month:

- daily updates:
  - `1` account: about `₦7,500/month`
  - `5` accounts: about `₦37,500/month`
  - `10` accounts: about `₦75,000/month`
- hourly updates:
  - `1` account: about `₦180,000/month`
  - `5` accounts: about `₦900,000/month`
  - `10` accounts: about `₦1,800,000/month`

One-time connect/auth estimate:

- `1` account: about `₦80`
- `5` accounts: about `₦400`
- `10` accounts: about `₦800`

Important caveats:

- Mono's public website, PAYG help article, and Banka pricing article describe different product families or packaging layers, so you should not assume every public price applies to exactly the same feature set
- for a small but always-on deployment, the `Basic` flat subscription can be cheaper than per-account monthly pricing
- for very light or occasional usage, Mono's per-call PAYG pricing can be materially cheaper than a monthly monitored-account plan
- compared with the `Basic` flat plan, the simple PAYG estimate above crosses `NGN 50,000/month` at around:
  - `7` accounts on daily sync
  - well under `1` account on hourly sync
- for this repo's current adapter shape, hourly PAYG can become much more expensive than per-account monthly pricing very quickly
- the PAYG estimate above assumes only `1` returned transactions page per sync; multi-page transaction pulls increase cost further
- the repo does not currently model Mono pricing automatically, so these are planning estimates only
- public pricing is business-oriented and can change by country and product family

## Important gotchas

- Mono's public pricing and product packaging are region-specific and business-oriented, so it is a poor default choice for a generic low-cost hobbyist deployment.
- The rough monthly estimate in this doc is intentionally only a public example, not a universal Mono quote.
- Treat sandbox as the normal self-hosted evaluation path unless you already know Mono is the regional provider you need.

## Where to get credentials

In the Mono Dashboard:

1. open **Apps**
2. copy:
   - `Public key`
   - `Secret key`

For webhooks:

1. open your app's **Webhooks** section
2. add your webhook URL
3. copy the generated webhook secret

## Best hobbyist advice

- Use Mono only if you specifically need Mono's regional bank coverage.
- Use sandbox while integrating and validating the flow.
- If you expect a small number of always-on accounts, compare the `Basic` flat plan against both per-account and per-call pricing.
- If you only need occasional manual or infrequent pulls, compare Mono PAYG call pricing against the monthly monitored-account plans before assuming the monthly plan is your cheapest option.
- If you want daily or especially hourly automatic sync, budget against the per-call math for this repo's current adapter, not just the headline per-account monthly price.
- Budget carefully before using Mono for ongoing personal sync; public pricing is still much less hobbyist-friendly than Plaid Trial, Teller development, or SimpleFIN.

## Development and test mode

For this repo's repeatable development and live smoke tests, the right mode is `sandbox`.

Why:

- sandbox is free
- the repo already has a Mono sandbox live test path
- you can exercise connect, reauth, webhooks, refresh, and sync without real user credentials

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:mono
```

Typical sandbox output:

```dotenv
MONO_TEST_RUN_LIVE=1
MONO_TEST_ENV=sandbox
MONO_TEST_PUBLIC_KEY=mono_pub_...
MONO_TEST_SECRET_KEY=mono_sec_...
MONO_TEST_WEBHOOK_SECRET=
MONO_TEST_INSTITUTION_ID=
MONO_TEST_ACCOUNT_ID=
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Mono page in the UI.
