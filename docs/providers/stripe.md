# Stripe

## Official docs

- [Financial Connections overview](https://docs.stripe.com/financial-connections)
- [Financial Connections testing](https://docs.stripe.com/financial-connections/testing)
- [Financial Connections pricing](https://stripe.com/financial-connections)
- [Stripe API keys](https://docs.stripe.com/keys)
- [Stripe webhook endpoint secrets](https://docs.stripe.com/webhooks/configure)

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted setup, Stripe is best treated as:

- `test` mode for development and evaluation
- `live` mode only if you already have a real Stripe account and specifically want Financial Connections

Stripe Financial Connections is a business product first, not a low-friction personal bank-sync feed.

## Approximate cost for a hobbyist deployment

As of May 11, 2026, Stripe publicly lists:

- instant bank account verification: `$1.50` per verified account
- balances: `$0.10` per successful API call
- account owners: `$1.50` per successful API call
- transactions: `$0.30` per institution per account holder per month

Stripe Financial Connections pricing is already pay-as-you-go rather than a flat subscription.

Cheapest development/test estimate:

- `5` linked accounts in test mode: about `$0/month`
- `10` linked accounts in test mode: about `$0/month`

If you want live transaction feeds and assume each linked account is at a different institution for the same account holder:

- `5` linked accounts: about `$1.50/month`
- `10` linked accounts: about `$3.00/month`

If you also use instant verification on first connect:

- `5` linked accounts: about `$7.50` one time
- `10` linked accounts: about `$15.00` one time

Important caveats:

- Stripe bills transactions per institution per account holder per month, not per transaction
- if multiple linked accounts are under one institution for one account holder, the live total can be lower than the simple estimate above
- test mode is free but does not give real bank data
- for very light live usage, this pay-as-you-go model can be cheaper than a flat monthly provider subscription, especially if you only use one or two data products

## Important gotchas

- Stripe Financial Connections is a business product first, not a hobbyist-first personal sync plan.
- The free path is `test` mode only. Real bank data means using a live Stripe account and the live Financial Connections product surface.
- The simple monthly estimate here assumes one institution per linked account. Real pricing can be lower or higher depending on how account holders and institutions cluster, and on whether you use extra Financial Connections features such as instant verification.

## Where to get credentials

In the Stripe Dashboard:

1. open **Developers > API keys**
2. copy:
   - `Publishable key`
   - `Secret key`

For webhook verification:

1. open **Developers / Workbench > Webhooks**
2. select the endpoint you want to use
3. reveal and copy the endpoint's signing secret

## Best hobbyist advice

- Use Stripe only if you already want Stripe for adjacent payment or ACH workflows.
- Do not pick Stripe as the cheapest personal bank-sync option in this repo.
- For pure hobbyist self-hosting, Plaid Trial, Teller development, or SimpleFIN are usually simpler fits.

## Development and test mode

For this repo's repeatable development and tests, the right mode is `test`.

Why:

- Stripe provides simulated Financial Connections institutions in test mode
- test keys are free to use
- this repo can exercise session creation, relink flows, and webhook verification without live registration

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:stripe
```

The script asks for:

- `STRIPE_TEST_ENV`
- `STRIPE_TEST_PUBLISHABLE_KEY`
- `STRIPE_TEST_SECRET_KEY`
- optional `STRIPE_TEST_WEBHOOK_SIGNING_SECRETS`
- optional `STRIPE_TEST_CUSTOMER_ID`
- optional `STRIPE_TEST_ACCOUNT_ID`

Typical test output:

```dotenv
STRIPE_TEST_RUN_LIVE=1
STRIPE_TEST_ENV=test
STRIPE_TEST_PUBLISHABLE_KEY=pk_test_...
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_TEST_WEBHOOK_SIGNING_SECRETS=
STRIPE_TEST_CUSTOMER_ID=
STRIPE_TEST_ACCOUNT_ID=
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Stripe page in the UI and use Stripe's test institutions.
