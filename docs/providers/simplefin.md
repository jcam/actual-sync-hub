# SimpleFIN

## Best hobbyist mode for real bank data

For a hobbyist, the simplest live mode is the hosted **SimpleFIN Bridge**.

Current pricing shown on the site:

- `$1.50` per month, or
- `$15.00` per year

Official docs:

- [SimpleFIN Bridge home](https://beta-bridge.simplefin.org/)
- [SimpleFIN Bridge developer guide](https://beta-bridge.simplefin.org/info/developers)
- [SimpleFIN protocol quickstart/spec](https://www.simplefin.org/protocol.html)

## Where to get access

There is no Plaid-style dashboard for a developer app key here.

Instead:

1. the user opens the Bridge
2. the user generates a **one-time setup token**
3. your app exchanges that token for a durable **access key**

In this repo:

- the UI keeps the **setup token** in the SimpleFIN connect box
- the live-test `.env` uses the resulting **access key**

## Best hobbyist advice

- Use the hosted Bridge for real personal data.
- Treat this repo's `sandbox` mode as development-only.

If you are pointing at a non-default SimpleFIN-compatible bridge:

- set **Provider Settings > SimpleFIN > Mode = development**
- fill in the alternate bridge server URL

## Development and test mode

For this repo's development and tests:

- the app can run in `sandbox` mode for demo/testing behavior
- live integration tests use a real claimed access key, not a fake sandbox token

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:simplefin
```

The script lets you choose:

- paste a **setup token** and let the script exchange it for you, or
- paste an existing **access key**

It writes keys like:

```dotenv
SIMPLEFIN_TEST_RUN_LIVE=1
SIMPLEFIN_TEST_ACCESS_KEY=https://username:password@bridge.example.com/simplefin
SIMPLEFIN_TEST_ACCOUNT_ID=
```

Notes:

- the script stores the **access key**, not the one-time setup token
- `SIMPLEFIN_TEST_ACCOUNT_ID` is optional and only helps pin tests to one account

## Manual token exchange

If you want to do it yourself, the official flow is:

1. base64-decode the setup token into a claim URL
2. `POST` to the claim URL
3. save the returned access URL / access key

The Bridge developer guide shows shell and Python examples for exactly this.

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the SimpleFIN page and use the setup token connect box in the UI.
