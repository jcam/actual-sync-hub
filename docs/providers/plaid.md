# Plaid

## Best hobbyist mode for real bank data

For actual bank polling, do not treat Sandbox as the answer.

Use one of:

- Plaid **Limited Production / Trial** if your account qualifies and that meets your needs
- full **Production** if you need broader real-bank coverage

This repo still represents real-data Plaid credentials as `PLAID_TEST_ENV=production`.

Official docs:

- [Plaid Quickstart](https://plaid.com/docs/quickstart/)
- [Plaid Sandbox overview](https://plaid.com/docs/sandbox/)
- [Plaid Sandbox test credentials](https://plaid.com/docs/sandbox/test-credentials/)
- [Plaid help: Sandbox vs Production vs Trial/Limited Production](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-and-Limited-Production-different)
- [Plaid pricing and billing](https://plaid.com/docs/account/billing/)

## Cost

As of May 8, 2026:

- Plaid's public docs do **not** publish a full production price list.
- Plaid does publish a free **Trial** plan for new US/Canada teams with up to **10 Production Items**.
- Plaid bills `Transactions` as a monthly subscription per **Item**, not per individual bank account.

Practical hobbyist reading:

- `5` linked bank logins / Items on Trial: `$0/month`
- `10` linked bank logins / Items on Trial: `$0/month`
- beyond that: paid pricing exists, but you have to view it in the Plaid Dashboard during Production access setup

Concrete contracted example:

- for one US Plaid account contract created on **October 29, 2025**, `Transactions` was priced at **`$0.30 per connected account / month`**
- using that specific contracted rate:
  - `5` connected accounts: about `$1.50/month`
  - `10` connected accounts: about `$3.00/month`

Important scope note:

- that `$0.30` figure is a user-observed contracted rate for a **US account** on that contract date, not a general public guarantee for all Plaid accounts or regions

Important caveat:

- Plaid bills by **Item**. One Item is usually one linked institution/login, which may contain more than one bank account.

## Where to get credentials

In the Plaid Dashboard:

- open the **API Keys** section
- copy:
  - `client_id`
  - the `secret` for your chosen environment

## Best hobbyist advice

- If you want real bank data, review Plaid's current **Limited Production / Trial** rules first.
- Use full Production only if you actually need it.

## Development and test mode

For this repo's development and automated testing, the right mode is **Sandbox**.

Why:

- Plaid Sandbox is free
- it supports mock/test Items
- this repo already has live sandbox coverage and helper flows for it
- it is the only sane mode for repeatable automated tests

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:plaid
```

That script will ask for:

- Plaid environment: `sandbox` or `production`
- `PLAID_TEST_CLIENT_ID`
- `PLAID_TEST_SECRET`

It writes:

```dotenv
PLAID_TEST_RUN_LIVE=1
PLAID_TEST_ENV=sandbox
PLAID_TEST_CLIENT_ID=...
PLAID_TEST_SECRET=...
```

## Manual `.env` example

```dotenv
PLAID_TEST_RUN_LIVE=1
PLAID_TEST_ENV=sandbox
PLAID_TEST_CLIENT_ID=your-plaid-client-id
PLAID_TEST_SECRET=your-plaid-sandbox-secret
```

## Useful Plaid sandbox test credentials

For the Plaid Link UI:

- basic login:
  - username: `user_good`
  - password: `pass_good`
- realistic transactions:
  - username: `user_transactions_dynamic`
  - password: any value
- common MFA code:
  - `1234`

## Start it for development

```bash
npm run dev:live-sandbox
```

Then go to the Plaid page in the UI and connect a sandbox institution.
