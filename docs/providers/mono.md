# Mono

## Best development/test mode

For this repo, the right Mono mode is **sandbox**.

Why:

- Mono’s current Financial Data setup uses `sandbox` and `production`
- sandbox calls are free according to the current Mono docs
- the Partners API exposes sandbox credentials, which makes repeatable smoke tests practical without driving the widget manually

Official docs:

- [Mono environments](https://docs.mono.co/docs/environments)
- [Mono sandbox guide](https://docs.mono.co/docs/sandbox)
- [Mono Partners API sandbox guide](https://docs.mono.co/docs/financial-data/partners-api-guide/sandbox-guide)
- [Mono exchange token API](https://docs.mono.co/api/bank-data/authorisation/exchange-token)
- [Mono transactions API](https://docs.mono.co/api/bank-data/transactions)
- [Mono webhook guide](https://docs.mono.co/docs/financial-data/webhook-introduction)

## Credential model in this repo

For the running app:

- Mono provider settings live in the UI
- the active environment is either `sandbox` or `production`
- each environment stores `publicKey`, `secretKey`, and `webhookSecret`

For repeatable local development and live tests:

- `.env` stores `MONO_TEST_*` values
- `npm run dev:live-sandbox` can seed the Mono provider settings from those `MONO_TEST_*` values
- `npm run test:mono-live` uses the Mono Partners API in sandbox mode to create a real test connection

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

Notes:

- `MONO_TEST_SECRET_KEY` is the only required value for the API-driven sandbox smoke test.
- `MONO_TEST_PUBLIC_KEY` is still useful for `npm run dev:live-sandbox` and widget testing in the web UI.
- `MONO_TEST_INSTITUTION_ID` is optional. If blank, the live test auto-discovers a compatible sandbox institution from `GET /v3/institutions?scope=financial_data`.

## Run the Mono live smoke test

```bash
npm run test:mono-live
```

What it does:

- creates a sandbox connect session through the current Partners API
- retrieves sandbox credentials from Mono
- logs in and exchanges the returned code through the adapter
- refreshes the resulting connection
- syncs one linked Mono account

The test is gated and skipped unless:

```dotenv
MONO_TEST_RUN_LIVE=1
MONO_TEST_SECRET_KEY=...
```

## Start it in the local live sandbox app

```bash
npm run dev:live-sandbox
```

Then open the Mono page in the UI.
