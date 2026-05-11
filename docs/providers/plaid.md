# Plaid

## Official docs

- [Plaid Quickstart](https://plaid.com/docs/quickstart/)
- [Plaid pricing and billing](https://plaid.com/docs/account/billing/)
- [Plaid Trial plan](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)
- [Plaid OAuth guide](https://plaid.com/docs/link/oauth/)
- [Plaid Sandbox overview](https://plaid.com/docs/sandbox/)

## Best hobbyist mode for real bank data

For a hobbyist or self-hosted Actual deployment, the best Plaid mode is the free Trial plan if you qualify.

Why:

- Plaid Trial uses real production data
- it includes Transactions
- it is specifically described by Plaid as appropriate for hobbyist use
- it avoids guessing at pay-as-you-go pricing before you actually need more than 10 Items

Important caveat:

- Plaid Trial is currently limited to new US/Canada teams created on or after April 15, 2026
- Plaid OAuth support is still required for institutions that use OAuth

## Approximate cost for a hobbyist deployment

As of May 11, 2026:

- Plaid Trial is free and limited to 10 Production Items
- Plaid also offers a paid `Pay as you go` plan with no minimum spend or commitment
- Plaid does not publish a full public price list for paid production plans in the docs; you see paid pricing in the Dashboard when applying for Production access

Practical hobbyist estimate on Trial:

- `5` linked institutions / Items: about `$0/month`
- `10` linked institutions / Items: about `$0/month`

Important caveat:

- Plaid bills many products, including Transactions, per Item rather than per individual account
- one Item is usually one institution login, which can contain multiple accounts
- if you outgrow Trial, Plaid `Pay as you go` is likely the cheapest paid Plaid path for a hobbyist deployment, but the exact rates are only shown in the Production access flow

## Important gotchas

- Plaid Trial is not a forever-free general plan. It is an eligibility-limited offering and the current public criteria are narrower than "any hobbyist can sign up".
- The free Trial cap is `10` Production Items total, so a small self-hosted deployment can outgrow it quickly if you connect many institutions.
- Plaid OAuth institutions still need Link/OAuth setup done correctly; "Plaid handles OAuth" does not mean you can ignore Plaid's redirect and institution requirements.

## Where to get credentials

In the Plaid Dashboard:

1. sign up or log in
2. open **API Keys**
3. copy:
   - `client_id`
   - the `secret` for the environment you want to use

If you are using real data:

1. review the Trial or paid Production flow in the Dashboard
2. if you will connect OAuth institutions, make sure your Plaid Link redirect/OAuth setup is complete

## Best hobbyist advice

- Start with Plaid Trial if you qualify and only need up to 10 real institution logins.
- If you outgrow Trial, check Plaid `Pay as you go` before considering higher-commitment plans.
- Keep in mind that Plaid is better priced by institution/login count than by raw account count.

## Development and test mode

For this repo's repeatable development and automated testing, the right mode is Sandbox.

Why:

- Sandbox is free
- this repo already has sandbox seed flows and live sandbox coverage
- it is the safest way to exercise Plaid webhooks, Link, and transaction sync repeatedly

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:plaid
```

The script asks for:

- Plaid environment: `sandbox` or `production`
- `PLAID_TEST_CLIENT_ID`
- `PLAID_TEST_SECRET`

Typical sandbox output:

```dotenv
PLAID_TEST_RUN_LIVE=1
PLAID_TEST_ENV=sandbox
PLAID_TEST_CLIENT_ID=...
PLAID_TEST_SECRET=...
```

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Plaid page in the UI and connect a sandbox institution.
