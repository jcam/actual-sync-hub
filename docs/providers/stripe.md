# Stripe

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted setup, the honest answer is:

- use **test mode / sandbox** for development
- use **live mode** only if you already have a real Stripe account and specifically want Financial Connections or ACH flows

Stripe Financial Connections is not the easiest "personal bank sync on a trial account" provider in this repo.

Why:

- Stripe test mode gives you a usable sandbox with simulated institutions
- Stripe says Financial Connections test data is always available
- live access to balances and other account data requires completed Financial Connections registration
- Stripe positions Financial Connections as a business product, not a hobbyist personal-finance feed

Official docs:

- [Stripe Financial Connections overview](https://docs.stripe.com/financial-connections)
- [Financial Connections fundamentals](https://docs.stripe.com/financial-connections/fundamentals)
- [Test Financial Connections](https://docs.stripe.com/financial-connections/testing)
- [Access balances](https://docs.stripe.com/financial-connections/balances)
- [Stripe Financial Connections pricing](https://stripe.com/financial-connections)

## Cost

As of May 8, 2026:

- instant bank account verification: `$1.50` per verified account
- balances: `10¢` per successful API call
- account owners / ownership: `$1.50` per successful API call
- transactions: `30¢` per institution per account holder per month

Practical hobbyist reading:

- test mode / sandbox: `$0`
- live Financial Connections for a handful of personal accounts: not free, and costs depend on which data products you enable

If you assume one linked bank account is at a different institution for the same account holder, then transactions cost about:

- `5` linked accounts: about `$1.50/month`
- `10` linked accounts: about `$3.00/month`

If you also enable instant verification for each newly linked account, that adds a one-time cost of:

- `5` linked accounts: about `$7.50` one time
- `10` linked accounts: about `$15.00` one time

Important caveats:

- Stripe prices transactions as a recurring account-data product, not a per-transaction ingest fee
- Stripe bills transactions per **institution per account holder per month**, not per individual transaction
- multiple accounts from the same institution for the same account holder can cost less than the simple 1-account = 1-institution estimate above
- ownership is the expensive data product and should not be enabled casually
- ACH payment pricing is separate from Financial Connections pricing

## Where to get credentials

In the Stripe Dashboard:

1. open **Developers > API keys**
2. copy the keys for the environment you want:
   - `Publishable key`
   - `Secret key`

For webhook testing:

1. open the relevant Stripe webhook endpoint configuration
2. copy the **signing secret**

In this repo, those values are entered in the app UI under **Provider Settings > Stripe**.

## Best hobbyist advice

- Use Stripe **test mode** if you are developing or evaluating the integration.
- Do not treat Stripe Financial Connections as the cheapest personal bank-sync option.
- Use Stripe live mode only if you already need Stripe for ACH or related payment flows.

If your goal is simply "self-hosted personal bank aggregation at the lowest cost":

- Plaid Trial, Teller development, SimpleFIN, or Home Values are usually easier fits

## Development and test mode

For this repo's development and repeatable testing, the right mode is **test**.

Why:

- Stripe provides simulated Financial Connections institutions in test mode
- accounts and customers created in test mode are isolated from live mode
- this avoids the live Financial Connections registration requirement

Important notes from Stripe docs:

- the Financial Connections client flow is subject to change, so Stripe does not recommend automating client-side UI tests too heavily
- test-mode Financial Connections API usage is rate limited

## Generate development/test `.env`

Use:

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

It writes keys like:

```dotenv
STRIPE_TEST_RUN_LIVE=1
STRIPE_TEST_ENV=test
STRIPE_TEST_PUBLISHABLE_KEY=pk_test_...
STRIPE_TEST_SECRET_KEY=sk_test_...
STRIPE_TEST_WEBHOOK_SIGNING_SECRETS=
STRIPE_TEST_CUSTOMER_ID=
STRIPE_TEST_ACCOUNT_ID=
```

These values are used by `npm run dev:live-sandbox` to seed **Provider Settings > Stripe** automatically.

The optional live-test values are only for deeper service tests:

- `STRIPE_TEST_CUSTOMER_ID` should be a Stripe customer id from a previously completed test-mode Financial Connections flow
- `STRIPE_TEST_ACCOUNT_ID` is only an optional selector when that customer has multiple linked accounts

## Start it for development

```bash
npm run dev:live-sandbox
```

Then:

1. open the Stripe Connections page
2. confirm the seeded Stripe settings look right
3. create a Financial Connections session
4. use Stripe's test institutions in the connect flow
