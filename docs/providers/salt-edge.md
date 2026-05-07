# Salt Edge

## Best hobbyist mode for real bank data

For a self-hosted or hobby setup that wants real bank data, the best mode is **Test**.

Why:

- Salt Edge docs say `Test` status can already use **live providers**
- `Test` is limited, but still allows up to **100 connections**
- Salt Edge's Terms say a `Test Account` is generally available for up to **90 days**

This makes `Test` the most realistic low-cost real-data mode for a personal or small self-hosted deployment.

## Best hobbyist advice

- Use **Test** if you want to connect real banks without jumping straight to full production review.
- Move to **Live** only when you need usage beyond the Test limits or a longer-term production setup.
- Use Salt Edge only if you specifically want its provider coverage or consent model.

## Development and test mode

For this repo's development and tests, the cheapest mode is **sandbox / fake providers while your client is still Pending**.

Why:

- Salt Edge docs say a newly registered client in `Pending` status can use fake providers
- the same docs say `Pending` clients can use up to **10 fake connections**
- this is the best place to start for development and integration testing

Official docs:

- [Salt Edge v6 overview](https://docs.saltedge.com/v6/)
- [Salt Edge API reference](https://docs.saltedge.com/v6/api_reference/)
- [Salt Edge account status / pending mode overview](https://docs.saltedge.com/general/v5/)

## Where to get credentials

In the Salt Edge dashboard:

1. open **Applications**
2. create or select an app
3. open the API keys / secrets page
4. copy:
   - `App ID`
   - `Secret`

## Generate development/test `.env`

Interactive:

```bash
npm run dev:env:init:saltedge
```

The script asks for:

- `SALT_EDGE_TEST_ENVIRONMENT`
- `SALT_EDGE_TEST_APP_ID`
- `SALT_EDGE_TEST_SECRET`
- optional:
  - `SALT_EDGE_TEST_CUSTOMER_ID`
  - `SALT_EDGE_TEST_CONNECTION_ID`
  - `SALT_EDGE_TEST_CONNECTION_SECRET`
  - `SALT_EDGE_TEST_ACCOUNT_ID`

It writes keys like:

```dotenv
SALT_EDGE_TEST_RUN_LIVE=1
SALT_EDGE_TEST_ENVIRONMENT=test
SALT_EDGE_TEST_APP_ID=your-app-id
SALT_EDGE_TEST_SECRET=your-secret
SALT_EDGE_TEST_CUSTOMER_ID=
SALT_EDGE_TEST_CONNECTION_ID=
SALT_EDGE_TEST_CONNECTION_SECRET=
SALT_EDGE_TEST_ACCOUNT_ID=
```

## What the optional IDs are for

- just `APP_ID` + `SECRET` is enough to create a connect session
- the extra IDs are only needed for deeper reconnect / sync live tests

## Suggested modes

- `sandbox`
  - use this for local development and fake-provider testing
- `test`
  - use this for real-bank hobby/self-hosted usage within Salt Edge's Test limits
- `production`
  - use this only when you are ready for the full live setup and review path

## Start it for development

```bash
npm run dev:live-sandbox
```

Then open the Salt Edge page in the UI.
